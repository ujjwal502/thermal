import type { Detector, Finding, Turn } from '../types.ts'
import { writeCost } from '../pricing.ts'
import { bySession } from './group.ts'

/** A turn that reads nothing and rewrites the cache, immediately after a turn
 *  that did read, means the prefix changed between the two.
 *
 *  Logs record token counts, not request bodies, so this locates WHEN the
 *  prefix broke and never WHY. Naming the byte needs proxy mode. */
export const prefixInvalidated: Detector = {
  id: 'prefix-invalidated',
  run(turns: Turn[]): Finding[] {
    let breaks = 0
    let rewriteCost = 0
    let rewriteTokens = 0
    const reasons = new Map<string, number>()

    for (const session of bySession(turns).values()) {
      for (let i = 1; i < session.length; i++) {
        const previous = session[i - 1]
        const current = session[i]
        if (!previous || !current) continue
        const rewrote = current.cacheWrite5mTokens + current.cacheWrite1hTokens
        if (previous.cacheReadTokens === 0 || current.cacheReadTokens > 0 || rewrote === 0) continue

        breaks++
        rewriteTokens += rewrote
        rewriteCost += writeCost(current)
        if (current.cacheMissReason) {
          reasons.set(current.cacheMissReason, (reasons.get(current.cacheMissReason) ?? 0) + 1)
        }
      }
    }

    if (breaks === 0) return []
    const attributed = [...reasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, n]) => `${reason} x${n}`)
      .join(', ')

    return [
      {
        id: 'prefix-invalidated',
        severity: 'critical',
        title: 'Prefix invalidated mid-session',
        wastedTokens: rewriteTokens,
        wastedUSD: rewriteCost,
        occurrences: breaks,
        detail:
          `${breaks} times a warm cache went cold and was rebuilt from scratch.` +
          (attributed ? ` Anthropic attributed some of these: ${attributed}.` : ''),
        fix: 'Logs hold token counts, not request bodies, so Thermal can say when this happened but not which byte caused it. Proxy mode will diff the prefix.',
      },
    ]
  },
}
