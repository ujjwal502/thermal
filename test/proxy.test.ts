import { strict as assert } from 'node:assert'
import { createServer, get, type Server } from 'node:http'
import { after, before, test } from 'node:test'
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
