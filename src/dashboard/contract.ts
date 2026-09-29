// The JSON the local server sends and the browser reads. Types only: this file
// is compiled into both the Node program and the browser program, so it must
// not import anything that exists in only one of them.

type Severity = 'critical' | 'warning' | 'info'

/** Share of cache traffic served by reads: read / (read + write). Null when a
 *  scope touched the cache not at all, which is a different state from 0. */
export type HitRate = number | null

export interface FindingRow {
  id: string
  severity: Severity
  title: string
  wastedUSD: number
  wastedTokens: number
  occurrences: number
  detail: string
  fix: string
}

export interface DayRow {
  day: string
  spend: number
  waste: number
  requests: number
  hitRate: HitRate
}

export interface ProjectRow {
  name: string
  sessions: number
  requests: number
  spend: number
  waste: number
  hitRate: HitRate
}

export interface SessionRow {
  id: string
  project: string
  start: string
  end: string
  requests: number
  spend: number
  waste: number
  hitRate: HitRate
  breaks: number
}

export interface Overview {
  mode: 'read'
  source: string
  filter: { since: number | null; project: string | null }
  projects: string[]
  totals: {
    spend: number
    waste: number
    hitRate: HitRate
    readTokens: number
    writeTokens: number
    requests: number
    sessions: number
  }
  days: DayRow[]
  findings: FindingRow[]
  projectRows: ProjectRow[]
  sessions: SessionRow[]
  notes: { elapsedMs: number; skippedLines: number; unpriced: string[] }
}

export interface TurnRow {
  at: string
  model: string
  input: number
  read: number
  write5m: number
  write1h: number
  output: number
  cost: number
  waste: number
  hitRate: HitRate
  /** Detector ids that blame this turn. */
  flags: string[]
  missReason: string | null
}

export interface SessionDetail {
  id: string
  project: string
  turns: TurnRow[]
}

export type SegmentName = 'tools' | 'system' | 'messages'

export interface Exchange {
  n: number
  at: string
  provider: 'anthropic' | 'openai'
  model: string
  segments: { name: SegmentName; chars: number }[]
  /** Character offset of the last cache breakpoint. Null when none was set. */
  cacheEndsAt: number | null
  promptTokens: number | null
  cachedTokens: number | null
  divergence: {
    offset: number
    segment: SegmentName
    offsetInSegment: number
    reusableUntil: number
    before: string
    after: string
  } | null
  findings: string[]
}

export interface LiveFindingRow {
  id: string
  title: string
  /** Estimated. Null where Thermal cannot price the finding. */
  wastedUSD: number | null
  detail: string
  fix: string
  at: string
  exchange: number | null
}

export interface Live {
  mode: 'proxy'
  /** Null when each request is routed to its provider by path. */
  upstream: string | null
  requests: number
  usage: { withUsage: number; promptTokens: number; cachedTokens: number }
  exchanges: Exchange[]
  findings: LiveFindingRow[]
}
