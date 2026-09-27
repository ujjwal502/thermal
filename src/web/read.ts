import type { FindingRow, Overview, ProjectRow, SessionDetail, SessionRow, TurnRow } from '../dashboard/contract.ts'
import { dailySpend, ribbon, type Cell } from './charts.ts'
import { clock, compact, day, duration, h, heat, pct, rampLegend, stamp, swatch, usd } from './dom.ts'
import { table, type Column } from './table.ts'

export interface Links {
  session(id: string): string
  project(name: string): string
  view(name: string): string
}

const CRITICAL_GLYPH = '▲'

function region(label: string, ...content: Node[]): HTMLElement {
  return h('section', { class: 'region' }, h('h2', { class: 'label' }, label), ...content)
}

/** The one moment the product makes a claim, so the figure settles into place
 *  like a gauge - once per page load, never on a filter change. */
let counted = false

function countUp(element: HTMLElement, target: number): void {
  element.textContent = usd(target)
  if (counted || matchMedia('(prefers-reduced-motion: reduce)').matches) return
  counted = true
  const start = performance.now()
  const tick = (now: number) => {
    const t = Math.min(1, (now - start) / 600)
    element.textContent = usd(target * (1 - (1 - t) ** 3))
    if (t < 1) requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

function stat(label: string, value: Node | string, sub: string): HTMLElement {
  return h('div', { class: 'stat' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), h('div', { class: 'sub' }, sub))
}

function headline(data: Overview): HTMLElement {
  const { totals } = data
  const figure = h('span', { class: 'display', style: `--health: ${heat(totals.hitRate)}` })
  countUp(figure, totals.waste)
  const share = totals.spend > 0 ? totals.waste / totals.spend : 0

  const notes = ['Costs are notional: API list prices, whatever your plan bills.', 'Detectors can overlap, so waste is an upper bound.']
  if (data.notes.unpriced.length > 0) notes.push(`Not priced, so excluded: ${data.notes.unpriced.join(', ')}.`)

  return h(
    'section',
    { class: 'region' },
    h('div', { class: 'label' }, 'Attributable waste'),
    h(
      'div',
      { class: 'headline' },
      figure,
      h(
        'div',
        { class: 'stats' },
        stat('Spend at API rates', usd(totals.spend), `${pct(share)} of it waste`),
        stat('Cache hit rate', h('span', {}, swatch(heat(totals.hitRate)), pct(totals.hitRate)), `${compact(totals.readTokens)} read, ${compact(totals.writeTokens)} written`),
        stat('Requests', compact(totals.requests), `${totals.sessions} sessions`),
      ),
    ),
    h('p', { class: 'caption' }, notes.join(' ')),
  )
}

function daysTable(data: Overview): HTMLElement {
  return table(data.days, [
    { label: 'Day', cell: (d) => day(d.day), sort: (d) => d.day },
    { label: 'Requests', num: true, cell: (d) => compact(d.requests), sort: (d) => d.requests },
    { label: 'Hit rate', num: true, cell: (d) => h('span', {}, swatch(heat(d.hitRate)), pct(d.hitRate)), sort: (d) => d.hitRate ?? -1 },
    { label: 'Spend', num: true, cell: (d) => usd(d.spend), sort: (d) => d.spend },
    { label: 'Waste', num: true, className: 'dollars', cell: (d) => usd(d.waste), sort: (d) => d.waste },
  ], { sortBy: { column: 0, descending: true } })
}

function spendOverTime(data: Overview): HTMLElement {
  const body = h('div')
  let asTable = false
  const toggle = h('button', { class: 'toggle', type: 'button' }, 'show table')
  const legend = h(
    'div',
    { class: 'legend' },
    h('span', {}, swatch('var(--cold-3)'), 'waste'),
    h('span', {}, 'spend, coloured by cache hit rate:'),
    rampLegend(),
  )
  const draw = () => {
    body.replaceChildren(...(asTable ? [daysTable(data)] : [dailySpend(data.days), legend]))
    toggle.textContent = asTable ? 'show chart' : 'show table'
  }
  toggle.addEventListener('click', () => {
    asTable = !asTable
    draw()
  })
  draw()
  return h('section', { class: 'region' }, h('div', { class: 'region-head' }, h('h2', { class: 'label' }, 'Spend by day'), toggle), body)
}

const findingColumns: Column<FindingRow>[] = [
  { label: '', className: 'gutter', cell: (f) => (f.severity === 'critical' ? h('span', { 'aria-hidden': 'true' }, CRITICAL_GLYPH) : '') },
  { label: 'Finding', cell: (f) => h('span', {}, f.title, h('span', { class: 'muted' }, `  ${f.severity}`)) },
  { label: 'Detector', className: 'id', cell: (f) => f.id },
  { label: 'Occurrences', num: true, cell: (f) => compact(f.occurrences), sort: (f) => f.occurrences },
  { label: 'Waste', num: true, className: 'dollars', cell: (f) => usd(f.wastedUSD), sort: (f) => f.wastedUSD },
]

function findingDetail(finding: FindingRow): Node {
  return h('div', {}, h('p', {}, finding.detail), h('p', { class: 'fix' }, finding.fix))
}

function findingsTable(findings: FindingRow[], primary: boolean): HTMLElement {
  if (findings.length === 0) return h('p', { class: 'secondary' }, 'No findings. Caching in this range is behaving.')
  return table(findings, findingColumns, { expand: findingDetail, sortBy: { column: 4, descending: true }, primary })
}

function projectColumns(links: Links): Column<ProjectRow>[] {
  return [
    { label: 'Project', cell: (p) => h('a', { href: links.project(p.name) }, p.name), sort: (p) => p.name },
    { label: 'Sessions', num: true, cell: (p) => p.sessions, sort: (p) => p.sessions },
    { label: 'Requests', num: true, cell: (p) => compact(p.requests), sort: (p) => p.requests },
    { label: 'Hit rate', num: true, cell: (p) => h('span', {}, swatch(heat(p.hitRate)), pct(p.hitRate)), sort: (p) => p.hitRate ?? -1 },
    { label: 'Spend', num: true, cell: (p) => usd(p.spend), sort: (p) => p.spend },
    { label: 'Waste', num: true, className: 'dollars', cell: (p) => usd(p.waste), sort: (p) => p.waste },
  ]
}

const sessionColumns: Column<SessionRow>[] = [
  { label: 'Started', cell: (s) => stamp(s.start), sort: (s) => s.start },
  { label: 'Project', cell: (s) => s.project, sort: (s) => s.project },
  { label: 'Length', num: true, cell: (s) => duration(s.start, s.end), sort: (s) => new Date(s.end).getTime() - new Date(s.start).getTime() },
  { label: 'Requests', num: true, cell: (s) => compact(s.requests), sort: (s) => s.requests },
  { label: 'Breaks', num: true, cell: (s) => (s.breaks > 0 ? s.breaks : h('span', { class: 'muted' }, '0')), sort: (s) => s.breaks },
  { label: 'Hit rate', num: true, cell: (s) => h('span', {}, swatch(heat(s.hitRate)), pct(s.hitRate)), sort: (s) => s.hitRate ?? -1 },
  { label: 'Spend', num: true, cell: (s) => usd(s.spend), sort: (s) => s.spend },
  { label: 'Waste', num: true, className: 'dollars', cell: (s) => usd(s.waste), sort: (s) => s.waste },
]

export function overviewView(data: Overview, links: Links, go: (href: string) => void): Node[] {
  return [
    headline(data),
    spendOverTime(data),
    h(
      'div',
      { class: 'split' },
      region('Findings, by cost', findingsTable(data.findings, true)),
      region('Projects', table(data.projectRows, projectColumns(links), { sortBy: { column: 4, descending: true } })),
    ),
    h(
      'section',
      { class: 'region' },
      h('div', { class: 'region-head' }, h('h2', { class: 'label' }, 'Sessions with the most waste'), h('a', { class: 'secondary', href: links.view('sessions') }, `all ${data.sessions.length} sessions`)),
      table(data.sessions, sessionColumns, { limit: 10, open: (s) => go(links.session(s.id)) }),
    ),
  ]
}

export function findingsView(data: Overview): Node[] {
  return [region(`${data.findings.length} findings`, findingsTable(data.findings, true))]
}

export function projectsView(data: Overview, links: Links, go: (href: string) => void): Node[] {
  return [region(`${data.projectRows.length} projects`, table(data.projectRows, projectColumns(links), { sortBy: { column: 4, descending: true }, primary: true, open: (p) => go(links.project(p.name)) }))]
}

export function sessionsView(data: Overview, links: Links, go: (href: string) => void): Node[] {
  const search = h('input', { type: 'search', placeholder: 'filter by project or id  (/)', 'aria-label': 'Filter sessions' })
  const host = h('div')
  const draw = () => {
    const needle = search.value.trim().toLowerCase()
    const rows = needle ? data.sessions.filter((s) => s.project.toLowerCase().includes(needle) || s.id.includes(needle)) : data.sessions
    host.replaceChildren(table(rows, sessionColumns, { sortBy: { column: 7, descending: true }, primary: true, open: (s) => go(links.session(s.id)) }))
  }
  search.addEventListener('input', draw)
  draw()
  return [h('section', { class: 'region' }, h('div', { class: 'region-head' }, h('h2', { class: 'label' }, `${data.sessions.length} sessions`), search), host)]
}

function cellFor(turn: TurnRow, index: number): Cell {
  return {
    rate: turn.hitRate,
    broke: turn.flags.includes('prefix-invalidated'),
    waste: turn.waste,
    title: `turn ${index + 1}  ${clock(turn.at)}`,
    rows: [
      { label: 'cache hit rate', value: pct(turn.hitRate), color: heat(turn.hitRate) },
      { label: 'cache read', value: compact(turn.read) },
      { label: 'cache write', value: compact(turn.write5m + turn.write1h) },
      { label: 'cost', value: usd(turn.cost) },
      ...(turn.waste > 0 ? [{ label: turn.flags.join(', '), value: usd(turn.waste) }] : []),
    ],
  }
}

const turnColumns: Column<TurnRow & { index: number }>[] = [
  { label: '#', num: true, className: 'muted', cell: (t) => t.index + 1, sort: (t) => t.index },
  { label: 'Time', cell: (t) => clock(t.at), sort: (t) => t.at },
  { label: 'Model', className: 'secondary', cell: (t) => t.model },
  { label: 'Cache read', num: true, cell: (t) => compact(t.read), sort: (t) => t.read },
  { label: 'Write 5m', num: true, cell: (t) => compact(t.write5m), sort: (t) => t.write5m },
  { label: 'Write 1h', num: true, cell: (t) => compact(t.write1h), sort: (t) => t.write1h },
  { label: 'Output', num: true, cell: (t) => compact(t.output), sort: (t) => t.output },
  { label: 'Hit rate', num: true, cell: (t) => h('span', {}, swatch(heat(t.hitRate)), pct(t.hitRate)), sort: (t) => t.hitRate ?? -1 },
  { label: 'Flags', className: 'flag', cell: (t) => [...t.flags, ...(t.missReason ? [`anthropic: ${t.missReason}`] : [])].join(', ') },
  { label: 'Cost', num: true, cell: (t) => usd(t.cost), sort: (t) => t.cost },
  { label: 'Waste', num: true, className: 'dollars', cell: (t) => (t.waste > 0 ? usd(t.waste) : h('span', { class: 'muted' }, '-')), sort: (t) => t.waste },
]

export function sessionView(detail: SessionDetail): Node[] {
  const turns = detail.turns.map((turn, index) => ({ ...turn, index }))
  const first = turns[0]
  const last = turns.at(-1)
  const spend = turns.reduce((n, t) => n + t.cost, 0)
  const waste = turns.reduce((n, t) => n + t.waste, 0)
  const read = turns.reduce((n, t) => n + t.read, 0)
  const written = turns.reduce((n, t) => n + t.write5m + t.write1h, 0)
  const breaks = turns.filter((t) => t.flags.includes('prefix-invalidated')).length
  const host = h('div')

  const showTurn = (index: number) => {
    const row = host.querySelectorAll('tbody tr')[index]
    row?.scrollIntoView({ block: 'center' })
    row?.classList.add('selected')
  }

  host.append(table(turns, turnColumns, { primary: true }))
  return [
    h(
      'section',
      { class: 'region' },
      h('h1', { class: 'heading' }, detail.project),
      h('div', { class: 'muted' }, detail.id),
      h(
        'div',
        { class: 'meta' },
        stat('Started', first ? stamp(first.at) : '-', first && last ? `ran ${duration(first.at, last.at)}` : ''),
        stat('Requests', compact(turns.length), `${breaks} cache ${breaks === 1 ? 'break' : 'breaks'}`),
        stat('Hit rate', h('span', {}, swatch(heat(read + written > 0 ? read / (read + written) : null)), pct(read + written > 0 ? read / (read + written) : null)), `${compact(read)} read`),
        stat('Spend', usd(spend), `${usd(waste)} waste`),
      ),
    ),
    h(
      'section',
      { class: 'region' },
      h('h2', { class: 'label' }, 'Cache state, turn by turn'),
      ribbon(turns.map(cellFor), showTurn),
      h('div', { class: 'legend' }, h('span', {}, 'each cell is one request:'), rampLegend(), h('span', {}, h('span', { style: 'color: var(--critical)' }, '|'), ' cache went cold after being warm')),
    ),
    region('Requests', host),
  ]
}
