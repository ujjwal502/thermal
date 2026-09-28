import { strict as assert } from 'node:assert'
import { createServer, get, type Server } from 'node:http'
import { after, before, mock, test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Capture } from '../src/proxy/capture.ts'
import { startProxy } from '../src/proxy/server.ts'

let upstream: Server
let upstreamUrl = ''
let proxyUrl = ''
let capture: Capture
let proxy: { close(): Promise<void> }
const errors: string[] = []
let upstreamHits = 0

/** Stands in for the Messages API: echoes what it was sent, and streams when
 *  asked, so the test can prove bytes survive the round trip. */
function stubUpstream(): Promise<Server> {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      upstreamHits++
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        if (body.includes('"stream":true')) {
          response.writeHead(200, { 'content-type': 'text/event-stream' })
          response.write('event: message_start\ndata: {"type":"message_start"}\n\n')
          response.write('event: message_delta\ndata: {"usage":{"output_tokens":7}}\n\n')
          response.end('event: message_stop\ndata: {"type":"message_stop"}\n\n')
          return
        }
        response.writeHead(200, { 'content-type': 'application/json', 'x-echo': 'yes' })
        response.end(JSON.stringify({ received: body.length }))
      })
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

const request = (system: string, extra: Record<string, unknown> = {}) => ({
  model: 'claude-opus-5',
  system,
  tools: [{ name: 'read', description: 'reads' }],
  messages: [{ role: 'user', content: 'hello' }],
  ...extra,
})

before(async () => {
  upstream = await stubUpstream()
  const address = upstream.address()
  if (address === null || typeof address === 'string') throw new Error('stub upstream has no port')
  upstreamUrl = `http://127.0.0.1:${address.port}`

  capture = new Capture()
  const port = 8900 + Math.floor(Math.random() * 90)
  proxyUrl = `http://127.0.0.1:${port}`
  proxy = startProxy({
    port,
    upstream: upstreamUrl,
    capture,
    onListen: () => {},
    onError: (message) => errors.push(message),
    onFatal: () => {},
  })
  await delay(150)
})

after(async () => {
  await proxy.close()
  upstream.close()
})

/** fetch ignores a Host header it is given, so a forged Host needs node:http. */
function statusWithHost(url: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    get(url, { headers: { host } }, (response) => {
      response.resume()
      resolve(response.statusCode ?? 0)
    }).on('error', reject)
  })
}

async function send(body: unknown): Promise<Response> {
  return fetch(`${proxyUrl}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'test-key' },
    body: JSON.stringify(body),
  })
}

test('forwards a request and returns the upstream response untouched', async () => {
  const response = await send(request('You are helpful.'))
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-echo'), 'yes')
  const json = (await response.json()) as { received: number }
  assert.ok(json.received > 0)
})

test('streams a response through without altering it', async () => {
  const response = await send(request('You are helpful.', { stream: true }))
  const text = await response.text()
  assert.match(text, /event: message_start/)
  assert.match(text, /event: message_stop/)
  assert.match(text, /"output_tokens":7/)
})

test('a changed system prompt is reported as a prefix break, with the bytes', async () => {
  const cached = (text: string) => ({
    ...request(''),
    system: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }],
  })
  const fresh = new Capture()
  fresh.observe(cached('You are helpful.'))
  fresh.observe(cached('You are helpful. 12:04:31'))

  const finding = fresh.findings.find((f) => f.id === 'prefix-invalidated')
  assert.ok(finding, 'expected a prefix-invalidated finding')
  assert.match(finding.title, /system/)
  assert.match(finding.detail, /was:/)
  assert.match(finding.detail, /now:/)
})

test('a stable prompt across requests produces no findings', async () => {
  const fresh = new Capture()
  fresh.observe(request('You are helpful.'))
  fresh.observe(request('You are helpful.'))
  assert.deepEqual(fresh.findings, [])
})

test('observed requests are counted and nothing errored', async () => {
  await delay(200)
  assert.ok(capture.requestCount >= 2, `expected requests to be observed, saw ${capture.requestCount}`)
  assert.deepEqual(errors, [])
})

const bigPrompt = 'You are a security scanner. '.repeat(400) // ~2800 tokens

test('a large prompt resent with no caching is flagged on the second sighting', () => {
  const fresh = new Capture()
  fresh.observe(request(bigPrompt))
  assert.equal(fresh.findings.length, 0, 'one sighting is not yet a repeat')

  fresh.observe(request(bigPrompt, { messages: [{ role: 'user', content: 'different question' }] }))
  const finding = fresh.findings.find((f) => f.id === 'cacheable-prefix-uncached')
  assert.ok(finding, 'expected an uncached-prefix finding')
  assert.match(finding.title, /token prompt is being resent uncached/)
})

test('the uncached warning is reported once, not on every repeat', () => {
  const fresh = new Capture()
  for (let i = 0; i < 5; i++) {
    fresh.observe(request(bigPrompt, { messages: [{ role: 'user', content: `q${i}` }] }))
  }
  const hits = fresh.findings.filter((f) => f.id === 'cacheable-prefix-uncached')
  assert.equal(hits.length, 1)
})

test('a prompt that already has a breakpoint is not flagged as uncached', () => {
  const fresh = new Capture()
  const cached = () => ({
    model: 'claude-opus-5',
    system: [{ type: 'text', text: bigPrompt, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: 'hello' }],
  })
  fresh.observe(cached())
  fresh.observe(cached())
  assert.equal(fresh.findings.find((f) => f.id === 'cacheable-prefix-uncached'), undefined)
})

test('a short prompt is not worth caching and is not flagged', () => {
  const fresh = new Capture()
  fresh.observe(request('short'))
  fresh.observe(request('short', { messages: [{ role: 'user', content: 'other' }] }))
  assert.equal(fresh.findings.find((f) => f.id === 'cacheable-prefix-uncached'), undefined)
})

test('the live view is answered by the proxy and never forwarded upstream', async () => {
  const before = upstreamHits
  const page = await fetch(`${proxyUrl}/_thermal/`)
  const live = await fetch(`${proxyUrl}/_thermal/api/live`)
  assert.equal(page.status, 200)
  assert.match(await page.text(), /<title>thermal<\/title>/)
  assert.equal(((await live.json()) as { mode: string }).mode, 'proxy')
  assert.equal(upstreamHits, before)
})

test('the live view refuses requests not addressed to localhost', async () => {
  assert.equal(await statusWithHost(`${proxyUrl}/_thermal/api/live`, 'attacker.example'), 403)
})

test('a prefix break is kept with its exchange so the live view can show where it happened', () => {
  const fresh = new Capture()
  const cached = (text: string) => ({ ...request(''), system: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }] })
  fresh.observe(cached('You are helpful.'))
  const broken = fresh.observe(cached('You are helpful. 12:04:31'))

  const snapshot = fresh.snapshot('https://api.anthropic.com')
  const finding = snapshot.findings.find((f) => f.id === 'prefix-invalidated')
  assert.equal(finding?.exchange, broken.n)
  assert.equal(snapshot.exchanges.find((e) => e.n === broken.n)?.divergence?.segment, 'system')
})

test('a path that looks like another host is still forwarded to the configured upstream', async () => {
  const before = upstreamHits
  const response = await fetch(`${proxyUrl}//elsewhere.example/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'test-key' },
    body: JSON.stringify(request('You are helpful.')),
  })
  assert.equal(response.status, 200)
  assert.equal(upstreamHits, before + 1)
})

// The usage sequence live OpenAI returned for a healthy conversation followed by
// one whose instructions start with a timestamp (gpt-4.1-nano, 2026-09-27).
const healthy = [0, 1280, 1280, 1280, 1280]
const moving = [0, 0, 0, 0, 0]

function replay(cached: number[], capture = new Capture()): Capture {
  for (const tokens of cached) {
    const exchange = capture.observe({ model: 'gpt-4.1-nano', messages: [{ role: 'user', content: 'q' }] }, 'openai')
    capture.observeUsage({ promptTokens: 1465, cachedTokens: tokens }, 'openai', exchange)
  }
  return capture
}

test('a cold first call followed by hits is not reported as automatic caching failing', () => {
  assert.deepEqual(replay(healthy).findings, [])
})

test('misses separated by hits are not counted as a run', () => {
  const capture = replay([...healthy, 0, 0, 1280, 0])
  assert.deepEqual(capture.findings, [])
})

test('three misses in a row after the cache had a chance to warm are reported', () => {
  const capture = replay([...healthy, ...moving])
  const found = capture.findings.filter((f) => f.id === 'automatic-cache-not-landing')
  assert.equal(found.length, 1)
  assert.equal(found[0]?.exchange, 8)
})

test('prompts under the 1024-token OpenAI minimum never count as misses', () => {
  const capture = new Capture()
  for (let i = 0; i < 6; i++) {
    const exchange = capture.observe({ model: 'gpt-4.1-nano', messages: [{ role: 'user', content: 'q' }] }, 'openai')
    capture.observeUsage({ promptTokens: 800, cachedTokens: 0 }, 'openai', exchange)
  }
  assert.deepEqual(capture.findings, [])
})

test('a break in the system prompt names where the changing part should go', () => {
  const fresh = new Capture()
  const cached = (text: string) => ({ ...request(''), system: [{ type: 'text', text, cache_control: { type: 'ephemeral' } }] })
  fresh.observe(cached('You are helpful. 12:04:11'))
  fresh.observe(cached('You are helpful. 12:04:39'))
  const finding = fresh.findings.find((f) => f.id === 'prefix-invalidated')
  assert.match(finding?.fix ?? '', /latest user message, after the last cache breakpoint/)
})

// A support bot that moved its timestamp out of the system prompt and into the
// first message. Each turn appends to the history and moves the breakpoint to
// the newest message, as agents that cache their history do.
const rules = 'You are a support bot. Follow the refund policy exactly. '.repeat(150)

function turnOf(time: string, questions: string[], cacheHistory: boolean) {
  const history = questions.flatMap((q, i) => {
    const last = i === questions.length - 1
    const user = { role: 'user', content: [{ type: 'text', text: q, ...(last && cacheHistory ? { cache_control: { type: 'ephemeral' } } : {}) }] }
    return last ? [user] : [user, { role: 'assistant', content: `answer to ${q}` }]
  })
  return {
    model: 'claude-sonnet-5',
    system: [{ type: 'text', text: rules, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: `Current time: ${time}` }, ...history],
  }
}

test('a timestamp in the first message is caught when the history behind it is cached', () => {
  const capture = new Capture()
  capture.observe(turnOf('18:00:51', ['Where is my refund?'], true))
  capture.observe(turnOf('18:00:53', ['Where is my refund?', 'It has been a week'], true))
  const finding = capture.findings.find((f) => f.id === 'prefix-invalidated')
  assert.ok(finding, 'expected the changed first message to be reported')
  assert.match(finding.title, /messages/)
})

test('a timestamp in the first message costs nothing when only the system prompt is cached', () => {
  const capture = new Capture()
  capture.observe(turnOf('18:00:51', ['Where is my refund?'], false))
  capture.observe(turnOf('18:00:53', ['Where is my refund?', 'It has been a week'], false))
  assert.deepEqual(capture.findings.filter((f) => f.id === 'prefix-invalidated'), [])
})

test('separate conversations sharing a system prompt are not mistaken for a break', () => {
  const capture = new Capture()
  capture.observe(turnOf('09:00:00', ['Where is my refund?', 'It has been a week'], true))
  capture.observe(turnOf('09:05:00', ['How do I change my address?', 'The new one is in Leeds'], true))
  capture.observe(turnOf('09:06:00', ['Can I cancel my order?'], true))
  assert.deepEqual(capture.findings.filter((f) => f.id === 'prefix-invalidated'), [])
})

test('a prefix break is priced as rewriting everything back to the last usable breakpoint', () => {
  const capture = new Capture()
  const at = (time: string) => ({
    model: 'claude-sonnet-5',
    system: [{ type: 'text', text: `${rules}\nCurrent time: ${time}`, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: 'Where is my refund?' }],
  })
  capture.observe(at('18:00:51'))
  const broken = capture.observe(at('18:00:53'))
  capture.observeUsage({ promptTokens: 2246, cachedTokens: 0 }, 'anthropic', broken)

  const cost = capture.findings.find((f) => f.id === 'prefix-invalidated')?.wastedUSD
  // 2246 tokens written at $2.50/M instead of read at $0.20/M, less the
  // uncached question after the breakpoint.
  assert.ok(cost !== null && cost !== undefined && cost > 0.0045 && cost < 0.0052, `cost was ${cost}`)
})

test('a break on a model with no known price has no cost rather than $0', () => {
  const capture = new Capture()
  const at = (time: string) => ({
    model: 'unreleased-model',
    system: [{ type: 'text', text: `${rules}\nCurrent time: ${time}`, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: 'q' }],
  })
  capture.observe(at('1'))
  capture.observe(at('2'))
  const finding = capture.findings.find((f) => f.id === 'prefix-invalidated')
  assert.ok(finding, 'expected the break to be reported')
  assert.equal(finding.wastedUSD, null)
})

test('a prefix break is priced from the tokens the provider says it wrote', () => {
  const capture = new Capture()
  const at = (time: string) => ({
    model: 'claude-sonnet-5',
    system: [{ type: 'text', text: `${rules}\nCurrent time: ${time}`, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: 'Where is my refund?' }],
  })
  capture.observe(at('18:00:51'))
  const broken = capture.observe(at('18:00:53'))
  capture.observeUsage({ promptTokens: 2246, cachedTokens: 0, writtenTokens: 2000 }, 'anthropic', broken)

  // 2000 tokens written at $2.50/M instead of read at $0.20/M.
  const cost = capture.findings.find((f) => f.id === 'prefix-invalidated')?.wastedUSD
  assert.ok(cost !== null && cost !== undefined && Math.abs(cost - 0.0046) < 1e-9, `cost was ${cost}`)
})

test('a tool change that breaks a cached prefix is priced once, on the tool finding', () => {
  const capture = new Capture()
  const withTools = (names: string[]) => ({
    model: 'claude-opus-5',
    tools: names.map((name) => ({ name, description: name })),
    system: [{ type: 'text', text: rules, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: 'hello' }],
  })
  capture.observe(withTools(['read']))
  capture.observe(withTools(['read', 'write']))

  assert.deepEqual(capture.findings.map((f) => f.id), ['tool-set-changed'])
  assert.ok((capture.findings[0]?.wastedUSD ?? 0) > 0)
})

test('an uncached prompt costs more with every repeat', () => {
  const capture = new Capture()
  const send = (i: number) => capture.observe(request(bigPrompt, { messages: [{ role: 'user', content: `q${i}` }] }))
  send(0)
  send(1)
  const finding = capture.findings.find((f) => f.id === 'cacheable-prefix-uncached')
  const afterOneRepeat = finding?.wastedUSD ?? 0
  send(2)
  send(3)
  assert.ok(afterOneRepeat > 0, `cost after one repeat was ${afterOneRepeat}`)
  assert.ok((finding?.wastedUSD ?? 0) > afterOneRepeat * 3)
})

test('a prompt resent only after a 5m cache would have expired is not flagged', () => {
  mock.timers.enable({ apis: ['Date'], now: 0 })
  try {
    const capture = new Capture()
    for (let i = 0; i < 3; i++) {
      capture.observe(request(bigPrompt, { messages: [{ role: 'user', content: `q${i}` }] }))
      mock.timers.tick(6 * 60 * 1000)
    }
    assert.deepEqual(capture.findings, [])
  } finally {
    mock.timers.reset()
  }
})

test('OpenAI misses are priced from what the last hit read, for as long as they run', () => {
  const capture = replay([...healthy, ...moving])
  // Five misses of the 1280 tokens the last hit read, at $0.10/M instead of $0.025/M.
  const cost = capture.findings.find((f) => f.id === 'automatic-cache-not-landing')?.wastedUSD
  assert.ok(cost !== null && cost !== undefined && Math.abs(cost - 0.00048) < 1e-9, `cost was ${cost}`)
})

test('OpenAI misses with no earlier hit are reported without a price', () => {
  const capture = replay(moving)
  const finding = capture.findings.find((f) => f.id === 'automatic-cache-not-landing')
  assert.ok(finding, 'expected the misses to be reported')
  assert.equal(finding.wastedUSD, null)
})
