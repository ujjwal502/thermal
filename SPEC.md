# Thermal

Thermal finds where LLM prompt caching broke and what it cost. A local
forwarding proxy sees each request body and names the byte that broke the
cached prefix. A read mode analyses the Claude Code session logs already on
disk, with no configuration.

The proxy is the product. Read mode is the zero-setup first run. Section 9
records the measurement that decided this; do not re-prioritise read mode
without new evidence.

---

## 1. Why this exists

Every agent request re-sends the whole conversation. Providers cache a stable
*prefix* of that request so repeat calls cost a fraction of input price, but
only while the prefix stays byte-identical. Change one byte before the cached
boundary and the provider writes the prefix again at full price or more.

Nothing fails when this happens. There is no error and no log line; the usage
fields change and the bill goes up. Spend dashboards report what was spent, not
which byte caused it. Thermal reports the byte.

### The metaphor

Cached context is **hot**: already paid for, read cheaply. Uncached context is
**cold**: recomputed at full price. The visual language in `DESIGN.md` follows
from that.

### Who it's for

People building their own agents or LLM features against the Anthropic or
OpenAI APIs, who control the request and can act on a diagnosis. One developer,
one machine. Not teams, not production observability.

Claude Code users are the secondary audience. Read mode shows them their
numbers, but on the evidence so far Claude Code's caching works and its largest
finding is not the user's to fix (section 9).

---

## 2. Two sources of truth

**Request bodies (proxy mode).** The only place the offending byte is visible.
Point an agent at the proxy with `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL`; it
forwards every request untouched and analyses a copy after the response has
been delivered.

**Session logs (read mode).** Claude Code writes JSONL transcripts to
`~/.claude/projects/`, including subagent logs nested four levels deep
(`<project>/<session>/subagents/*.jsonl`). Every assistant record carries usage:

```json
{
  "input_tokens": 2,
  "cache_creation_input_tokens": 12421,
  "cache_read_input_tokens": 30133,
  "output_tokens": 534,
  "cache_creation": {
    "ephemeral_1h_input_tokens": 12421,
    "ephemeral_5m_input_tokens": 0
  }
}
```

Logs show *that* a cache broke and what it cost, not *where* in the prompt. They
need no configuration, which is why read mode is the first run.

---

## 3. Architecture: two plug points

Both are designed for extension because more implementations are known to be
coming. Everything else in the codebase starts concrete.

### Agent adapters: where the data comes from

| Adapter | Source | Status |
|---|---|---|
| Live proxy | HTTP forwarding from any client with a configurable base URL | **Built.** Primary |
| Claude Code | `~/.claude/projects/**/*.jsonl` | **Built** |
| Codex CLI | Not yet inspected on disk | Not started |
| Cursor | Not yet inspected on disk | Not started |

### Provider analyzers: what the cache rules are

| Provider | Cache model | Status |
|---|---|---|
| Anthropic | Explicit `cache_control` breakpoints, max 4, model-dependent minimum prefix | **Built.** Validated against live traffic |
| OpenAI | Automatic prefix caching from 1024 tokens, `cached_tokens` on every response | **Built.** Validated against live traffic |
| Google | Implicit and explicit context caching | Not started |

The two built analyzers must not be collapsed into one:

- **Anthropic** caches on explicit breakpoints, keyed on the whole prefix up to
  each one. A change after the last breakpoint costs nothing. A change before it
  loses everything back to the previous breakpoint, or to byte 0 if there is
  none. A request with no breakpoint cannot have a cache break. A top-level
  `cache_control` (automatic caching) is a breakpoint on the last block that
  never appears in the request's content, and it takes one of the four slots.
  Only a text diff shows where a break happened.
- **OpenAI** caches automatically and reports `cached_tokens` on every
  response. That is ground truth, so the text diff is not run for OpenAI and the
  breakpoint detectors are gated off. Chat Completions sends the system prompt
  as leading messages; the X-ray shows it as the system segment.

### Pipeline

```
read mode:   discover -> parse -> detect -> price -> render
proxy mode:  forward -> (after response) render prefix -> diff -> read usage -> price -> render
```

---

## 4. Detectors

**Detectors are named, never numbered.** A slug is the stable identifier users
search, suppress and cite; a sparse numbering leaks an internal index into
output.

**Every finding states what happened, what it cost in dollars, and the fix.** A
finding that loses no cached tokens has no dollar figure to state, and says
nothing rather than a misleading $0. A model missing from the price table
produces no figure either. Both cases are listed below; any other finding
without a dollar amount is a bug.

### Built

| Detector | Mode | Detects | Dollar figure |
|---|---|---|---|
| `prefix-invalidated` | both | A warm cache went cold. In proxy mode, with the segment, byte offset and the bytes before and after | Proxy: tokens rewritten, from the response's `cache_creation_input_tokens` (byte estimate until the response arrives) |
| `ttl-premium-wasted` | read | 1-hour cache writes followed by another request inside five minutes, where a 5m entry would have stayed warm | The 1h-over-5m write premium |
| `cache-never-read` | read | A session that wrote a cache and never read it | The write premium |
| `caching-net-negative` | read | A session whose cache reads saved less than its writes cost | Writes minus read savings |
| `tool-set-changed` | proxy | The tool list changed mid-conversation | The prefix it broke, priced as `prefix-invalidated`. No figure when nothing was cached |
| `nondeterministic-tool-json` | proxy | The same tools serialised with a different key order | As `tool-set-changed` |
| `cacheable-prefix-uncached` | proxy | A large tools-and-system head resent with no breakpoint (Anthropic) | Input price paid on each repeat inside five minutes, less the write premium caching would add; grows with every repeat |
| `automatic-cache-not-landing` | proxy | Three large prompts in a row reporting `cached_tokens: 0` after a hit (OpenAI) | The tokens the last hit read, at input price instead of cached price, for every miss in the run. No figure when no hit was seen |
| `too-many-breakpoints` | proxy | More than four `cache_control` markers (Anthropic) | None: loses no cached tokens |
| `prefix-below-minimum` | proxy | Caching requested on a prefix below the model's minimum (Anthropic) | None: the provider writes nothing and charges no premium |

A tool change that breaks a cached prefix is reported once, as the tool
finding. A second `prefix-invalidated` for the same bytes would count the money
twice.

### Not built

| Detector | Detects | Notes |
|---|---|---|
| `model-switched` | Model changed mid-session; caches are model-scoped | `diagnostics.cache_miss_reason` in Claude Code logs already carries `model_changed` on about 1% of turns |
| `effort-changed` | Effort changed mid-conversation, invalidating the messages cache | |
| `history-edited` | An earlier turn rewritten rather than appended | Partly covered: `prefix-invalidated` reports it in the messages segment |
| `system-prompt-churn` | The system prompt changes within a session | Overlaps `prefix-invalidated`; may not earn a separate finding |
| `breakpoint-after-volatile` | A breakpoint placed after content that changes every call | Overlaps `prefix-invalidated` |
| `tool-definition-bloat` | Tool schemas that cost tokens on every call and are rarely used | Needs tool-call counts the proxy does not yet keep |
| `duplicate-context` | The same content read into context more than once | |
| `retry-storm` | The same request repeated in quick succession | |
| `context-growth-unbounded` | Context grows without compaction | |
| `expensive-outliers` | The few requests that dominate spend | |

### Output contract

Read mode (`src/types.ts`):

```ts
interface Finding {
  id: string                  // "ttl-premium-wasted"
  severity: 'critical' | 'warning' | 'info'
  title: string
  wastedTokens: number
  wastedUSD: number
  occurrences: number
  detail: string
  fix: string
  sites: { turn: Turn; wastedUSD: number }[]   // where the waste fell, for the timeline
}
```

Proxy mode (`src/proxy/capture.ts`):

```ts
interface LiveFinding {
  id: string
  title: string
  detail: string              // for a break, includes the bytes before and after
  fix: string                 // names where the changing part should go, not just what to remove
  wastedUSD: number | null    // null only in the cases listed above
  at: Date
  exchange: number            // the request that triggered it, for the X-ray
}
```

---

## 5. Cost model

- Per-model list prices in `src/pricing.ts`: input, output and cache read, per
  million tokens. Anthropic cache writes use the published multipliers (1.25x
  input for 5m, 2x for 1h); these have not been checked against an invoice.
  OpenAI charges nothing extra to write its cache.
- A model missing from the table is named in the report and excluded from
  totals, never priced at $0.
- Waste is measured against what was **recoverable**, not a theoretical floor.
  An early version compared spend with perfect caching and overclaimed 13x.
- A rebuilt prefix is priced at the 5m write rate, the cheaper of the two, so a
  break is never overstated.
- Proxy figures start as a byte-based estimate (four characters per token) and
  are replaced by the provider's counts when the response arrives.
- For Claude Code on a subscription, every figure is notional: what the same
  traffic would cost at API rates.

Open: the table is bundled source, not editable config, and nothing warns when
it is stale (section 11).

---

## 6. Interface

### CLI

| Command | Purpose | Status |
|---|---|---|
| `thermal` | Read mode: terminal report, then the dashboard on 127.0.0.1:7870 | Built |
| `thermal --report` | Terminal report only; also the behaviour when output is piped | Built |
| `thermal --since <days>` | Time window | Built |
| `thermal --project <name>` | Projects whose name contains this | Built |
| `thermal --root <path>` | Another session directory | Built |
| `thermal --redact` | Project names and paths replaced, for shareable screenshots | Built |
| `thermal proxy` | Proxy on 127.0.0.1:7878, live view at `/_thermal/`, summary on Ctrl-C | Built |
| `thermal proxy --upstream <url>` | Another provider, for example `https://api.openai.com` | Built |
| `thermal --json` | Machine-readable output | Not built |
| `thermal watch` | Tail session logs while working | Not built |

The terminal report must stand on its own. Many users never open the browser,
and the terminal view is the one pasted into chats. It wraps to the terminal
width.

### Views

Built, in the read-mode dashboard:

- **Overview**: headline waste, spend by day, findings ranked by dollars,
  sessions with the most waste.
- **Findings**, **Sessions**, **Projects**: sortable tables, scoped by project
  and time window.
- **Session timeline**: turns with a cache-state ribbon, the turns a finding
  blames, and Anthropic's `cache_miss_reason` where present.

Built, in the proxy's live view:

- **Context X-ray**: one request as a bar in render order (tools, system,
  messages), sized by length, marking the last breakpoint and where the prefix
  changed.
- **The diff**: the bytes before and after the first divergence, trimmed to
  word boundaries.
- **Requests** and **Findings**: newest first, each finding linked to its
  request.

Not built: tool inventory, shareable PNG summary card.

Every read-mode view has a URL. Both modes take `j`/`k`, `Enter` and `?` for
help; read mode adds `/` to search and `1`-`4` for views.

---

## 7. UX principles

1. **Zero configuration for first value.** Config exists only to go deeper.
2. **Every finding carries a dollar amount**, with the exceptions in section 4
   stated rather than hidden.
3. **Every finding carries a fix that names a destination.** "Move the timestamp
   out of the system prompt" sent people to the first message, which breaks a
   cached history just the same. Say where it goes.
4. **Nothing leaves the machine.** No telemetry, no account, no upload. The
   proxy forwards only to the configured upstream origin; a request path can
   never redirect it to another host.
5. **The proxy is invisible.** Responses stream straight through; analysis runs
   after the client has its bytes.
6. **Fast.** 155 sessions and 38K requests parse in 1.0s.
7. **Dark surface only, validated.** Colours pass the dataviz validator
   (`DESIGN.md`). A light theme would be separately stepped and validated, never
   inverted.
8. **Designed empty, loading and error states.**
9. **Honest about uncertainty.** An estimate is marked as one (`~$`). A summary
   always says whether usage was read at all, because a clean report that
   measured nothing looks exactly like a healthy one.

---

## 8. Non-goals

- **Not an observability platform.** No server, no account, no cloud.
- **Not a team cost tool.** One developer, one machine.
- **Not a production proxy.** A debugging aid, never in a serving path.
- **Not an optimizer.** Thermal diagnoses; it does not rewrite prompts.
- **Not a general LLM tracer.** Langfuse and Phoenix own that.
- **No TLS interception.** Base-URL redirection and local files only.
- **No telemetry.** Ever.

---

## 9. Build order and evidence

### v0: read mode, and the gate it failed

The founding premise was that people lose money to broken caches. Measured on
one machine's Claude Code history on 2026-09-28:

```
155 sessions · 38K requests · parsed in 1.0s
98.1% cache hit rate
$742.61 attributable waste on $8,627.77 notional (8.6%)
cache-never-read and caching-net-negative find nothing
```

The corpus changes daily (new sessions arrive, old ones age out), so absolute
figures drift. The shape is what matters: Claude Code's caching works, and its
one large finding, the 1h TTL, is Claude Code's choice rather than the user's.
A read-mode tool can show a Claude Code user their waste and offer no action.

**The TTL finding stands on its own.** A cache read refreshes the entry's timer
on either TTL, so requests under five minutes apart keep a 5m entry warm
indefinitely and the 1h TTL buys nothing but the doubled write price. 30,076 of
31,163 one-hour writes (96.5%) were followed by another request within two
minutes; median gap 4.1s, p90 24.7s.

**Consequence: proxy mode became the product.** The diagnosis with an action
attached, naming the byte that broke the prefix, needs the request body. The
people who can act on it build their own agents.

### v1: proxy mode, Anthropic, validated live

Forwarding of JSON and SSE responses is verified byte for byte through a stub.
On 2026-09-28, twelve requests to `claude-sonnet-5` went through the proxy to the
live API. Thermal's prompt and cached token counts matched the API's usage on
every one, streamed or not, and each finding was priced from the API's own
`cache_creation_input_tokens`:

```
stable prompt, explicit breakpoint        write 3334, then read 3334 twice  -> 0 findings
timestamp in the cached system prompt     rewrote 3345                      -> prefix-invalidated, $0.0077
tool list [read] -> [read, write]         rewrote 3726                      -> tool-set-changed, $0.0086
automatic caching, then system changed    read 3351, then rewrote 3350      -> prefix-invalidated, $0.0077
3,098-token prompt, no cache_control      full input price twice            -> cacheable-prefix-uncached, $0.0040
```

**Claude Code through the proxy showed where a byte diff and the provider
disagree.** Claude Code moves its breakpoint to the newest message each turn,
which removes `cache_control` from an older block, and sometimes sends the same
content as a string on one turn and a one-block array on the next. Both change
the JSON bytes; neither changes the prompt the provider renders, which read
36,211 of 36,330 tokens from cache. Thermal reported both as breaks. A break is
now withdrawn when the response shows the cache was read past the changed byte.
A real break always reads less than that, so none are lost.

Not yet run live: a long agent session. Thermal only knows the current
request's breakpoints, so a break's description can understate how much was
reused; its price still comes from the API's written count.

Design notes worth keeping:

- **Arrays render as concatenated elements, not JSON arrays.** Serialising
  `messages` with `JSON.stringify` makes every append look like a divergence,
  because the closing bracket moves.
- **Non-determinism is a comparison between requests, never a property of
  one.** An unusual key order caches perfectly well if it is stable.
- **Only bytes before the last breakpoint are cached.** A changed user question
  after it is supposed to change; reporting it flagged every healthy request.
- **Model the provider's cache unit, not the diff.** A change loses everything
  back to the last breakpoint before it, not merely the bytes after the change.
  Pricing only the latter understated a break about 150x.
- **A conversation is followed by its history, not only its first message.** A
  timestamp moved into the first message made every request look new, so a
  cached history broke on every call unseen.

### v1.1: OpenAI, validated live

Run through the proxy against a production security-scan prompt of about 3,290
tokens, with ground truth from `cached_tokens`:

```
stable system prompt, only the question changes   3200 / 3290 cached  -> 0 findings
a clock at the START of the system prompt            0 / 3310 cached  -> 1 finding
```

Live traffic also caught a false positive no fixture had: a cold first call
plus one of OpenAI's best-effort misses counted as a failing run. The detector
now skips the first large prompt, resets on any hit, and ignores prompts under
1024 tokens.

### v2: dashboard and live view: built

Read-mode dashboard and proxy live view as described in section 6, with no
runtime dependencies. Rendered and audited at 1280 and 1920 wide. `--redact`
built for public screenshots.

### Next, in order

1. **Run a long agent session live** through the proxy, and track breakpoints
   written by earlier requests so reuse is described correctly.
2. **More detectors**, starting with `model-switched`, which Anthropic's
   `cache_miss_reason` provides almost for free.
3. Codex and Cursor adapters, once their on-disk formats are inspected.

### Unused signals worth a detector

`prompt_cache_key` and `input_tokens_details.cache_write_tokens` on the OpenAI
Responses API. `diagnostics.cache_miss_reason` on Anthropic responses
(`model_changed`, `messages_changed`, `previous_message_not_found`).

---

## 10. Technical decisions

| Decision | Choice | Rationale |
|---|---|---|
| Language | TypeScript | One language for CLI, proxy and browser code |
| Runtime | Node 20+ | `npx` works everywhere; the packed tarball is verified on Node 20 |
| Distribution | npm / `npx` | Zero-install first run |
| Runtime dependencies | None | Download weight on every first `npx` run |
| Storage | None; everything in memory | Session logs are re-read in about a second; the proxy keeps the last 200 requests |
| Token counts | Provider usage fields; four characters per token until a response arrives | No tokenizer dependency, no API call. The provider's count replaces the estimate |
| Analysis timing | After the response is delivered | The proxy must add no latency |
| Frontend | Hand-written DOM and SVG, compiled by the same TypeScript | No framework; Iosevka subset at 15 kB per weight |

---

## 11. Open questions

1. **Pricing freshness.** Bundled table, editable config, or a warning when a
   price is old? Today it is bundled source with a read date for the OpenAI
   rows.
2. **Content handling.** Request bodies hold source code. Thermal keeps them in
   memory only and writes nothing to disk; excerpts of the diverging bytes do
   appear in the live view and terminal.
3. **Cross-agent adapters.** Do Codex and Cursor write comparable usage
   telemetry, or only Claude Code?
4. **Cache write multipliers.** Confirm 1.25x and 2x against a real invoice
   before quoting a total to anyone.

---

## 12. Definition of done for v1

- [x] `thermal` runs with zero configuration (packed tarball, Node 20)
- [x] Parses every session file on this machine in under 10 seconds (1.0s)
- [ ] Every finding shows a dollar amount and a fix, or states why it has none
      (done for all built detectors; open for each new one)
- [x] Nothing is transmitted off the machine
- [x] Anthropic proxy path validated against the live API
- [x] Published to npm (`thermal-cache`)
- [ ] README shows the X-ray view in the first screenful
- [ ] The author has found and fixed a real cache bug in their own agent with it
