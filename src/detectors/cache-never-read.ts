import type { Detector, Finding, Site, Turn } from '../types.ts'
import { writeCost } from '../pricing.ts'
import { bySession } from './group.ts'

/** A session that writes to cache and never reads from it paid the write
 *  premium for nothing. A single-turn session is excluded: it cannot read a
 *  cache it is in the middle of creating. */
export const cacheNeverRead: Detector = {
  id: 'cache-never-read',
  run(turns: Turn[]): Finding[] {
    let wastedUSD = 0
    let wastedTokens = 0
    let sessions = 0
    const sites: Site[] = []

    for (const session of bySession(turns).values()) {
      if (session.length < 2) continue
      const written = session.reduce((n, t) => n + t.cacheWrite5mTokens + t.cacheWrite1hTokens, 0)
      const read = session.reduce((n, t) => n + t.cacheReadTokens, 0)
      if (written === 0 || read > 0) continue

      sessions++
      wastedTokens += written
      for (const t of session) {
        const cost = writeCost(t)
        if (cost === 0) continue
        wastedUSD += cost
        sites.push({ turn: t, wastedUSD: cost })
      }
    }

    if (sessions === 0) return []
    return [
      {
        id: 'cache-never-read',
        severity: 'critical',
        title: 'Cache written but never read',
        wastedTokens,
        wastedUSD,
        occurrences: sessions,
        detail: `${sessions} sessions paid to write a cache and never read from it once.`,
        fix: 'The prefix is changing on every call. Look for a timestamp, a counter, or a varying tool list ahead of the last cache breakpoint.',
        sites,
      },
    ]
  },
}
