import type { Finding, Turn } from '../types.ts'
import { costOf, unpricedModels } from '../pricing.ts'
import { bold, cold, count, critical, heat, hot, muted, secondary, sparkline, usd } from './format.ts'

export interface ReportInput {
  turns: Turn[]
  findings: Finding[]
  sessionCount: number
  projectCount: number
  skippedLines: number
  elapsedMs: number
}

function dailySpend(turns: Turn[]): number[] {
  const byDay = new Map<string, number>()
  for (const turn of turns) {
    const day = turn.timestamp.toISOString().slice(0, 10)
    byDay.set(day, (byDay.get(day) ?? 0) + costOf(turn))
  }
  return [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([, spend]) => spend)
}

export function render(input: ReportInput): string {
  const { turns, findings } = input
  const spend = turns.reduce((usdTotal, turn) => usdTotal + costOf(turn), 0)
  // Attributed waste only. The theoretical floor (every written token billed as
  // a read) is unreachable - a prefix must be written once before it can be
  // read - so quoting the gap to it would overstate what anyone can recover.
  const attributed = findings.reduce((usdTotal, finding) => usdTotal + finding.wastedUSD, 0)

  const readTokens = turns.reduce((n, t) => n + t.cacheReadTokens, 0)
  const writeTokens = turns.reduce((n, t) => n + t.cacheWrite5mTokens + t.cacheWrite1hTokens, 0)
  const hitRate = readTokens + writeTokens > 0 ? readTokens / (readTokens + writeTokens) : 0

  const out: string[] = []
  const rule = muted('─'.repeat(64))

  out.push('')
  out.push(`${bold('thermal')}  ${muted(`${input.sessionCount} sessions · ${input.projectCount} projects · ${count(turns.length)} requests`)}`)
  out.push(rule)
  out.push('')
  out.push(`  ${bold(usd(spend))} ${secondary('at API rates')}   ${muted('notional - a subscription is billed differently')}`)
  out.push(`  ${bold(usd(attributed))} ${secondary('attributable waste')}   ${muted(`${((attributed / spend) * 100).toFixed(1)}% of the above`)}`)
  out.push('')
  out.push(`  ${heat(hitRate, `${(hitRate * 100).toFixed(1)}%`)} ${secondary('cache hit rate')}   ${cold(count(writeTokens))} ${muted('written')}  ${hot(count(readTokens))} ${muted('read')}`)
  out.push('')
  out.push(`  ${muted('spend')}  ${secondary(sparkline(dailySpend(turns)))}`)
  out.push('')
  out.push(rule)

  if (findings.length === 0) {
    out.push('')
    out.push(`  ${secondary('No findings. Caching on these sessions is behaving.')}`)
    out.push('')
    return out.join('\n')
  }

  out.push(`${bold('FINDINGS')}  ${muted('ranked by cost')}`)
  out.push('')

  for (const finding of [...findings].sort((a, b) => b.wastedUSD - a.wastedUSD)) {
    const tag = finding.severity === 'critical' ? critical('critical') : secondary(finding.severity)
    out.push(`  ${bold(finding.title.padEnd(44))}${bold(usd(finding.wastedUSD).padStart(11))}`)
    out.push(`  ${muted(finding.id)} ${muted('·')} ${tag} ${muted(`· ${finding.occurrences} occurrences · ${count(finding.wastedTokens)} tokens`)}`)
    out.push(`  ${secondary(finding.detail)}`)
    out.push(`  ${muted(finding.fix)}`)
    out.push('')
  }

  out.push(rule)
  const notes = [
    `parsed in ${(input.elapsedMs / 1000).toFixed(1)}s`,
    'detectors may overlap, so the total is an upper bound',
  ]
  if (input.skippedLines > 0) notes.push(`${input.skippedLines} unreadable lines skipped`)
  if (unpricedModels.size > 0) notes.push(`unpriced models excluded: ${[...unpricedModels].join(', ')}`)
  out.push(muted(`  ${notes.join('  ·  ')}`))
  out.push('')
  return out.join('\n')
}

export function print(input: ReportInput): void {
  console.log(render(input))
}

export function printError(message: string): void {
  console.error(`\n  ${critical('thermal')} ${message}\n`)
}
