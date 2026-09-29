import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Capture } from './capture.ts'
import type { Provider, RequestBody } from './prefix.ts'
import { extractUsage } from './usage.ts'
import { fromLoopback, sendJSON, serveStatic } from '../dashboard/static.ts'

export interface ProxyOptions {
  port: number
  /** Where every request goes. Undefined routes each one by its API path. */
  upstream: string | undefined
  capture: Capture
  onListen(url: string): void
  onError(message: string): void
  /** Called when the proxy cannot run at all, so the caller can exit cleanly. */
  onFatal(): void
}

/** Hop-by-hop and length headers must not be forwarded: fetch sets its own, and
 *  it decompresses the body, so a copied content-encoding would describe bytes
 *  the client is not receiving. */
const DROP_REQUEST = new Set(['host', 'content-length', 'connection'])
const DROP_RESPONSE = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection'])

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

function forwardHeaders(request: IncomingMessage): Headers {
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || DROP_REQUEST.has(name)) continue
    headers.set(name, Array.isArray(value) ? value.join(', ') : value)
  }
  return headers
}

function providerFor(pathname: string): Provider | undefined {
  if (pathname.endsWith('/messages')) return 'anthropic'
  if (pathname.endsWith('/chat/completions') || pathname.endsWith('/responses')) return 'openai'
  return undefined
}

const PROVIDER_ORIGIN: Record<Provider, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
}

/** The same proxy serves Anthropic and OpenAI clients without a flag. A fixed
 *  default sent OpenAI requests to Anthropic, whose "Invalid Anthropic API Key"
 *  reads as Thermal being broken. Paths neither provider claims go to Anthropic. */
export function upstreamOrigin(pathname: string, configured: string | undefined): string {
  if (configured) return new URL(configured).origin
  return PROVIDER_ORIGIN[providerFor(pathname) ?? 'anthropic']
}

function parseBody(raw: Buffer): RequestBody | undefined {
  if (raw.length === 0) return undefined
  try {
    const parsed: unknown = JSON.parse(raw.toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as RequestBody) : undefined
  } catch {
    return undefined // Not JSON. Forward it anyway; just nothing to analyse.
  }
}

/** The live view is served from the proxy's own port under a path no provider
 *  API uses, so pointing a browser at the proxy needs no second port. */
const LIVE = '/_thermal'

async function serveLive(request: IncomingMessage, response: ServerResponse, options: ProxyOptions, path: string): Promise<void> {
  if (!fromLoopback(request)) {
    response.writeHead(403, { 'content-type': 'text/plain' }).end('Thermal only answers requests addressed to localhost.')
    return
  }
  if (path === LIVE) {
    response.writeHead(301, { location: `${LIVE}/` }).end()
    return
  }
  const name = path.slice(LIVE.length + 1)
  if (name === 'api/mode') return sendJSON(response, 200, { mode: 'proxy' })
  if (name === 'api/live') return sendJSON(response, 200, options.capture.snapshot(options.upstream ?? null))
  await serveStatic(name, response)
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  options: ProxyOptions,
): Promise<void> {
  const pathname = new URL(`http://localhost${request.url ?? '/'}`).pathname
  if (pathname === LIVE || pathname.startsWith(`${LIVE}/`)) return serveLive(request, response, options, pathname)

  const raw = await readBody(request)
  // Resolving the path against the upstream would let //other.host/... replace
  // the host, sending the caller's API key somewhere they never configured.
  const target = new URL(`${upstreamOrigin(pathname, options.upstream)}${request.url ?? '/'}`)

  const upstream = await fetch(target, {
    method: request.method,
    headers: forwardHeaders(request),
    body: raw.length > 0 ? raw : undefined,
    redirect: 'manual',
  })

  const headers: Record<string, string> = {}
  upstream.headers.forEach((value, name) => {
    if (!DROP_RESPONSE.has(name.toLowerCase())) headers[name] = value
  })
  response.writeHead(upstream.status, headers)

  // Stream straight through, keeping a copy for analysis afterwards. The client
  // is never made to wait on the copy.
  const seen: Buffer[] = []
  if (upstream.body) {
    const reader = upstream.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      response.write(value)
      seen.push(Buffer.from(value))
    }
  }
  response.end()

  const provider = request.method === 'POST' ? providerFor(target.pathname) : undefined
  if (!provider) return
  const body = parseBody(raw)
  if (!body) return

  // Off the hot path: the response is already delivered.
  setImmediate(() => {
    try {
      const exchange = options.capture.observe(body, provider)
      const usage = extractUsage(Buffer.concat(seen).toString('utf8'), provider)
      if (usage) options.capture.observeUsage(usage, provider, exchange)
    } catch (error) {
      options.onError(`analysis failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}

export function startProxy(options: ProxyOptions): { close(): Promise<void> } {
  const server = createServer((request, response) => {
    handle(request, response, options).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      options.onError(message)
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { type: 'thermal_proxy_error', message } }))
    })
  })

  // A failed listen arrives as an 'error' event, which is fatal if unhandled.
  // Port collisions are the common case and deserve an instruction, not a trace.
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      options.onError(
        `Port ${options.port} is already in use by another program. ` +
          `Start Thermal on a free one with --port, for example --port ${options.port + 1}.`,
      )
    } else if (error.code === 'EACCES') {
      options.onError(`Not allowed to listen on port ${options.port}. Ports below 1024 need elevated privileges; pick a higher one with --port.`)
    } else {
      options.onError(`Could not start the proxy: ${error.message}`)
    }
    options.onFatal()
  })

  server.listen(options.port, '127.0.0.1', () => {
    options.onListen(`http://127.0.0.1:${options.port}`)
  })

  return {
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  }
}
