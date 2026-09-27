# Thermal

**Your AI agents are wasting money on cache misses. Thermal shows you where, and what it costs.**

`npx thermal` — reads the session logs already on your machine, finds the exact moment your prompt cache broke, and tells you what to change.

---

## 1. Why this exists

Every agent request re-sends the whole conversation. Providers cache a stable *prefix* of that request so repeat calls are far cheaper — but only while the prefix stays byte-identical. Change one character near the front and every subsequent call silently re-pays full price for the entire prefix.

**There is no error. No warning. No log line.** The bill just goes up.

Today's tools tell you *what* you spent. None tell you *why*. Thermal answers why.

### The metaphor

Cached context is **hot** — cheap, already paid for. Uncached context is **cold** — recomputed from scratch, full price. Thermal renders your context window as a heat map, and the product's whole visual language follows from that.

### Who it's for

Individual developers running coding agents (Claude Code, Codex, Cursor) who suspect they're overspending but can't see where. Not teams, not enterprises, not production observability. One person, one laptop, real numbers.

---

## 2. The core insight

We verified this on a real machine: **the data is already on disk.** Claude Code writes JSONL session transcripts to `~/.claude/projects/`, and every assistant record carries full usage telemetry:

```json
{
  "input_tokens": 2,
  "cache_creation_input_tokens": 12421,
  "cache_read_input_tokens": 30133,
  "output_tokens": 534,
  "cache_creation": {
    "ephemeral_1h_input_tokens": 12421,
    "ephemeral_5m_input_tokens": 0
  },
  "service_tier": "standard",
  "speed": "standard"
}
```

Plus `requestId`, `timestamp`, `durationMs`, `effort`, `sessionId`, `gitBranch`, `cwd`, and the full message content.

**Consequence: version one needs no proxy, no API key, and no configuration.** One command, instant analysis of months of real history. That zero-setup first run is the single most important feature in this document.

---

## 3. Architecture: two plug points

The universality question resolves into two independent interfaces. Build both from day one; add implementations on demand.

### Agent adapters — *where the data lives*

Each agent stores its history differently. An adapter discovers, parses, and normalizes into Thermal's internal shape.

| Adapter | Source | Priority |
|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` | **v0** |
| Live proxy | HTTP interception (any agent with a configurable base URL) | v1 |
| Codex CLI | TBD — inspect on disk | v2 |
| Cursor | TBD — inspect on disk | v2 |
| Aider / OpenCode / others | Community contributions | v2 |

### Provider analyzers — *what the cache rules are*

Caching semantics differ per provider. The detectors are provider-specific even when the transport is shared.

| Provider | Cache model | Priority |
|---|---|---|
| Anthropic | Explicit opt-in `cache_control` breakpoints, max 4, minimum prefix length | **v0** |
| OpenAI | Automatic prefix caching, no breakpoints | v2 |
| Google | Implicit + explicit context caching | v3 |

**Anthropic first** — explicit breakpoints mean more ways to get it wrong, which means more for a linter to find.

### Pipeline

```
discover → parse (incremental) → normalize → detect → price → render
```

---

## 4. Detectors

The heart of the product. **Detectors are named, never numbered.** A sparse hand-kept numbering (D1, D3, D9) tells a reader nothing and leaks an internal index into user-facing output; a slug is self-documenting and survives reordering. The name is the stable identifier users search, suppress and cite.

**Every detector must output: what, where, why it costs, how much in dollars, and the exact fix.** A finding without a dollar amount and a fix is noise and does not ship.

### Cache correctness

| Detector | Detects | Why it costs | Fix |
|---|---|---|---|
| `cache-never-read` | Cache never warms — `cache_read_input_tokens` is 0 across N consecutive calls | Paying full price every single call | Point to the first divergent byte (`prefix-invalidated`) |
| `prefix-below-minimum` | Prefix below minimum cacheable length (512–4096 tokens, model-dependent) | `cache_control` set but silently does nothing — no error is ever raised | Move more stable content before the breakpoint, or drop the breakpoint |
| `prefix-invalidated` | Volatile content before the last breakpoint — timestamps, UUIDs, random IDs, counters | Invalidates the entire prefix on every call | Show the exact diverging substring and its position |
| `tool-set-changed` | Tool set changed between calls | Tools render first, so any change invalidates everything after | Freeze the tool list; sort deterministically |
| `nondeterministic-tool-json` | Non-deterministic JSON key order in tool definitions | Different byte sequence each call despite identical semantics | Sort keys before serializing |
| `too-many-breakpoints` | More than 4 cache breakpoints | Hard API cap; extras are rejected or ignored | Consolidate to the 4 highest-value boundaries |
| `breakpoint-after-volatile` | `cache_control` placed after volatile content | Breakpoint covers nothing stable | Move the breakpoint earlier |
| `system-prompt-churn` | System prompt churn within a session | Full prefix invalidation per call | Diff the system prompts, highlight the delta |
| `ttl-premium-wasted` | TTL mismatch — paid the 1h cache-write premium, never reused within the hour | Pure waste; 1h writes cost more than 5m | Switch to 5m TTL for this workload |
| `model-switched` | Model switched mid-session | Caches are model-scoped — a switch discards the whole cache | Pin the model, or accept and surface the cost |
| `effort-changed` | Effort level changed mid-conversation | Invalidates the messages cache | Use a per-message effort system message where supported |
| `history-edited` | History edited (non-append-only mutation) | Rewriting earlier turns invalidates everything downstream | Make the harness append-only |

### Waste and bloat

| Detector | Detects | Why it costs | Fix |
|---|---|---|---|
| `caching-net-negative` | Cache-write cost exceeds read savings | Writing a cache nobody reuses is strictly worse than not caching | Remove the breakpoint |
| `tool-definition-bloat` | Tool-definition bloat — tokens spent on schemas vs. actual call frequency | "You define 40 tools; 3 are ever called; the other 37 cost $X/month" | Trim, or use deferred tool loading |
| `duplicate-context` | Duplicate content — same file read into context multiple times | Paying repeatedly for identical bytes | Show all occurrences |
| `retry-storm` | Retry storms — the same request repeated in quick succession | Multiplied cost, often invisible | Surface the pattern |
| `context-growth-unbounded` | Runaway context growth — sessions where context balloons without compaction | Every subsequent turn gets more expensive | Recommend compaction or context editing |
| `expensive-outliers` | Most expensive individual requests (long tail) | A handful of calls often dominate a bill | Rank, with drill-down |

### Detector output contract

```ts
interface Finding {
  id: string                 // "prefix-invalidated"
  severity: "critical" | "warning" | "info"
  title: string              // human, specific
  wastedTokens: number
  wastedUSD: number          // required — no finding ships without this
  occurrences: number
  location: { sessionId, turnIndex, project, filePath, lineNumber }
  evidence: { before: string, after: string, divergenceOffset: number }
  fix: { description: string, snippet?: string, docsUrl?: string }
}
```

---

## 5. Cost model

- Per-model pricing table: input, output, cache-write-5m, cache-write-1h, cache-read.
- **Ships as editable config**, not hardcoded — prices change and a stale table destroys trust.
- Warn when a session uses a model missing from the table rather than silently reporting $0.
- Three numbers computed per scope: **actual spend**, **theoretical minimum** (perfect caching), **waste** (the delta).
- **Waste is the headline number.** Everything else supports it.

---

## 6. Interface

### First run — the most important 60 seconds

```
$ npx thermal
```

1. No flags, no config, no API key.
2. Auto-discovers sessions. Shows a real progress bar (180+ files / 200MB is normal).
3. Prints a terminal summary immediately — value before the browser opens.
4. Opens the dashboard automatically.
5. If nothing is found: clear, friendly guidance on supported agents. Never a stack trace.

The headline, stated in one line:

> **You wasted $47.20 (31% of spend) on cache misses in the last 30 days.**

Specific, personal, emotional, screenshot-ready. This line is the product's marketing.

### Views

**1. Overview** — headline waste number, spend over time, waste by project, findings ranked by dollar impact.

**2. Context X-ray** *(the signature view)* — a single request as one horizontal bar, segmented in true render order (`tools` → `system` → `messages`), each segment sized by token count and colored by heat (hot = cached and cheap, cold = recomputed and expensive), labeled with its dollar cost. This is the screenshot people post.

**3. Session timeline** — a session as a sequence of turns, with a cache-hit ribbon across the top. The exact turn where the cache broke gets a marker and an annotation. Click to open the diff.

**4. The diff** *(the money shot)* — side-by-side prefix comparison between turn N and N+1, with the first divergent byte highlighted and everything downstream shaded as invalidated. Caption: *"This character cost you $12.40."*

**5. Findings** — every detector hit, sorted by dollars, each with its fix. Filterable by severity and project.

**6. Tool inventory** — every tool definition, its token cost, call frequency, and cost-per-actual-use. Sortable. Immediately actionable.

**7. Projects** — comparison across your repos. Which codebase is expensive, and why.

### CLI surface

| Command | Purpose |
|---|---|
| `npx thermal` | Analyze + open dashboard |
| `npx thermal --report` | Terminal summary only, no browser |
| `npx thermal --json` | Machine-readable output for scripting |
| `npx thermal --since 7d` | Time window |
| `npx thermal --project <name>` | Scope to one project |
| `npx thermal watch` | Live tail while you work |
| `npx thermal proxy` | Live proxy mode (v1) |
| `npx thermal --redact` | Content-stripped output, safe to share |

Terminal output must be genuinely well-designed — sparklines, colour, a clean summary table. Many users will never open the browser, and the terminal view is the one that gets pasted into chats.

---

## 7. UX principles

These are requirements, not aspirations. They are the actual differentiator; the analysis logic is replicable, the taste is not.

1. **Zero configuration for first value.** Config exists only to go deeper.
2. **Every finding carries a dollar amount.** No exceptions.
3. **Every finding carries a fix.** Copy-pasteable where possible. A diagnosis without a remedy is a complaint.
4. **Nothing leaves the machine.** No telemetry, no account, no upload — stated prominently in the README and the UI footer. Non-negotiable for a tool reading logs that sit next to source code.
5. **Fast.** Hundreds of files must parse in seconds. Incremental cache keyed on file mtime + byte offset; only new lines are ever re-read.
6. **Beautiful in both themes.** Dark mode is not an afterthought. This is the moat — nearly every tool in this space is ugly.
7. **Designed empty, loading, and error states.** Most tools treat these as afterthoughts; they are the first thing new users see.
8. **Shareable export.** Generate a summary card (PNG) with content redacted and numbers intact. This is the viral loop — people post their waste stats.
9. **Deep links.** Every view has a URL worth sending to a teammate.
10. **Keyboard navigable.** `j`/`k`, `/` to search, `?` for help.
11. **Honest about uncertainty.** Where a number is estimated, say so. Never present an inference as a measurement.

---

## 8. Non-goals

Scope discipline. Each of these is a real temptation and each would sink the project.

- **Not an observability platform.** No server, no account, no cloud, no dashboard-as-a-service.
- **Not a team cost tool.** One developer, one machine. Multi-user is a different product.
- **Not a production proxy.** The proxy is a debugging aid, never in a serving path.
- **Not an optimizer.** Thermal diagnoses; it does not rewrite your prompts.
- **Not a general LLM tracer.** Langfuse and Phoenix own that. Thermal does one thing.
- **No TLS interception.** Base-URL redirection and local files only. MITM certificates are terrible UX and a security smell.
- **No telemetry.** Ever.

---

## 9. Build order

### v0 — prove it — DONE, and it changed the plan

Built and run against 177 real sessions (40K requests, 0.8s). Result:

```
$8263.79 at API rates       notional - a subscription is billed differently
$640.72 attributable waste  7.8% of the above
98.0% cache hit rate

ttl-premium-wasted   $611.06  27741 writes
prefix-invalidated    $29.65     19 occurrences
```

`cache-never-read` and `caching-net-negative` found nothing at all.

**What the gate says.** The founding premise was wrong. Claude Code's caching is
already working — 98% hit rate — so there is no broken-cache epidemic to expose.
Worse, the one large finding is not the user's to fix: Claude Code chooses the
1-hour TTL, not the person running it. A read-mode tool can show a Claude Code
user their waste and offer them no action.

**What survives.** The finding itself is real and verified against Anthropic's
documentation: a cache read refreshes the entry's timer on either TTL, so
requests under five minutes apart keep a 5m entry warm indefinitely and the 1h
TTL "buys nothing there except the doubled write price". On this corpus 27,741
of 28,735 1-hour writes were followed by another request within two minutes.
That is worth publishing on its own, separately from any tool.

**Consequence: proxy mode became the product, not a later phase.** The diagnosis
that has an action attached — naming the byte that broke the prefix — needs the
request body, which logs do not contain. The people who can act on it are those
building their own agents, not those running someone else's.

Read mode keeps its place as the zero-configuration first run. It is the hook
that makes installation free, not the thing that delivers the value.

### v1 — proxy mode — DONE

A local forwarding proxy on 127.0.0.1:7878. Point an agent at it with
`ANTHROPIC_BASE_URL` and it passes every request through untouched, then diffs
the prefix after the response has already been delivered.

Verified end to end against a stub upstream: JSON and SSE streaming both survive
the round trip byte for byte, and a timestamp planted in a system prompt is
caught with its offset and the before/after bytes.

Detectors this unlocked, all of which need the request body:

| Detector | Detects |
|---|---|
| `prefix-invalidated` | upgraded - now names the segment and byte offset, with context |
| `tool-set-changed` | the tool list changed mid-conversation |
| `nondeterministic-tool-json` | identical tools serialised into different bytes |
| `too-many-breakpoints` | more than four `cache_control` markers |
| `prefix-below-minimum` | caching requested on a prefix too short to cache |

Two design notes worth keeping:

- **Arrays render as concatenated elements, not JSON arrays.** Serialising
  `messages` with `JSON.stringify` makes every append look like a divergence,
  because the closing bracket moves. The prefix is a byte sequence that grows.
- **Non-determinism is a comparison between requests, never a property of one.**
  An unusual key order caches perfectly well as long as it is stable; the fault
  is the same tools producing different bytes twice.

Still to do: `system-prompt-churn` and `breakpoint-after-volatile` overlap
heavily with `prefix-invalidated` and may not earn separate findings.
`tool-definition-bloat` needs response data the proxy does not yet retain.

### v1.1 — OpenAI support, validated live — DONE

Run live against OpenAI through the proxy using a production security
scan prompt (~3,290 tokens) and a real key. Ground truth came from the API's own
`prompt_tokens_details.cached_tokens`:

```
stable system prompt, only the question changes   3200 / 3290 cached  -> 0 findings
a clock at the START of the system prompt            0 / 3310 cached  -> 1 finding
```

**Providers differ in where the truth lives.** Anthropic caches on explicit
`cache_control` breakpoints, so a text diff of the prefix is the only way to see
a break. OpenAI caches automatically and reports `cached_tokens` on every
response - that is ground truth and beats anything inferred from diffing, so the
text diff is not run for OpenAI at all.

**The live run caught a false positive that unit tests could not.** The diff was
comparing the whole request, so a changed user question - which is supposed to
change on every call - was reported as a cache break on requests that were in
fact caching 97% of their tokens. Only bytes before the last breakpoint are
cached; a divergence after it costs nothing. Two consequences now enforced by
regression tests:

- A change after the last breakpoint is never a break.
- A request with no `cache_control` at all cannot have a cache break. Nothing was
  cached, so nothing was lost - `cacheable-prefix-uncached` covers that case.

### v2 — the dashboard
Overview, Context X-ray, Timeline, Diff, Findings, Tools. Shareable export.
`--redact`.

### v3 — breadth
OpenAI analyzer · Codex and Cursor adapters · watch mode · plugin API.

**Free from the logs already:** `diagnostics.cache_miss_reason` carries
Anthropic's own attribution (`model_changed`, `messages_changed`,
`previous_message_not_found`) on roughly 1% of turns — `model-switched` arrives
without being written.

## 10. Technical decisions

| Decision | Choice | Rationale |
|---|---|---|
| Language | TypeScript | Dashboard is TS regardless; one language for the stack |
| Runtime | Node 20+ | `npx` works universally; develop on Bun if preferred |
| Distribution | npm / `npx` | Zero-install is the single biggest adoption lever |
| Storage | SQLite (local) | Local-first; no server |
| Token counting (Claude) | `/v1/messages/count_tokens` | Claude's tokenizer is not tiktoken; local counting is wrong |
| Token counting (OpenAI) | `gpt-tokenizer` | Pure TS, fastest on npm, no native deps |
| Analysis timing | Off the hot path | In proxy mode: forward first, analyze after. Adds ~1ms |
| Frontend | TBD — keep it light | Dependencies are a liability in a tool people `npx` |

---

## 11. Open questions

1. **Name availability** — is `thermal` free on npm? Fallbacks: `cachelens`, `ember`, `hotpath`.
2. **Content handling** — session files contain source code. Default to metadata-only parsing? Content is needed for prefix diffing (`prefix-invalidated`), so the answer is probably: parse in memory, never persist raw content.
3. **Pricing freshness** — bundled table, remote fetch, or both?
4. **Do the numbers justify the tool?** Unknown until v0 runs. This is the gate.
5. **Cross-agent adapters** — do Codex and Cursor write comparable telemetry, or only Claude Code?

---

## 12. Definition of done for v1

- [ ] `npx thermal` works on a clean machine with zero configuration
- [ ] Parses all 181 session files in under 10 seconds
- [ ] Every finding shows a dollar amount and a fix
- [ ] Dashboard is genuinely beautiful in light and dark
- [ ] Nothing is transmitted off the machine
- [ ] README has a GIF showing the X-ray view in the first screenful
- [ ] The author has personally found and fixed a real cache bug using it
