import type { Detector, Finding, Turn } from '../types.ts'
import { ttlPremium } from '../pricing.ts'
import { bySession } from './group.ts'

/** The 1h cache costs 2x base input to write; the 5m cache costs 1.25x. A cache
 *  read refreshes the entry's timer on either TTL, so requests sharing a prefix
 *  that start under five minutes apart keep the 5m entry warm indefinitely -
 *  there the 1h TTL buys nothing but the doubled write price.
 *
 *  The window is measured start-to-start and generation time counts against it,
 *  but session logs record no request duration. The threshold below is therefore
 *  held well under five minutes so that unknown generation time cannot flip a
 *  verdict; the cost is under-reporting, which is the right way to be wrong. */
const CONSERVATIVE_GAP = 2 * 60 * 1000

export const ttlPremiumWasted: Detector = {
  id: 'ttl-premium-wasted',
  run(turns: Turn[]): Finding[] {
    let wastedUSD = 0
    let wastedTokens = 0
    let writes = 0
    let justified = 0

    for (const session of bySession(turns).values()) {
      const touching = session.filter(
        (t) => t.cacheReadTokens + t.cacheWrite5mTokens + t.cacheWrite1hTokens > 0,
      )

      for (let i = 0; i < touching.length; i++) {
        const write = touching[i]
        if (!write || write.cacheWrite1hTokens === 0) continue

        const next = touching[i + 1]
        // No following request: the entry's fate is unknowable, so assume the
        // premium was justified rather than bill the user for our ignorance.
        if (!next || next.timestamp.getTime() - write.timestamp.getTime() > CONSERVATIVE_GAP) {
          justified++
          continue
        }

        writes++
        wastedTokens += write.cacheWrite1hTokens
        wastedUSD += ttlPremium(write.cacheWrite1hTokens, write.model)
      }
    }

    if (writes === 0) return []
    return [
      {
        id: 'ttl-premium-wasted',
        severity: 'critical',
        title: '1h cache premium bought nothing',
        wastedTokens,
        wastedUSD,
        occurrences: writes,
        detail: `${writes} writes paid the 1-hour rate with the next request following within two minutes, where a self-refreshing 5m cache would have served it. ${justified} writes may have genuinely needed the longer life.`,
        fix: 'Use the 5m TTL for continuous work. The 1h rate only pays off when requests sharing a prefix start more than five minutes apart.',
      },
    ]
  },
}
