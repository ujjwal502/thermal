import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { conversationKey, firstDivergence, render, toolSerialisationChanged } from '../src/proxy/prefix.ts'

/** Caching is requested, because only a cached region can be broken. */
const body = (over: Record<string, unknown> = {}) => ({
  system: [{ type: 'text', text: 'You are helpful.', cache_control: { type: 'ephemeral' } }],
  tools: [{ name: 'read', description: 'reads' }],
  messages: [{ role: 'user', content: 'hello' }],
  ...over,
})

test('render orders segments tools, system, messages', () => {
  const prefix = render(body())
  assert.deepEqual(prefix.segments.map((s) => s.name), ['tools', 'system', 'messages'])
  assert.equal(prefix.segments[0]?.start, 0)
})

test('render counts cache_control breakpoints wherever they are nested', () => {
  const prefix = render(
    body({
      system: [{ type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'b', cache_control: { type: 'ephemeral' } }] }],
    }),
  )
  assert.equal(prefix.breakpoints, 2)
})

test('identical requests do not diverge', () => {
  assert.equal(firstDivergence(render(body()), render(body())), undefined)
})

test('appending a message is growth, not divergence', () => {
  const before = render(body())
  const after = render(
    body({ messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }] }),
  )
  assert.equal(firstDivergence(before, after), undefined)
})

test('a changed system prompt is located in the system segment', () => {
  const changed = body({
    system: [{ type: 'text', text: 'You are helpful. 12:04', cache_control: { type: 'ephemeral' } }],
  })
  const divergence = firstDivergence(render(body()), render(changed))
  assert.ok(divergence)
  assert.equal(divergence.segment, 'system')
  assert.ok(divergence.offsetInSegment > 0)
})

test('a changed tool list diverges in the tools segment, before system', () => {
  const divergence = firstDivergence(
    render(body()),
    render(body({ tools: [{ name: 'write', description: 'writes' }] })),
  )
  assert.ok(divergence)
  assert.equal(divergence.segment, 'tools')
})

test('a change AFTER the last breakpoint is not a break - that is the new question', () => {
  const asked = body({ messages: [{ role: 'user', content: 'a different question entirely' }] })
  assert.equal(firstDivergence(render(body()), render(asked)), undefined)
})

test('a request with no caching at all cannot have a cache break', () => {
  const uncached = (text: string) => ({ system: text, messages: [{ role: 'user', content: 'x' }] })
  assert.equal(firstDivergence(render(uncached('one')), render(uncached('two'))), undefined)
})

test('the same tools serialised differently between requests is flagged', () => {
  const first = body({ tools: [{ name: 'read', description: 'd' }] })
  const reordered = body({ tools: [{ description: 'd', name: 'read' }] })
  assert.equal(toolSerialisationChanged(first, reordered), true)
})

test('a stable but unusual key order is not flagged', () => {
  const first = body({ tools: [{ description: 'd', name: 'read' }] })
  assert.equal(toolSerialisationChanged(first, first), false)
})

test('genuinely different tools are not mistaken for a serialisation change', () => {
  const first = body({ tools: [{ name: 'read', description: 'd' }] })
  const other = body({ tools: [{ name: 'write', description: 'd' }] })
  assert.equal(toolSerialisationChanged(first, other), false)
})

test('conversation key survives the conversation growing', () => {
  const start = conversationKey(body())
  const later = conversationKey(
    body({ messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }] }),
  )
  assert.equal(start, later)
})

test('conversation key differs for a different opening message', () => {
  assert.notEqual(conversationKey(body()), conversationKey(body({ messages: [{ role: 'user', content: 'other' }] })))
})

test('a Chat Completions system message renders as the system segment, bytes unchanged', () => {
  const body = { messages: [{ role: 'system', content: 'policy' }, { role: 'user', content: 'question' }] }
  const prefix = render(body, 'openai')
  assert.equal(prefix.segments.find((s) => s.name === 'system')?.text, JSON.stringify(body.messages[0]))
  assert.equal(prefix.text, body.messages.map((m) => JSON.stringify(m)).join(''))
})

test('a change before every breakpoint leaves nothing of the cached prefix reusable', () => {
  const at = (time: string) => render({ system: [{ type: 'text', text: `rules. time ${time}`, cache_control: { type: 'ephemeral' } }], messages: [] })
  assert.equal(firstDivergence(at('10:00'), at('10:01'))?.reusableUntil, 0)
})

test('a change after an earlier breakpoint can still reuse the cache up to it', () => {
  const at = (time: string) =>
    render({
      tools: [{ name: 'read', cache_control: { type: 'ephemeral' } }],
      system: [{ type: 'text', text: `rules. time ${time}`, cache_control: { type: 'ephemeral' } }],
      messages: [],
    })
  const divergence = firstDivergence(at('10:00'), at('10:01'))
  assert.ok(divergence && divergence.reusableUntil > 0)
  assert.equal(divergence.reusableUntil, at('10:00').breakpointsAt[0])
})
