export interface Turn {
  sessionId: string
  project: string
  requestId: string
  timestamp: Date
  model: string
  inputTokens: number
  cacheReadTokens: number
  cacheWrite5mTokens: number
  cacheWrite1hTokens: number
  outputTokens: number
  /** Present on roughly 1% of turns - Anthropic only populates it sometimes. */
  cacheMissReason?: string
}

/** One turn a finding blames, and its share of the waste. The terminal report
 *  only needs totals; the dashboard needs these to place waste in time and to
 *  mark the turn where a cache broke. */
export interface Site {
  turn: Turn
  wastedUSD: number
}

export interface Finding {
  id: string
  severity: 'critical' | 'warning' | 'info'
  title: string
  wastedTokens: number
  wastedUSD: number
  occurrences: number
  detail: string
  fix: string
  sites: Site[]
}

export interface Detector {
  id: string
  run(turns: Turn[]): Finding[]
}
