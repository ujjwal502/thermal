import type { Detector, Finding, Turn } from '../types.ts'
import { readSavings, writeCost } from '../pricing.ts'
import { bySession } from './group.ts'

/** Caching is a bet: pay a write premium now, recover it on later reads. A
 *  session whose reads never cover its writes lost the bet. Sessions that read
 *  nothing at all belong to cache-never-read and are left to it. */
export const cachingNetNegative: Detector = {
  id: 'caching-net-negative',
  run(turns: Turn[]): Finding[] {
    let net = 0
    let sessions = 0
    let tokens = 0

    for (const session of bySession(turns).values()) {
      const read = session.reduce((n, t) => n + t.cacheReadTokens, 0)
      if (read === 0) continue

      const written = session.reduce((usd, t) => usd + writeCost(t), 0)
      const saved = session.reduce((usd, t) => usd + readSavings(t.cacheReadTokens, t.model), 0)
      if (written <= saved) continue

      sessions++
      net += written - saved
      tokens += session.reduce((n, t) => n + t.cacheWrite5mTokens + t.cacheWrite1hTokens, 0)
    }

    if (sessions === 0) return []
    return [
      {
        id: 'caching-net-negative',
        severity: 'warning',
        title: 'Caching cost more than it saved',
        wastedTokens: tokens,
        wastedUSD: net,
        occurrences: sessions,
        detail: `${sessions} sessions spent more on cache writes than their reads ever recovered.`,
        fix: 'These sessions are too short or too volatile to amortise a write. Cache fewer breakpoints, or none, for this shape of work.',
      },
    ]
  },
}
