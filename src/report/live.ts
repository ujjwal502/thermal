import type { LiveFinding } from '../proxy/capture.ts'
import { bold, critical, muted, secondary } from './format.ts'

export function printListening(url: string, upstream: string): void {
  // The OpenAI SDK's base URL includes the /v1 segment; Anthropic's does not.
  const exportLine = new URL(upstream).hostname.endsWith('openai.com')
    ? `OPENAI_BASE_URL=${url}/v1`
    : `ANTHROPIC_BASE_URL=${url}`
  console.log(`
  ${bold('thermal proxy')} ${muted('listening on')} ${bold(url)}
  ${muted('forwarding to')} ${secondary(upstream)}

  ${secondary('Point your agent at it and keep working:')}
    ${muted('export')} ${exportLine}

  ${muted('Requests pass through untouched. Analysis runs after each response.')}
  ${muted('Nothing is written to disk and nothing leaves this machine.')}
  ${muted('Ctrl-C to stop and see the summary.')}
`)
}

export function printFinding(finding: LiveFinding): void {
  console.log(`  ${critical(finding.id)}  ${bold(finding.title)}`)
  console.log(`      ${secondary(finding.detail)}`)
  console.log(`      ${muted(finding.fix)}\n`)
}

export interface UsageTotals {
  withUsage: number
  promptTokens: number
  cachedTokens: number
}

export function printSummary(findings: LiveFinding[], requests: number, totals: UsageTotals): void {
  const counts = new Map<string, number>()
  for (const finding of findings) counts.set(finding.id, (counts.get(finding.id) ?? 0) + 1)

  console.log(`\n  ${bold('summary')}  ${muted(`${requests} requests observed`)}`)

  // State plainly whether usage was read. A clean report means nothing if the
  // response shape was never understood.
  if (totals.withUsage === 0) {
    console.log(`  ${critical('no usage data was read from any response')}`)
    console.log(`  ${muted('Thermal could not measure caching here - treat a clean result as unknown, not healthy.')}`)
  } else {
    const rate = totals.promptTokens > 0 ? (totals.cachedTokens / totals.promptTokens) * 100 : 0
    console.log(
      `  ${muted(`usage read from ${totals.withUsage} responses · ${rate.toFixed(1)}% of prompt tokens served from cache`)}`,
    )
  }
  if (counts.size === 0) {
    console.log(`  ${secondary('No cache problems seen.')}\n`)
    return
  }
  for (const [id, count] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${bold(String(count).padStart(5))}  ${id}`)
  }
  console.log('')
}
