import { createHash } from 'node:crypto'

/** Anthropic matches the cache on a byte prefix rendered in a fixed order:
 *  tools, then system, then messages. One changed byte anywhere invalidates
 *  everything after it, so the order here is not cosmetic - it decides which
 *  edits are cheap and which are ruinous.
 *
 *  OpenAI has no separate system field (the system message lives inside
 *  `messages`) and caches automatically rather than on marked breakpoints, but
 *  prefix stability matters just as much - arguably more, since there is no
 *  breakpoint to place and an unstable prefix is the only way to get it wrong. */
export type Provider = 'anthropic' | 'openai'

const SEGMENTS: Record<Provider, readonly SegmentName[]> = {
  anthropic: ['tools', 'system', 'messages'],
  openai: ['tools', 'system', 'messages'],
}

export type SegmentName = 'tools' | 'system' | 'messages'

export interface Segment {
  name: SegmentName
  text: string
  /** Offset of this segment's first byte within the rendered prefix. */
  start: number
}

export interface RenderedPrefix {
  text: string
  segments: Segment[]
  breakpoints: number
  toolNames: string[]
  /** Byte offset of the last cache_control marker. Only content BEFORE this is
   *  cached, so a change after it costs nothing and must not be reported.
   *  Undefined when the request asks for no caching at all. */
  cacheEndsAt: number | undefined
}

export interface RequestBody {
  model?: unknown
  system?: unknown
  tools?: unknown
  messages?: unknown
  /** Responses API spellings of system and messages. */
  instructions?: unknown
  input?: unknown
}

/** Stable serialisation: object keys are emitted in sorted order so that a
 *  request which only differs by key ordering renders identically. Anthropic
 *  compares raw bytes, so unsorted keys really do break the cache - but we want
 *  to detect that as its own fault rather than let it hide inside every diff. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))
  return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner)}`).join(',')}}`
}

/** Serialisation exactly as sent, preserving key order.
 *
 *  Top-level arrays render as their concatenated elements with no brackets or
 *  separators, because that is how the prefix actually behaves: appending a
 *  message must extend the byte sequence rather than move a closing bracket.
 *  JSON.stringify on the array would make every append look like a divergence. */
function verbatim(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => JSON.stringify(item) ?? 'null').join('')
  return JSON.stringify(value) ?? 'null'
}

function countBreakpoints(value: unknown): number {
  if (value === null || typeof value !== 'object') return 0
  if (Array.isArray(value)) return value.reduce<number>((n, item) => n + countBreakpoints(item), 0)
  const record = value as Record<string, unknown>
  const self = record['cache_control'] === undefined ? 0 : 1
  return self + Object.values(record).reduce<number>((n, item) => n + countBreakpoints(item), 0)
}

function toolNamesOf(tools: unknown): string[] {
  if (!Array.isArray(tools)) return []
  return tools.map((tool) =>
    typeof tool === 'object' && tool !== null && typeof (tool as { name?: unknown }).name === 'string'
      ? (tool as { name: string }).name
      : '<unnamed>',
  )
}

function isInstruction(message: unknown): boolean {
  const role = typeof message === 'object' && message !== null ? (message as { role?: unknown }).role : undefined
  return role === 'system' || role === 'developer'
}

export function render(body: RequestBody, provider: Provider = 'anthropic'): RenderedPrefix {
  // The Responses API calls these instructions and input. Same roles, same
  // position in the prefix, so they fold into the same segments.
  let systemLike = body.system ?? body.instructions
  let messagesLike = body.messages ?? body.input

  // Chat Completions carries the system prompt as leading messages. Splitting
  // them out leaves the rendered bytes identical - elements concatenate either
  // way - and only moves the segment boundary to where a person expects it.
  if (systemLike === undefined && Array.isArray(messagesLike)) {
    const lead = messagesLike.findIndex((message) => !isInstruction(message))
    const split = lead === -1 ? messagesLike.length : lead
    if (split > 0) {
      systemLike = messagesLike.slice(0, split)
      messagesLike = messagesLike.slice(split)
    }
  }
  const parts: Record<SegmentName, string> = {
    tools: body.tools === undefined ? '' : verbatim(body.tools),
    system: systemLike === undefined ? '' : verbatim(systemLike),
    messages: messagesLike === undefined ? '' : verbatim(messagesLike),
  }

  const segments: Segment[] = []
  let text = ''
  for (const name of SEGMENTS[provider]) {
    segments.push({ name, text: parts[name], start: text.length })
    text += parts[name]
  }

  const marker = text.lastIndexOf('"cache_control"')
  return {
    text,
    segments,
    breakpoints: countBreakpoints(body.tools) + countBreakpoints(body.system) + countBreakpoints(body.messages),
    toolNames: toolNamesOf(body.tools),
    cacheEndsAt: marker === -1 ? undefined : marker,
  }
}

/** The same tool set serialised into different bytes between two requests. Key
 *  order is arbitrary but must be STABLE - a consistently unusual order caches
 *  perfectly well, so comparing a single request against alphabetical order
 *  would flag code that has nothing wrong with it. */
export function toolSerialisationChanged(previous: RequestBody, current: RequestBody): boolean {
  if (previous.tools === undefined || current.tools === undefined) return false
  const sameTools = canonical(previous.tools) === canonical(current.tools)
  return sameTools && verbatim(previous.tools) !== verbatim(current.tools)
}

export interface Divergence {
  /** Byte offset of the first difference within the rendered prefix. */
  offset: number
  segment: SegmentName
  /** Offset within that segment, which is what a person needs to find it. */
  offsetInSegment: number
  before: string
  after: string
}

const CONTEXT = 60

/** The first byte at which two prefixes stop matching. Everything from here on
 *  is a cache miss, so this single offset is the whole diagnosis. */
export function firstDivergence(previous: RenderedPrefix, current: RenderedPrefix): Divergence | undefined {
  const limit = Math.min(previous.text.length, current.text.length)
  let offset = 0
  while (offset < limit && previous.text.charCodeAt(offset) === current.text.charCodeAt(offset)) offset++
  if (offset === limit && previous.text.length === current.text.length) return undefined

  // A prefix that merely grew is not a divergence: appending to the end of the
  // messages array is exactly what a healthy conversation does.
  if (offset === previous.text.length) return undefined

  // Only bytes before the last breakpoint are cached. A new user question sits
  // after it and is SUPPOSED to change every call - reporting that would flag
  // every healthy request ever made.
  if (current.cacheEndsAt === undefined || offset > current.cacheEndsAt) return undefined

  const segment = [...current.segments].reverse().find((candidate) => candidate.start <= offset)
  const home = segment ?? current.segments[0]
  if (!home) throw new Error('Rendered prefix has no segments, which should be impossible.')

  return {
    offset,
    segment: home.name,
    offsetInSegment: offset - home.start,
    before: previous.text.slice(Math.max(0, offset - CONTEXT / 2), offset + CONTEXT),
    after: current.text.slice(Math.max(0, offset - CONTEXT / 2), offset + CONTEXT),
  }
}

/** Requests belong to the same conversation when they open with the same first
 *  message. It is a heuristic, but a first message is stable for a conversation
 *  and cheap to key on. */
export function conversationKey(body: RequestBody): string {
  const conversation = body.messages ?? body.input
  const first = Array.isArray(conversation) ? conversation[0] : conversation
  return createHash('sha256').update(canonical(first ?? null)).digest('hex').slice(0, 16)
}
