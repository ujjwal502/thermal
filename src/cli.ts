#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { detectors } from './detectors/index.ts'
import { defaultRoot, discover } from './sessions/discover.ts'
import { parseSession } from './sessions/parse.ts'
import { print, printError } from './report/terminal.ts'
import { printFinding, printListening, printSummary } from './report/live.ts'
import { Capture } from './proxy/capture.ts'
import { startProxy } from './proxy/server.ts'
import type { Turn } from './types.ts'

const HELP = `
  thermal - find where prompt caching broke and what it cost

  usage: thermal [options]

  commands:
    (none)             analyse session logs already on disk
    proxy              watch live traffic and diff the prefix in real time

  options:
    --root <path>      session directory (default: ~/.claude/projects)
    --port <n>         proxy port (default: 7878)
    --upstream <url>   proxy target (default: https://api.anthropic.com)
    --since <days>     only sessions with activity in the last N days
    --project <name>   limit to one project
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

function runProxy(portText: string | undefined, upstreamText: string | undefined): Promise<number> {
  const port = portText === undefined ? DEFAULT_PORT : Number(portText)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    printError(`--port expects a number between 1 and 65535, got "${portText}".`)
    return Promise.resolve(1)
  }

  const upstream = upstreamText ?? 'https://api.anthropic.com'
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

  const findings = detectors.flatMap((detector) => detector.run(turns))

  print({
    turns,
    findings,
    sessionCount: new Set(turns.map((turn) => turn.sessionId)).size,
    projectCount: new Set(turns.map((turn) => turn.project)).size,
    skippedLines,
    elapsedMs: Date.now() - started,
  })
  return 0
}

try {
  process.exitCode = await main()
} catch (error) {
  printError(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
