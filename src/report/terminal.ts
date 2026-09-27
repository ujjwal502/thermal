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

/** Breaks prose at spaces so a long detail keeps its indent instead of being
 *  cut mid-word by the terminal. Each line is painted separately by the caller,
 *  so colour never spills across a break. */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line)
      line = word
    } else {
      line = line ? `${line} ${word}` : word
    }
  }
  if (line) lines.push(line)
  return lines
}

/** Wide enough for the findings table, narrow enough to read in one sweep. */
const MAX_WIDTH = 100

export function render(input: ReportInput, width = 80): string {
  const indented = (text: string, paint: (line: string) => string) =>
    wrap(text, width - 2).map((line) => `  ${paint(line)}`)

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
    out.push(...indented(finding.detail, secondary))
    out.push(...indented(finding.fix, muted))
    out.push('')
  }

  out.push(rule)
  const notes = [
    `parsed in ${(input.elapsedMs / 1000).toFixed(1)}s`,
    'detectors may overlap, so the total is an upper bound',
  ]
  if (input.skippedLines > 0) notes.push(`${input.skippedLines} unreadable lines skipped`)
  if (unpricedModels.size > 0) notes.push(`unpriced models excluded: ${[...unpricedModels].join(', ')}`)
  out.push(...indented(notes.join('  ·  '), muted))
  out.push('')
  return out.join('\n')
}

export function print(input: ReportInput): void {
  console.log(render(input, Math.min(process.stdout.columns || 80, MAX_WIDTH)))
}

export function printDashboard(url: string): void {
  console.log(`  ${bold('dashboard')}  ${url}   ${muted('Ctrl-C to stop')}\n`)
}

export function printError(message: string): void {
  console.error(`\n  ${critical('thermal')} ${message}\n`)
}
