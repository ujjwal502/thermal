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

export interface Finding {
  id: string
  severity: 'critical' | 'warning' | 'info'
  title: string
  wastedTokens: number
  wastedUSD: number
  occurrences: number
  detail: string
  fix: string
}

export interface Detector {
  id: string
  run(turns: Turn[]): Finding[]
}
