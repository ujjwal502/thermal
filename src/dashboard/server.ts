import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { overview, sessionDetail, type Analysis, type Filter } from './model.ts'
import { fromLoopback, sendJSON, serveStatic } from './static.ts'

export interface DashboardOptions {
  analysis: Analysis
  port: number
  /** A port the user chose must be honoured or refused. The default may move
   *  to any free port instead, because the alternative is failing to start. */
  portIsExplicit: boolean
  onListen(url: string): void
  onError(message: string): void
  /** Called when the dashboard cannot run at all, so the caller can exit. */
  onFatal(): void
}

function filterFrom(params: URLSearchParams): Filter | string {
  const sinceText = params.get('since')
  const since = sinceText === null || sinceText === '' ? null : Number(sinceText)
  if (since !== null && (!Number.isFinite(since) || since <= 0)) {
    return `since must be a positive number of days, got "${sinceText}"`
  }
  return { since, project: params.get('project') || null }
}

async function handle(request: IncomingMessage, response: ServerResponse, analysis: Analysis): Promise<void> {
  if (!fromLoopback(request)) {
    response.writeHead(403, { 'content-type': 'text/plain' }).end('Thermal only answers requests addressed to localhost.')
    return
  }
  if (request.method !== 'GET') {
    response.writeHead(405, { 'content-type': 'text/plain' }).end('Method not allowed')
    return
  }

  // Prefixed rather than resolved: a path like //x resolves as a new host.
  const url = new URL(`http://localhost${request.url ?? '/'}`)
  const path = url.pathname

  if (path === '/api/mode') return sendJSON(response, 200, { mode: 'read' })

  if (path === '/api/overview') {
    const filter = filterFrom(url.searchParams)
    if (typeof filter === 'string') return sendJSON(response, 400, { error: filter })
    return sendJSON(response, 200, overview(analysis, filter))
  }

  if (path.startsWith('/api/session/')) {
    const id = decodeURIComponent(path.slice('/api/session/'.length))
    const detail = sessionDetail(analysis, id)
    if (!detail) return sendJSON(response, 404, { error: `No session ${id} in ${analysis.root}.` })
    return sendJSON(response, 200, detail)
  }

  await serveStatic(path.slice(1), response)
}

export function startDashboard(options: DashboardOptions): { close(): Promise<void> } {
  const server = createServer((request, response) => {
    handle(request, response, options.analysis).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      options.onError(`dashboard request failed: ${message}`)
      if (!response.headersSent) sendJSON(response, 500, { error: message })
      else response.end()
    })
  })

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE' && !options.portIsExplicit) {
      server.listen(0, '127.0.0.1')
      return
    }
    options.onError(
      error.code === 'EADDRINUSE'
        ? `Port ${options.port} is already in use. Start the dashboard on another with --port, or drop --port to let Thermal pick one.`
        : `Could not start the dashboard: ${error.message}`,
    )
    options.onFatal()
  })

  server.on('listening', () => {
    const { port } = server.address() as AddressInfo
    options.onListen(`http://127.0.0.1:${port}/`)
  })

  server.listen(options.port, '127.0.0.1')

  return {
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  }
}
