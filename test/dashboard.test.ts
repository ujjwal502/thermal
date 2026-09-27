import { strict as assert } from 'node:assert'
import { get } from 'node:http'
import { test } from 'node:test'
import { detectors } from '../src/detectors/index.ts'
import { overview, sessionDetail, type Analysis } from '../src/dashboard/model.ts'
import { startDashboard } from '../src/dashboard/server.ts'
import type { Turn } from '../src/types.ts'

const BASE = new Date('2026-09-01T12:00:00').getTime()
const DAY = 24 * 60 * 60 * 1000

function turn(sessionId: string, offsetSeconds: number, fields: Partial<Turn> = {}): Turn {
  return {
    sessionId,
    project: 'api',
    requestId: `${sessionId}-${offsetSeconds}`,
    timestamp: new Date(BASE + offsetSeconds * 1000),
    model: 'claude-opus-5',
    inputTokens: 10,
    cacheReadTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    outputTokens: 100,
    ...fields,
  }
}

// One session on day 1 with a 1h premium wasted and a cache break; a second
// project two days later, leaving a quiet day between them.
const turns: Turn[] = [
  turn('a', 0, { cacheWrite1hTokens: 80_000 }),
  turn('a', 20, { cacheReadTokens: 80_000 }),
  turn('a', 40, { cacheWrite5mTokens: 80_000 }),
  turn('b', (2 * DAY) / 1000, { project: 'web', cacheWrite5mTokens: 20_000 }),
  turn('b', (2 * DAY) / 1000 + 30, { project: 'web', cacheReadTokens: 20_000 }),
  turn('b', (2 * DAY) / 1000 + 60, { project: 'web', cacheReadTokens: 20_000 }),
]
const analysis: Analysis = { root: '/fixtures', turns, elapsedMs: 1, skippedLines: 0 }
const now = BASE + 3 * DAY
const all = { since: null, project: null }

test('every detector blames turns whose waste adds up to its headline figure', () => {
  for (const detector of detectors) {
    for (const finding of detector.run(turns)) {
      const blamed = finding.sites.reduce((usd, site) => usd + site.wastedUSD, 0)
      assert.ok(Math.abs(blamed - finding.wastedUSD) < 1e-9, `${finding.id}: sites sum to ${blamed}, finding says ${finding.wastedUSD}`)
    }
  }
})

test('waste by day and by project agrees with the headline waste', () => {
  const data = overview(analysis, all, now)
  const byDay = data.days.reduce((usd, day) => usd + day.waste, 0)
  const byProject = data.projectRows.reduce((usd, project) => usd + project.waste, 0)
  assert.ok(data.totals.waste > 0)
  assert.ok(Math.abs(byDay - data.totals.waste) < 1e-9)
  assert.ok(Math.abs(byProject - data.totals.waste) < 1e-9)
})

test('a day with no requests is present as a zero, not dropped from the time axis', () => {
  const days = overview(analysis, all, now).days
  assert.deepEqual(days.map((day) => day.requests), [3, 0, 3])
  assert.equal(days[1]?.hitRate, null)
})

test('the project filter scopes totals, findings and sessions together', () => {
  const data = overview(analysis, { since: null, project: 'web' }, now)
  assert.equal(data.totals.requests, 3)
  assert.deepEqual(data.sessions.map((s) => s.id), ['b'])
  assert.deepEqual(data.findings, [])
  assert.deepEqual(data.projects, ['api', 'web'])
})

test('the since filter drops requests older than the window', () => {
  const data = overview(analysis, { since: 1.5, project: null }, now)
  assert.equal(data.totals.requests, 3)
})

test('a session detail marks the turn where the cache broke', () => {
  const detail = sessionDetail(analysis, 'a')
  assert.ok(detail)
  assert.deepEqual(detail.turns.map((t) => t.flags.includes('prefix-invalidated')), [false, false, true])
  assert.equal(detail.turns[0]?.hitRate, 0)
  assert.equal(detail.turns[1]?.hitRate, 1)
})

test('an unknown session id has no detail rather than an empty one', () => {
  assert.equal(sessionDetail(analysis, 'missing'), undefined)
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

async function withDashboard(run: (origin: string) => Promise<void>): Promise<void> {
  let resolveOrigin: (origin: string) => void = () => {}
  const listening = new Promise<string>((resolve) => (resolveOrigin = resolve))
  const dashboard = startDashboard({
    analysis,
    port: 0,
    portIsExplicit: true,
    onListen: (url) => resolveOrigin(url.replace(/\/$/, '')),
    onError: (message) => assert.fail(message),
    onFatal: () => assert.fail('dashboard failed to start'),
  })
  try {
    await run(await listening)
  } finally {
    await dashboard.close()
  }
}

test('the dashboard serves the overview and the page that renders it', async () => {
  await withDashboard(async (origin) => {
    const api = await fetch(`${origin}/api/overview`)
    assert.equal(api.status, 200)
    assert.equal(((await api.json()) as { totals: { requests: number } }).totals.requests, 6)
    const page = await fetch(`${origin}/`)
    assert.match(await page.text(), /<script type="module" src="\.\/app\.js">/)
  })
})

test('the dashboard rejects a bad since value with a reason', async () => {
  await withDashboard(async (origin) => {
    const response = await fetch(`${origin}/api/overview?since=abc`)
    assert.equal(response.status, 400)
    assert.match(((await response.json()) as { error: string }).error, /positive number of days/)
  })
})

test('the dashboard refuses requests addressed to another host name', async () => {
  await withDashboard(async (origin) => {
    assert.equal(await statusWithHost(`${origin}/api/overview`, 'rebind.example'), 403)
  })
})

test('the dashboard serves no file outside its own assets', async () => {
  await withDashboard(async (origin) => {
    for (const path of ['/package.json', '/..%2Fpackage.json', '/fonts/..%2F..%2Fpackage.json', '/src/cli.ts', '//', '//evil.example/x']) {
      assert.equal((await fetch(`${origin}${path}`)).status, 404, path)
    }
  })
})
