import { createHash } from 'node:crypto'
import type { Divergence, Provider, RenderedPrefix, RequestBody, SegmentName } from './prefix.ts'
import { continues, conversationKey, firstDivergence, render, toolSerialisationChanged } from './prefix.ts'
import { rebuildCost, uncachedCost } from '../pricing.ts'
import type { ObservedUsage } from './usage.ts'
import type { Exchange, Live } from '../dashboard/contract.ts'

export interface LiveFinding {
  id: string
  title: string
  detail: string
  fix: string
  /** Estimated from bytes, and from the provider's token counts once the
   *  response arrives. Null for a model with no known price, and for findings
   *  that lose no cached tokens: a prefix below the minimum is never written,
   *  and a breakpoint over the limit costs nothing Thermal can measure. */
  wastedUSD: number | null
  at: Date
  /** The exchange that triggered it, so the live view can show its prefix. */
  exchange: number
}

interface Seen {
  body: RequestBody
  prefix: RenderedPrefix
}

/** A tools-and-system head sent with no breakpoint. Its finding's cost grows
 *  with every repeat that a 5m cache entry would still have served. */
interface Head {
  sightings: number
  lastAt: number
  warmRepeats: number
  chars: number
  tokens: number
  model: string
  finding?: LiveFinding
}

/** Findings that report a broken Anthropic prefix. A tool change breaks it in
 *  the tools segment, and its own finding carries the cost there. */
const BREAKS = new Set(['prefix-invalidated', 'tool-set-changed', 'nondeterministic-tool-json'])

const TTL_5M_MS = 5 * 60 * 1000

/** Where the changing part belongs, per segment. The destination has to be
 *  named: "move it out of the system prompt" alone sent people to the start of
 *  the messages, which breaks a cached history just the same. */
const DIVERGENCE_FIX: Record<SegmentName, string> = {
  tools:
    'A tool definition changes between requests. Keep the tool list and every schema byte-identical for the whole conversation.',
  system:
    'Something in the system prompt changes per request, usually a timestamp. Keep the system prompt identical and send the changing part at the end of the request, in the latest user message, after the last cache breakpoint.',
  messages:
    'An earlier message changed between requests. Keep the history append-only and send anything that varies per call in the latest user message, after the last cache breakpoint.',
}

/** Prompt bytes as they are, except the whitespace that would break the
 *  report's layout. Escaping every quote made JSON unreadable. */
function visible(text: string): string {
  return text.replaceAll('\n', '\\n').replaceAll('\t', '\\t').replaceAll('\r', '\\r')
}

/** Enough history to scroll back through a working session; the live view
 *  polls the whole list, so it must stay small. */
const KEPT_EXCHANGES = 200

/** How far back to look for the conversation a request continues when its
 *  first message is new. Agents interleave a handful of conversations at most. */
const RECENT_CANDIDATES = 20

/** Anthropic will not cache a prefix shorter than this; the exact floor is
 *  model-dependent (512-4096 tokens) so we use the smallest, and only warn when
 *  a request is below it AND has asked for caching. Characters stand in for
 *  tokens at roughly four to one. */
const SMALLEST_CACHEABLE_TOKENS = 512
const CHARS_PER_TOKEN = 4
const MAX_BREAKPOINTS = 4

/** OpenAI caches only prompts of 1024 tokens or more, in 128-token steps, so a
 *  miss below this is expected rather than a symptom. */
const OPENAI_SMALLEST_CACHEABLE_TOKENS = 1024
const MISSES_BEFORE_REPORTING = 3

/** The stable head of a request - tools and system - is the natural cache
 *  prefix. Keying on it finds prompts reused across separate conversations,
 *  which conversation-level grouping cannot see. */
function headKey(prefix: RenderedPrefix): string {
  const head = prefix.segments
    .filter((segment) => segment.name !== 'messages')
    .map((segment) => segment.text)
    .join('')
  return createHash('sha256').update(head).digest('hex').slice(0, 16)
}

function headLength(prefix: RenderedPrefix): number {
  return prefix.segments
    .filter((segment) => segment.name !== 'messages')
    .reduce((total, segment) => total + segment.text.length, 0)
}

export class Capture {
  readonly findings: LiveFinding[] = []
  #previous = new Map<string, Seen>()
  #recent: Seen[] = []
  #heads = new Map<string, Head>()
  #headOf = new WeakMap<Exchange, Head>()
  #openAiMissStreak = 0
  #openAiSawLargePrompt = false
  /** Tokens the last OpenAI hit served from cache: the evidence of how much a
   *  miss after it could have read. */
  #openAiLastCached = 0
  #openAiStreakLost = 0
  #openAiStreakFinding: LiveFinding | undefined
  #requests = 0
  #exchanges: Exchange[] = []
  /** Totals across every provider, so the summary can distinguish "measured and
   *  healthy" from "measured nothing" - silence meant both until this existed. */
  readonly totals = { withUsage: 0, promptTokens: 0, cachedTokens: 0 }

  get requestCount(): number {
    return this.#requests
  }

  /** Runs after the response has already been sent. Nothing here may block a
   *  request; the proxy's whole value depends on being invisible. */
  observe(body: RequestBody, provider: Provider = 'anthropic'): Exchange {
    this.#requests++
    const prefix = render(body, provider)
    const exchange: Exchange = {
      n: this.#requests,
      at: new Date().toISOString(),
      provider,
      model: typeof body.model === 'string' ? body.model : 'unknown',
      segments: prefix.segments.map((segment) => ({ name: segment.name, chars: segment.text.length })),
      cacheEndsAt: prefix.cacheEndsAt ?? null,
      promptTokens: null,
      cachedTokens: null,
      divergence: null,
      findings: [],
    }
    this.#exchanges.push(exchange)
    if (this.#exchanges.length > KEPT_EXCHANGES) this.#exchanges.shift()

    const key = conversationKey(body)
    const previous = this.#previous.get(key) ?? this.#recent.findLast((seen) => continues(seen.body, body))
    const seen = { body, prefix }
    this.#previous.set(key, seen)
    this.#recent.push(seen)
    if (this.#recent.length > RECENT_CANDIDATES) this.#recent.shift()

    if (provider === 'anthropic' && prefix.breakpoints > MAX_BREAKPOINTS) {
      this.#record(exchange, {
        id: 'too-many-breakpoints',
        title: `${prefix.breakpoints} cache breakpoints, limit is ${MAX_BREAKPOINTS}`,
        detail: 'Breakpoints past the fourth are rejected, so some of this request is not being cached at all.',
        fix: `Consolidate to the ${MAX_BREAKPOINTS} boundaries with the most stable content before them.`,
      })
    }

    if (provider === 'anthropic' && prefix.breakpoints > 0 && prefix.text.length < SMALLEST_CACHEABLE_TOKENS * CHARS_PER_TOKEN) {
      this.#record(exchange, {
        id: 'prefix-below-minimum',
        title: 'Prefix is too short to be cached',
        detail: `The prefix is roughly ${Math.round(prefix.text.length / CHARS_PER_TOKEN)} tokens, under the ${SMALLEST_CACHEABLE_TOKENS} minimum. Caching silently does nothing here and no error is raised.`,
        fix: 'Move more stable content ahead of the breakpoint, or stop marking this request for caching.',
      })
    }

    if (provider === 'anthropic') this.#checkUncachedRepeat(body, prefix, exchange)

    if (!previous) return exchange

    // OpenAI reports cached_tokens directly, which is ground truth and beats
    // anything inferred from diffing text. Only Anthropic needs the diff.
    const divergence = provider === 'anthropic' ? firstDivergence(previous.prefix, prefix) : undefined
    if (divergence) exchange.divergence = divergence
    // Without a cached prefix to lose, a tool change costs nothing measurable.
    const toolBreakCost = divergence ? this.#breakCost(divergence, prefix, exchange) : null
    let toolChangeReported = false

    if (toolSerialisationChanged(previous.body, body)) {
      toolChangeReported = true
      this.#record(exchange, {
        id: 'nondeterministic-tool-json',
        title: 'Identical tools serialised into different bytes',
        detail: 'The tool definitions mean the same thing but their JSON key order changed between requests. Tools render first, so this invalidates the entire prefix.',
        fix: 'Sort object keys before serialising your tool definitions.',
        wastedUSD: toolBreakCost,
      })
    }

    const previousNames = previous.prefix.toolNames.join(',')
    if (previousNames !== prefix.toolNames.join(',')) {
      toolChangeReported = true
      this.#record(exchange, {
        id: 'tool-set-changed',
        title: 'Tool list changed mid-conversation',
        detail: `Tools went from [${previousNames}] to [${prefix.toolNames.join(',')}]. Tools render before everything else, so the whole prefix is recomputed.`,
        fix: 'Keep the tool list fixed for the life of a conversation, in a stable order.',
        wastedUSD: toolBreakCost,
      })
    }

    // The tool finding already names this break and carries its cost; a second
    // finding for the same bytes would count the money twice.
    if (divergence && !(toolChangeReported && divergence.segment === 'tools')) {
      this.#recordDivergence(divergence, prefix, exchange)
    }
    return exchange
  }

  /** OpenAI caches automatically, so there is no breakpoint to get wrong - the
   *  only failure mode is a prefix that never repeats identically. When a large
   *  prompt keeps missing the cache, the prefix is moving. */
  observeUsage(usage: ObservedUsage, provider: Provider, exchange: Exchange): void {
    exchange.promptTokens = usage.promptTokens
    exchange.cachedTokens = usage.cachedTokens
    this.#repriceBreak(exchange, usage)
    this.#repriceUncached(exchange)
    if (usage.promptTokens > 0) {
      this.totals.withUsage++
      this.totals.promptTokens += usage.promptTokens
      this.totals.cachedTokens += usage.cachedTokens
    }

    if (provider !== 'openai' || usage.promptTokens < OPENAI_SMALLEST_CACHEABLE_TOKENS) return

    // The first large prompt finds an empty cache by design, and a hit proves
    // the prefix is holding. Only an unbroken run of later misses is evidence;
    // counting misses across hits flagged healthy traffic on live OpenAI.
    const first = !this.#openAiSawLargePrompt
    this.#openAiSawLargePrompt = true
    if (usage.cachedTokens > 0) {
      this.#openAiMissStreak = 0
      this.#openAiLastCached = usage.cachedTokens
      this.#openAiStreakLost = 0
      this.#openAiStreakFinding = undefined
      return
    }
    if (first) return
    this.#openAiMissStreak++
    this.#openAiStreakLost += Math.min(this.#openAiLastCached, usage.promptTokens)

    // Priced from what the last hit actually read, not from the prompt size: a
    // prompt that never hit gives no evidence of how much of it could cache.
    const cost = () =>
      this.#openAiLastCached > 0 ? (rebuildCost(this.#openAiStreakLost, exchange.model) ?? null) : null
    if (this.#openAiStreakFinding) {
      this.#openAiStreakFinding.wastedUSD = cost()
      return
    }
    if (this.#openAiMissStreak !== MISSES_BEFORE_REPORTING) return

    this.#openAiStreakFinding = this.#record(exchange, {
      id: 'automatic-cache-not-landing',
      title: `${MISSES_BEFORE_REPORTING} large prompts in a row cached nothing`,
      detail:
        `Prompts of ${usage.promptTokens} tokens are reporting cached_tokens: 0. ` +
        'OpenAI caches long prefixes automatically, so repeated misses mean the start of the prompt is changing between calls.',
      fix: 'Move anything variable - timestamps, ids, retrieved context, the user question - to the END of the prompt, and keep the opening bytes identical.',
      wastedUSD: cost(),
    })
  }

  /** A large stable prompt resent with no breakpoint at all. This is not a
   *  broken cache - it is a cache nobody asked for, and it is invisible because
   *  nothing fails. Reported once per distinct prompt, on the first repeat a 5m
   *  cache would have served; later repeats add to that finding's cost. */
  #checkUncachedRepeat(body: RequestBody, prefix: RenderedPrefix, exchange: Exchange): void {
    if (prefix.breakpoints > 0) return

    const key = headKey(prefix)
    const now = Date.now()
    const chars = headLength(prefix)
    let head = this.#heads.get(key)
    if (!head) {
      head = {
        sightings: 0,
        lastAt: now,
        warmRepeats: 0,
        chars,
        tokens: Math.round(chars / CHARS_PER_TOKEN),
        model: typeof body.model === 'string' ? body.model : 'unknown',
      }
      this.#heads.set(key, head)
    } else if (now - head.lastAt <= TTL_5M_MS) {
      head.warmRepeats++
    }
    head.sightings++
    head.lastAt = now
    this.#headOf.set(exchange, head)

    if (head.finding) {
      head.finding.wastedUSD = this.#uncachedCost(head)
      return
    }
    if (head.warmRepeats === 0 || head.tokens < SMALLEST_CACHEABLE_TOKENS) return

    head.finding = this.#record(exchange, {
      id: 'cacheable-prefix-uncached',
      title: `A ~${head.tokens} token prompt is being resent uncached`,
      detail:
        `The same tools and system prompt have now been sent ${head.sightings} times with no cache_control anywhere. ` +
        'Every repeat pays full input price for bytes the server would otherwise hold.',
      fix: 'Put a cache_control breakpoint at the end of the system prompt. The first call pays a small write premium and every call after it reads at a fraction of input price.',
      wastedUSD: this.#uncachedCost(head),
    })
  }

  #uncachedCost(head: Head): number | null {
    return uncachedCost(head.tokens, head.warmRepeats, head.model) ?? null
  }

  /** The response's prompt size replaces the four-characters-per-token guess
   *  for the head's share of the prompt. */
  #repriceUncached(exchange: Exchange): void {
    const head = this.#headOf.get(exchange)
    const chars = exchange.segments.reduce((n, segment) => n + segment.chars, 0)
    if (!head || !exchange.promptTokens || chars === 0) return
    head.tokens = Math.round((head.chars * exchange.promptTokens) / chars)
    if (head.finding) head.finding.wastedUSD = this.#uncachedCost(head)
  }

  /** Bytes from the last usable breakpoint to the last breakpoint: what the
   *  break made the provider write again. */
  #lostBytes(divergence: Divergence, prefix: RenderedPrefix): number {
    return (prefix.cacheEndsAt ?? divergence.offset) - divergence.reusableUntil
  }

  #breakCost(divergence: Divergence, prefix: RenderedPrefix, exchange: Exchange): number | null {
    return rebuildCost(this.#lostBytes(divergence, prefix) / CHARS_PER_TOKEN, exchange.model) ?? null
  }

  #recordDivergence(divergence: Divergence, prefix: RenderedPrefix, exchange: Exchange): void {
    const lost = this.#lostBytes(divergence, prefix)
    const reuse =
      divergence.reusableUntil === 0
        ? `The change comes before every cache breakpoint, so none of the cached prefix could be reused: all ${lost} bytes were written again.`
        : `The cache was read up to byte ${divergence.reusableUntil}, the last breakpoint before the change; the ${lost} bytes after it were written again.`
    this.#record(exchange, {
      id: 'prefix-invalidated',
      title: `Prefix broke in ${divergence.segment}, ${divergence.offsetInSegment} bytes in`,
      wastedUSD: this.#breakCost(divergence, prefix, exchange),
      detail:
        `${reuse}\n` +
        `      was: ${visible(divergence.before)}\n` +
        `      now: ${visible(divergence.after)}`,
      fix: DIVERGENCE_FIX[divergence.segment],
    })
  }

  /** Once the response arrives, the bytes-to-tokens guess behind a break's cost
   *  gives way to the provider's numbers: its own count of tokens written when
   *  it reports one, otherwise the prompt's real tokens-per-byte ratio. The
   *  written count also includes the turn appended since the last request,
   *  which a healthy conversation would have written anyway; that is one turn
   *  against a whole rewritten prefix. */
  #repriceBreak(exchange: Exchange, usage: ObservedUsage): void {
    const divergence = exchange.divergence
    const finding = this.findings.find((f) => f.exchange === exchange.n && BREAKS.has(f.id))
    if (!divergence || !finding || exchange.cacheEndsAt === null) return
    let lostTokens = usage.writtenTokens
    if (lostTokens === undefined) {
      const chars = exchange.segments.reduce((n, segment) => n + segment.chars, 0)
      if (!usage.promptTokens || chars === 0) return
      lostTokens = ((exchange.cacheEndsAt - divergence.reusableUntil) * usage.promptTokens) / chars
    }
    finding.wastedUSD = rebuildCost(lostTokens, exchange.model) ?? null
  }

  #record(
    exchange: Exchange,
    finding: Omit<LiveFinding, 'at' | 'exchange' | 'wastedUSD'> & { wastedUSD?: number | null },
  ): LiveFinding {
    const recorded = { ...finding, wastedUSD: finding.wastedUSD ?? null, at: new Date(), exchange: exchange.n }
    exchange.findings.push(finding.id)
    this.findings.push(recorded)
    return recorded
  }

  snapshot(upstream: string): Live {
    return {
      mode: 'proxy',
      upstream,
      requests: this.#requests,
      usage: { ...this.totals },
      exchanges: this.#exchanges,
      findings: this.findings.map((finding) => ({ ...finding, at: finding.at.toISOString() })),
    }
  }
}
