#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { parseArgs } from 'node:util'
import { detectors } from './detectors/index.ts'
import { defaultRoot, discover } from './sessions/discover.ts'
import { parseSession } from './sessions/parse.ts'
import { redact, tildify } from './sessions/redact.ts'
import { print, printDashboard, printError } from './report/terminal.ts'
import { printFinding, printListening, printSummary } from './report/live.ts'
import { startDashboard } from './dashboard/server.ts'
import type { Analysis } from './dashboard/model.ts'
import { Capture } from './proxy/capture.ts'
import { startProxy } from './proxy/server.ts'
import type { Turn } from './types.ts'

const HELP = `
  thermal - find where prompt caching broke and what it cost

  usage: thermal [options]

  commands:
    (none)             analyse session logs already on disk, then open the dashboard
    proxy              watch live traffic and diff the prefix in real time

  options:
    --report           print the terminal report only, no dashboard
    --root <path>      session directory (default: ~/.claude/projects)
    --port <n>         dashboard port (default: 7870) or proxy port (default: 7878)
    --upstream <url>   send every proxied request here (default: Anthropic or
                       OpenAI, chosen by each request's API path)
    --since <days>     only sessions with activity in the last N days
    --project <name>   limit to one project
    --redact           replace project names and paths, for screenshots you can share
    --help

  Reads Claude Code session logs. Nothing leaves your machine.
`

/** Files are IO-bound and small enough to hold one at a time; a modest window
 *  keeps the event loop busy without opening 440 descriptors at once. */
const CONCURRENCY = 16

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = []
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      const item = items[index]
      if (item === undefined) continue
      results.push(await fn(item))
    }
  })
  await Promise.all(workers)
  return results
}

/** 7878 is quiet on most machines; 8080 and 8787 collide constantly. */
const DEFAULT_PORT = 7878
const DEFAULT_DASHBOARD_PORT = 7870

function parsePort(text: string | undefined, fallback: number): number | undefined {
  const port = text === undefined ? fallback : Number(text)
  if (Number.isInteger(port) && port >= 1 && port <= 65535) return port
  printError(`--port expects a number between 1 and 65535, got "${text}".`)
  return undefined
}

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]]
  spawn(command, args, { stdio: 'ignore', detached: true })
    .on('error', () => printError(`Could not open a browser. Visit ${url} yourself.`))
    .unref()
}

function serveDashboard(analysis: Analysis, portText: string | undefined): Promise<number> {
  const port = parsePort(portText, DEFAULT_DASHBOARD_PORT)
  if (port === undefined) return Promise.resolve(1)

  return new Promise<number>((resolve) => {
    const dashboard = startDashboard({
      analysis,
      port,
      portIsExplicit: portText !== undefined,
      onListen: (url) => {
        printDashboard(url)
        openBrowser(url)
      },
      onError: (message) => printError(message),
      onFatal: () => resolve(1),
    })
    process.on('SIGINT', () => {
      void dashboard
        .close()
        .catch(() => undefined)
        .then(() => resolve(0))
    })
  })
}

function runProxy(portText: string | undefined, upstreamText: string | undefined): Promise<number> {
  const port = parsePort(portText, DEFAULT_PORT)
  if (port === undefined) return Promise.resolve(1)

  const upstream = upstreamText
  if (upstream !== undefined && !URL.canParse(upstream)) {
    printError(`--upstream expects a full URL such as https://api.openai.com, got "${upstream}".`)
    return Promise.resolve(1)
  }
  const capture = new Capture()

  return new Promise<number>((resolve) => {
    let reported = 0
    let drain: NodeJS.Timeout | undefined

    const stop = (code: number) => {
      if (drain) clearInterval(drain)
      void proxy
        .close()
        .catch(() => undefined)
        .then(() => resolve(code))
    }

    const proxy = startProxy({
      port,
      upstream,
      capture,
      onListen: (url) => printListening(url, upstream),
      onError: (message) => printError(message),
      onFatal: () => stop(1),
    })

    drain = setInterval(() => {
      while (reported < capture.findings.length) {
        const finding = capture.findings[reported++]
        if (finding) printFinding(finding)
      }
    }, 250)

    process.on('SIGINT', () => {
      printSummary(capture.findings, capture.requestCount, capture.totals)
      stop(0)
    })
  })
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    options: {
      root: { type: 'string' },
      since: { type: 'string' },
      project: { type: 'string' },
      port: { type: 'string' },
      upstream: { type: 'string' },
      report: { type: 'boolean' },
      redact: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: true,
  })

  if (values.help) {
    process.stdout.write(HELP)
    return 0
  }

  if (positionals[0] === 'proxy') return runProxy(values.port, values.upstream)

  const started = Date.now()
  const root = values.root ?? defaultRoot()
  let files = await discover(root)

  if (values.project) {
    const wanted = values.project.toLowerCase()
    files = files.filter((file) => file.project.toLowerCase().includes(wanted))
  }
  if (files.length === 0) {
    printError(
      `No session files found in ${root}. Thermal reads Claude Code logs from ` +
        `~/.claude/projects. Use --root to point elsewhere.`,
    )
    return 1
  }

  const parsed = await mapLimit(files, CONCURRENCY, parseSession)
  let turns: Turn[] = parsed.flatMap((result) => result.turns)
  const skippedLines = parsed.reduce((n, result) => n + result.skippedLines, 0)

  if (values.since) {
    const days = Number(values.since)
    if (!Number.isFinite(days) || days <= 0) {
      printError(`--since expects a positive number of days, got "${values.since}".`)
      return 1
    }
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
    turns = turns.filter((turn) => turn.timestamp.getTime() >= cutoff)
  }

  if (turns.length === 0) {
    printError('No requests matched. Try a wider --since window or drop --project.')
    return 1
  }

  if (values.redact) turns = redact(turns)
  const findings = detectors.flatMap((detector) => detector.run(turns))

  const elapsedMs = Date.now() - started
  print({
    turns,
    findings,
    sessionCount: new Set(turns.map((turn) => turn.sessionId)).size,
    projectCount: new Set(turns.map((turn) => turn.project)).size,
    skippedLines,
    elapsedMs,
  })

  // Piped output is being captured by a script, which has no use for a server.
  if (values.report || !process.stdout.isTTY) return 0
  const source = values.redact ? 'project names and paths redacted' : tildify(root)
  return serveDashboard({ source, turns, elapsedMs, skippedLines }, values.port)
}

try {
  process.exitCode = await main()
} catch (error) {
  printError(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
