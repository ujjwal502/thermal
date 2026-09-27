import type { Exchange, Live, LiveFindingRow } from '../dashboard/contract.ts'
import { cacheBoundary, ribbon, xray } from './charts.ts'
import { clock, compact, estimate, h, heat, pct, rampLegend, swatch } from './dom.ts'
import { table } from './table.ts'

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

function servedRate(exchange: Exchange): number | null {
  return exchange.promptTokens ? (exchange.cachedTokens ?? 0) / exchange.promptTokens : null
}

/** Everything the proxy can see before any traffic arrives: how to send some. */
function waiting(live: Live): Node[] {
  const origin = location.origin
  const openai = new URL(live.upstream).hostname.endsWith('openai.com')
  return [
    h(
      'section',
      { class: 'empty' },
      h('h1', { class: 'heading' }, 'No requests yet'),
      h('p', {}, `Thermal is forwarding to ${live.upstream}. Point your agent at this proxy and run it as usual; requests appear here as they pass through.`),
      h('pre', {}, openai ? `export OPENAI_BASE_URL=${origin}/v1` : `export ANTHROPIC_BASE_URL=${origin}`),
    ),
  ]
}

/** The two slices around the first differing byte, with the changed run marked.
 *  Everything before the mark was served from cache; everything from it on was
 *  paid for again. */
function diff(before: string, after: string): HTMLElement {
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let end = 0
  while (end < before.length - start && end < after.length - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++

  const line = (side: string, text: string) =>
    h('div', {}, h('span', { class: 'side' }, side), text.slice(0, start), h('mark', {}, text.slice(start, text.length - end)), text.slice(text.length - end))
  return h('pre', { class: 'diff' }, line('was', before), line('now', after))
}

function inspector(exchange: Exchange | undefined, findings: LiveFindingRow[]): HTMLElement {
  if (!exchange) {
    return h('section', { class: 'region' }, h('h2', { class: 'label' }, 'Request'), h('p', { class: 'secondary' }, 'Select a request or a finding to see its prefix.'))
  }
  const total = exchange.segments.reduce((n, s) => n + s.chars, 0)
  const boundary = cacheBoundary(exchange, total)
  const source =
    exchange.promptTokens && exchange.cachedTokens !== null
      ? `${compact(exchange.cachedTokens)} of ${compact(exchange.promptTokens)} prompt tokens served from cache, as reported by the provider. Widths are characters, so the split is approximate.`
      : exchange.divergence
        ? 'No usage in the response. The split is where this prefix first differs from the previous request.'
        : 'No usage in the response and no prefix change, so cache state is unknown.'

  return h(
    'section',
    { class: 'region' },
    h('h2', { class: 'label' }, `Request ${exchange.n}  ·  ${exchange.provider}  ·  ${exchange.model}`),
    xray(exchange),
    h('div', { class: 'legend' }, h('span', {}, swatch('var(--hot-3)'), 'served from cache'), h('span', {}, swatch('var(--cold-3)'), 'recomputed'), boundary === null ? h('span', {}, swatch('var(--neutral)'), 'unknown') : null),
    h('p', { class: 'caption' }, source),
    ...findings
      .filter((f) => f.exchange === exchange.n)
      .map((f) => h('div', { style: 'margin-top: 16px' }, h('div', {}, h('b', {}, f.title), f.wastedUSD === null ? null : h('b', {}, `  ${estimate(f.wastedUSD)}`), h('span', { class: 'muted' }, `  ${f.id}`)), h('p', { style: 'margin: 4px 0' }, f.detail.split('\n')[0]), h('p', { class: 'fix', style: 'margin: 0' }, f.fix))),
    exchange.divergence ? h('div', { style: 'margin-top: 16px' }, diff(exchange.divergence.before, exchange.divergence.after)) : null,
    h('div', { style: 'margin-top: 16px' },
      table(exchange.segments, [
        { label: 'Segment', cell: (s) => s.name },
        { label: 'Characters', num: true, cell: (s) => compact(s.chars) },
        { label: 'Share', num: true, cell: (s) => pct(total > 0 ? s.chars / total : null) },
      ]),
    ),
    exchange.cacheEndsAt === null && exchange.provider === 'anthropic'
      ? h('p', { class: 'caption' }, 'This request set no cache_control breakpoint, so Anthropic cached none of it.')
      : null,
  )
}

export function liveView(live: Live, selected: number | null, select: (n: number) => void): Node[] {
  if (live.requests === 0) return waiting(live)

  const served = live.usage.promptTokens > 0 ? live.usage.cachedTokens / live.usage.promptTokens : null
  const exchanges = live.exchanges
  const current = exchanges.find((e) => e.n === selected) ?? [...exchanges].reverse().find((e) => e.findings.length > 0) ?? exchanges.at(-1)
  const findings = [...live.findings].reverse()

  const nodes: Node[] = []
  if (live.usage.withUsage === 0) {
    nodes.push(
      h('div', { class: 'notice' }, h('span', { class: 'glyph', 'aria-hidden': 'true' }, '▲'), h('b', {}, 'No usage read from any response. '),
        h('span', { class: 'secondary' }, 'Thermal cannot measure caching here, so treat a clean result as unknown, not healthy.')),
    )
  }

  nodes.push(
    h(
      'section',
      { class: 'region' },
      h('div', { class: 'label' }, 'Prompt tokens served from cache'),
      h('div', { class: 'headline' },
        h('span', { class: 'display', style: `--health: ${heat(served)}` }, pct(served)),
        h('div', { class: 'stats' },
          h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Requests'), h('div', { class: 'value' }, compact(live.requests)), h('div', { class: 'sub' }, `usage read from ${live.usage.withUsage}`)),
          h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Findings'), h('div', { class: 'value' }, String(live.findings.length)), h('div', { class: 'sub' }, plural(new Set(live.findings.map((f) => f.id)).size, 'detector'))),
        ),
      ),
    ),
    h(
      'section',
      { class: 'region' },
      h('h2', { class: 'label' }, `Last ${exchanges.length} requests`),
      ribbon(
        exchanges.map((e) => ({
          rate: servedRate(e),
          broke: e.divergence !== null,
          waste: 0,
          title: `request ${e.n}  ${clock(e.at)}`,
          rows: [
            { label: 'served from cache', value: pct(servedRate(e)), color: heat(servedRate(e)) },
            { label: 'prompt tokens', value: e.promptTokens === null ? '-' : compact(e.promptTokens) },
            ...(e.findings.length > 0 ? [{ label: 'findings', value: e.findings.join(', ') }] : []),
          ],
        })),
        (index) => {
          const exchange = exchanges[index]
          if (exchange) select(exchange.n)
        },
      ),
      h('div', { class: 'legend' }, h('span', {}, 'each cell is one request:'), rampLegend(),
        exchanges.some((e) => e.divergence !== null) ? h('span', {}, h('span', { style: 'color: var(--critical)' }, '|'), ' prefix changed before the last breakpoint') : null),
    ),
    h(
      'div',
      { class: 'split' },
      h('section', { class: 'region' },
        h('h2', { class: 'label' }, 'Findings, newest first'),
        findings.length === 0
          ? h('p', { class: 'secondary' }, 'No cache problems seen yet.')
          : table<LiveFindingRow>(findings, [
              { label: 'Time', className: 'muted', cell: (f) => clock(f.at) },
              { label: 'Finding', cell: (f) => f.title },
              { label: 'Detector', className: 'id', cell: (f) => f.id },
              { label: 'Cost', num: true, className: 'dollars', cell: (f) => (f.wastedUSD === null ? h('span', { class: 'muted' }, '-') : estimate(f.wastedUSD)) },
            ], {
              primary: true,
              selected: (f) => f.exchange === current?.n,
              open: (f) => {
                if (f.exchange !== null) select(f.exchange)
              },
            }),
      ),
      inspector(current, live.findings),
    ),
    h('section', { class: 'region' },
      h('h2', { class: 'label' }, 'Requests'),
      table([...exchanges].reverse(), [
        { label: '#', num: true, className: 'muted', cell: (e) => e.n },
        { label: 'Time', cell: (e) => clock(e.at) },
        { label: 'Provider', className: 'secondary', cell: (e) => e.provider },
        { label: 'Model', className: 'secondary', cell: (e) => e.model },
        { label: 'Prompt tokens', num: true, cell: (e) => (e.promptTokens === null ? '-' : compact(e.promptTokens)) },
        { label: 'From cache', num: true, cell: (e) => h('span', {}, swatch(heat(servedRate(e))), pct(servedRate(e))) },
        { label: 'Findings', className: 'flag', cell: (e) => e.findings.join(', ') },
      ], { open: (e) => select(e.n), selected: (e) => e.n === current?.n }),
    ),
  )
  return nodes
}
