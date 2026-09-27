import { detectors } from '../detectors/index.ts'
import { bySession } from '../detectors/group.ts'
import { costOf, unpricedModels } from '../pricing.ts'
import type { Finding, Turn } from '../types.ts'
import type { FindingRow, HitRate, Overview, SessionDetail, SessionRow } from './contract.ts'

export interface Analysis {
  root: string
  turns: Turn[]
  elapsedMs: number
  skippedLines: number
}

export interface Filter {
  since: number | null
  project: string | null
}

export function hitRate(read: number, write: number): HitRate {
  return read + write === 0 ? null : read / (read + write)
}

class Tally {
  spend = 0
  waste = 0
  requests = 0
  read = 0
  write = 0

  add(turn: Turn, waste: number): void {
    this.spend += costOf(turn)
    this.waste += waste
    this.requests++
    this.read += turn.cacheReadTokens
    this.write += turn.cacheWrite5mTokens + turn.cacheWrite1hTokens
  }

  get hitRate(): HitRate {
    return hitRate(this.read, this.write)
  }
}

/** Local calendar day. The dashboard runs on the machine that made the
 *  requests, so its timezone is the one the user thinks in. */
function dayOf(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

/** Every calendar day from the first seen to the last, so a quiet day shows as
 *  an empty column rather than silently closing the gap in the time axis. */
function calendar(seen: Iterable<string>): string[] {
  const sorted = [...seen].sort()
  const first = sorted[0]
  const last = sorted.at(-1)
  if (!first || !last) return []
  const days: string[] = []
  for (const date = new Date(`${first}T12:00:00`); dayOf(date) <= last; date.setDate(date.getDate() + 1)) {
    days.push(dayOf(date))
  }
  return days
}

function select(turns: Turn[], filter: Filter, now: number): Turn[] {
  const cutoff = filter.since === null ? -Infinity : now - filter.since * 24 * 60 * 60 * 1000
  return turns.filter(
    (turn) =>
      turn.timestamp.getTime() >= cutoff && (filter.project === null || turn.project === filter.project),
  )
}

function blame(findings: Finding[]): { waste: Map<Turn, number>; flags: Map<Turn, Set<string>> } {
  const waste = new Map<Turn, number>()
  const flags = new Map<Turn, Set<string>>()
  for (const finding of findings) {
    for (const site of finding.sites) {
      waste.set(site.turn, (waste.get(site.turn) ?? 0) + site.wastedUSD)
      const ids = flags.get(site.turn) ?? new Set<string>()
      ids.add(finding.id)
      flags.set(site.turn, ids)
    }
  }
  return { waste, flags }
}

function row({ sites: _, ...finding }: Finding): FindingRow {
  return finding
}

export function overview(analysis: Analysis, filter: Filter, now = Date.now()): Overview {
  const turns = select(analysis.turns, filter, now)
  const findings = detectors.flatMap((detector) => detector.run(turns))
  const { waste, flags } = blame(findings)

  const total = new Tally()
  const days = new Map<string, Tally>()
  const projects = new Map<string, Tally & { sessions: Set<string> }>()

  for (const turn of turns) {
    const turnWaste = waste.get(turn) ?? 0
    total.add(turn, turnWaste)

    const day = dayOf(turn.timestamp)
    const dayTally = days.get(day) ?? new Tally()
    dayTally.add(turn, turnWaste)
    days.set(day, dayTally)

    const project = projects.get(turn.project) ?? Object.assign(new Tally(), { sessions: new Set<string>() })
    project.add(turn, turnWaste)
    project.sessions.add(turn.sessionId)
    projects.set(turn.project, project)
  }

  const sessions: SessionRow[] = []
  for (const [id, session] of bySession(turns)) {
    const tally = new Tally()
    let breaks = 0
    for (const turn of session) {
      tally.add(turn, waste.get(turn) ?? 0)
      if (flags.get(turn)?.has('prefix-invalidated')) breaks++
    }
    const first = session[0]
    const last = session.at(-1)
    if (!first || !last) continue
    sessions.push({
      id,
      project: first.project,
      start: first.timestamp.toISOString(),
      end: last.timestamp.toISOString(),
      requests: tally.requests,
      spend: tally.spend,
      waste: tally.waste,
      hitRate: tally.hitRate,
      breaks,
    })
  }

  return {
    mode: 'read',
    root: analysis.root,
    filter,
    projects: [...new Set(analysis.turns.map((turn) => turn.project))].sort(),
    totals: {
      spend: total.spend,
      // The detector totals, not the per-turn sum: identical by construction,
      // and this is the figure the terminal report prints.
      waste: findings.reduce((usd, finding) => usd + finding.wastedUSD, 0),
      hitRate: total.hitRate,
      readTokens: total.read,
      writeTokens: total.write,
      requests: total.requests,
      sessions: sessions.length,
    },
    days: calendar(days.keys()).map((day) => {
      const tally = days.get(day) ?? new Tally()
      return { day, spend: tally.spend, waste: tally.waste, requests: tally.requests, hitRate: tally.hitRate }
    }),
    findings: findings.map(row).sort((a, b) => b.wastedUSD - a.wastedUSD),
    projectRows: [...projects]
      .map(([name, tally]) => ({
        name,
        sessions: tally.sessions.size,
        requests: tally.requests,
        spend: tally.spend,
        waste: tally.waste,
        hitRate: tally.hitRate,
      }))
      .sort((a, b) => b.spend - a.spend),
    sessions: sessions.sort((a, b) => b.waste - a.waste || b.spend - a.spend),
    notes: {
      elapsedMs: analysis.elapsedMs,
      skippedLines: analysis.skippedLines,
      unpriced: [...unpricedModels],
    },
  }
}

/** Every detector groups by session, so running them on one session's turns
 *  gives the same verdicts as the full run, restricted to that session. */
export function sessionDetail(analysis: Analysis, id: string): SessionDetail | undefined {
  const turns = analysis.turns.filter((turn) => turn.sessionId === id)
  const first = turns[0]
  if (!first) return undefined

  const { waste, flags } = blame(detectors.flatMap((detector) => detector.run(turns)))
  return {
    id,
    project: first.project,
    turns: turns.map((turn) => ({
      at: turn.timestamp.toISOString(),
      model: turn.model,
      input: turn.inputTokens,
      read: turn.cacheReadTokens,
      write5m: turn.cacheWrite5mTokens,
      write1h: turn.cacheWrite1hTokens,
      output: turn.outputTokens,
      cost: costOf(turn),
      waste: waste.get(turn) ?? 0,
      hitRate: hitRate(turn.cacheReadTokens, turn.cacheWrite5mTokens + turn.cacheWrite1hTokens),
      flags: [...(flags.get(turn) ?? [])],
      missReason: turn.cacheMissReason ?? null,
    })),
  }
}
