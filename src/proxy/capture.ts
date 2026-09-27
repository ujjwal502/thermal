import { createHash } from 'node:crypto'
import type { Divergence, Provider, RenderedPrefix, RequestBody, SegmentName } from './prefix.ts'
import { continues, conversationKey, firstDivergence, render, toolSerialisationChanged } from './prefix.ts'
import { readSavings, rebuildCost } from '../pricing.ts'
import type { ObservedUsage } from './usage.ts'
import type { Exchange, Live } from '../dashboard/contract.ts'

export interface LiveFinding {
  id: string
  title: string
  detail: string
  fix: string
  /** Estimated from bytes, and from the provider's token counts once the
   *  response arrives. Null where Thermal cannot price the finding. */
  wastedUSD: number | null
  at: Date
  /** The exchange that triggered it, so the live view can show its prefix. */
  exchange: number
}

interface Seen {
  body: RequestBody
  prefix: RenderedPrefix
}

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
  #heads = new Map<string, number>()
  #uncachedReported = new Set<string>()
  #openAiMissStreak = 0
  #openAiSawLargePrompt = false
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

    if (toolSerialisationChanged(previous.body, body)) {
      this.#record(exchange, {
        id: 'nondeterministic-tool-json',
        title: 'Identical tools serialised into different bytes',
        detail: 'The tool definitions mean the same thing but their JSON key order changed between requests. Tools render first, so this invalidates the entire prefix.',
        fix: 'Sort object keys before serialising your tool definitions.',
      })
    }

    const previousNames = previous.prefix.toolNames.join(',')
    if (previousNames !== prefix.toolNames.join(',')) {
      this.#record(exchange, {
        id: 'tool-set-changed',
        title: 'Tool list changed mid-conversation',
        detail: `Tools went from [${previousNames}] to [${prefix.toolNames.join(',')}]. Tools render before everything else, so the whole prefix is recomputed.`,
        fix: 'Keep the tool list fixed for the life of a conversation, in a stable order.',
      })
    }

    // OpenAI reports cached_tokens directly, which is ground truth and beats
    // anything inferred from diffing text. Only Anthropic needs the diff.
    if (provider === 'anthropic') {
      const divergence = firstDivergence(previous.prefix, prefix)
      if (divergence) {
        exchange.divergence = divergence
        this.#recordDivergence(divergence, prefix, exchange)
      }
    }
    return exchange
  }

  /** OpenAI caches automatically, so there is no breakpoint to get wrong - the
   *  only failure mode is a prefix that never repeats identically. When a large
   *  prompt keeps missing the cache, the prefix is moving. */
  observeUsage(usage: ObservedUsage, provider: Provider, exchange: Exchange): void {
    exchange.promptTokens = usage.promptTokens
    exchange.cachedTokens = usage.cachedTokens
    this.#repriceBreak(exchange)
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
      return
    }
    if (first) return
    if (++this.#openAiMissStreak !== MISSES_BEFORE_REPORTING) return

    this.#record(exchange, {
      id: 'automatic-cache-not-landing',
      title: `${MISSES_BEFORE_REPORTING} large prompts in a row cached nothing`,
      detail:
        `Prompts of ${usage.promptTokens} tokens are reporting cached_tokens: 0. ` +
        'OpenAI caches long prefixes automatically, so repeated misses mean the start of the prompt is changing between calls.',
      fix: 'Move anything variable - timestamps, ids, retrieved context, the user question - to the END of the prompt, and keep the opening bytes identical.',
    })
  }

  /** A large stable prompt resent with no breakpoint at all. This is not a
   *  broken cache - it is a cache nobody asked for, and it is invisible because
   *  nothing fails. Reported once per distinct prompt, on the second sighting. */
  #checkUncachedRepeat(body: RequestBody, prefix: RenderedPrefix, exchange: Exchange): void {
    if (prefix.breakpoints > 0) return

    const key = headKey(prefix)
    const seen = (this.#heads.get(key) ?? 0) + 1
    this.#heads.set(key, seen)
    if (seen < 2 || this.#uncachedReported.has(key)) return

    const tokens = Math.round(headLength(prefix) / CHARS_PER_TOKEN)
    if (tokens < SMALLEST_CACHEABLE_TOKENS) return

    this.#uncachedReported.add(key)
    const model = typeof body.model === 'string' ? body.model : 'claude-opus-5'
    const perRepeat = readSavings(tokens, model)

    this.#record(exchange, {
      id: 'cacheable-prefix-uncached',
      title: `A ~${tokens} token prompt is being resent uncached`,
      detail:
        `The same tools and system prompt have now been sent ${seen} times with no cache_control anywhere. ` +
        `Every repeat pays full input price for bytes the server would otherwise hold. ` +
        `Roughly $${perRepeat.toFixed(4)} per repeat on ${model}.`,
      fix: 'Put a cache_control breakpoint at the end of the system prompt. The first call pays a small write premium and every call after it reads at a fraction of input price.',
    })
  }

  #recordDivergence(divergence: Divergence, prefix: RenderedPrefix, exchange: Exchange): void {
    const lost = (prefix.cacheEndsAt ?? divergence.offset) - divergence.reusableUntil
    const reuse =
      divergence.reusableUntil === 0
        ? `The change comes before every cache breakpoint, so none of the cached prefix could be reused: all ${lost} bytes were written again.`
        : `The cache was read up to byte ${divergence.reusableUntil}, the last breakpoint before the change; the ${lost} bytes after it were written again.`
    this.#record(exchange, {
      id: 'prefix-invalidated',
      title: `Prefix broke in ${divergence.segment}, ${divergence.offsetInSegment} bytes in`,
      wastedUSD: rebuildCost(lost / CHARS_PER_TOKEN, exchange.model) ?? null,
      detail:
        `${reuse}\n` +
        `      was: ${JSON.stringify(divergence.before)}\n` +
        `      now: ${JSON.stringify(divergence.after)}`,
      fix: DIVERGENCE_FIX[divergence.segment],
    })
  }

  /** Once the response reports how many tokens the prompt really was, the
   *  bytes-to-tokens guess behind a break's cost gives way to that ratio. */
  #repriceBreak(exchange: Exchange): void {
    const divergence = exchange.divergence
    const finding = this.findings.find((f) => f.exchange === exchange.n && f.id === 'prefix-invalidated')
    if (!divergence || !finding || !exchange.promptTokens || exchange.cacheEndsAt === null) return
    const chars = exchange.segments.reduce((n, segment) => n + segment.chars, 0)
    const lostTokens = ((exchange.cacheEndsAt - divergence.reusableUntil) * exchange.promptTokens) / chars
    finding.wastedUSD = rebuildCost(lostTokens, exchange.model) ?? null
  }

  #record(exchange: Exchange, finding: Omit<LiveFinding, 'at' | 'exchange' | 'wastedUSD'> & { wastedUSD?: number | null }): void {
    exchange.findings.push(finding.id)
    this.findings.push({ ...finding, wastedUSD: finding.wastedUSD ?? null, at: new Date(), exchange: exchange.n })
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
