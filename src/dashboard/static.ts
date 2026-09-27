import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'

// This module sits two levels below the package root both as src/dashboard/*.ts
// and as dist/dashboard/*.js, so one relative path works from source and from
// the published package.
const ROOT = fileURLToPath(new URL('../../', import.meta.url))

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  woff2: 'font/woff2',
}

/** Hand-written markup and styles live in web/; the browser code is compiled
 *  TypeScript and lands in dist/web/. Names are matched against a fixed shape
 *  so a request can never walk out of either directory. */
function locate(name: string): string | undefined {
  if (name === '' || name === 'index.html') return `${ROOT}web/index.html`
  if (name === 'style.css') return `${ROOT}web/style.css`
  if (/^fonts\/[a-z0-9-]+\.woff2$/.test(name)) return `${ROOT}web/${name}`
  if (/^[a-z0-9-]+\.js$/.test(name)) return `${ROOT}dist/web/${name}`
  return undefined
}

export async function serveStatic(name: string, response: ServerResponse): Promise<void> {
  const path = locate(name)
  if (!path) {
    response.writeHead(404, { 'content-type': 'text/plain' }).end('Not found')
    return
  }

  let body: Buffer
  try {
    body = await readFile(path)
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause
    const hint = path.includes('/dist/') ? ' The browser code is compiled: run `npm run build` first.' : ''
    response.writeHead(404, { 'content-type': 'text/plain' }).end(`Missing ${path}.${hint}`)
    return
  }

  const extension = path.slice(path.lastIndexOf('.') + 1)
  response.writeHead(200, { 'content-type': TYPES[extension] ?? 'application/octet-stream', 'cache-control': 'no-cache' })
  response.end(body)
}

export function sendJSON(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  response.end(JSON.stringify(value))
}

/** The dashboard serves session data to whatever asks. Browsers stop other
 *  origins from reading it, but DNS rebinding sidesteps that by pointing a
 *  hostile name at 127.0.0.1 - so refuse any request not addressed to loopback. */
export function fromLoopback(request: IncomingMessage): boolean {
  const host = request.headers.host ?? ''
  return /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)
}
