import type { DayRow, Exchange, HitRate } from '../dashboard/contract.ts'
import { day, compact, heat, hideTip, h, pct, showTip, svg, usd, type TipRow } from './dom.ts'

/** Draws at the container's real width and redraws when it changes, so the
 *  charts fill their housing at any window size without scaling their text. */
function responsive(height: number, draw: (width: number) => SVGElement[]): HTMLElement {
  const host = h('div', { class: 'chart' })
  let drawn = 0
  new ResizeObserver(([entry]) => {
    const width = Math.floor(entry?.contentRect.width ?? 0)
    if (width === 0 || width === drawn) return
    drawn = width
    host.replaceChildren(svg('svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img' }, ...draw(width)))
  }).observe(host)
  host.addEventListener('pointerleave', hideTip)
  return host
}

/** A column with a 4px rounded data end and a square foot on the baseline. */
function column(x: number, y: number, width: number, height: number, rounded: boolean): string {
  const r = rounded ? Math.min(4, width / 2, height) : 0
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`
}

function niceStep(max: number, ticks: number): number {
  const raw = max / ticks
  const magnitude = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((candidate) => candidate >= raw)
  return step ?? raw
}

const AXIS_WIDTH = 56
const AXIS_HEIGHT = 24

export function dailySpend(days: DayRow[]): HTMLElement {
  const height = 200
  const plot = height - AXIS_HEIGHT

  return responsive(height, (width) => {
    const peak = Math.max(...days.map((d) => d.spend), 0)
    const step = niceStep(peak || 1, 3)
    const top = Math.ceil((peak || 1) / step) * step
    const y = (value: number) => plot - (value / top) * (plot - 8)
    const band = (width - AXIS_WIDTH) / Math.max(days.length, 1)
    const barWidth = Math.max(1, Math.min(24, band - 2))
    const marks: SVGElement[] = []

    for (let tick = 0; tick <= top + step / 2; tick += step) {
      marks.push(
        svg('g', { class: tick === 0 ? 'axis' : 'grid' },
          svg('line', { x1: AXIS_WIDTH, x2: width, y1: y(tick), y2: y(tick) }),
          svg('text', { x: AXIS_WIDTH - 8, y: y(tick) + 4, 'text-anchor': 'end' }, tick >= 1000 ? `$${compact(tick)}` : `$${tick}`),
        ),
      )
    }

    const labelEvery = Math.ceil(days.length / Math.max(1, Math.floor((width - AXIS_WIDTH) / 72)))
    days.forEach((d, i) => {
      const x = AXIS_WIDTH + i * band + (band - barWidth) / 2
      const waste = Math.min(d.waste, d.spend)
      const rest = d.spend - waste
      const wasteTop = y(waste)
      const gap = waste > 0 && rest > 0 ? 2 : 0
      const group = svg('g', { class: 'mark' })

      if (waste > 0) {
        group.append(svg('path', { d: column(x, wasteTop, barWidth, plot - wasteTop, rest === 0), fill: 'var(--cold-3)' }))
      }
      if (rest > 0) {
        const restTop = y(d.spend)
        const restHeight = Math.max(0, wasteTop - gap - restTop)
        if (restHeight > 0) group.append(svg('path', { d: column(x, restTop, barWidth, restHeight, true), fill: heat(d.hitRate) }))
      }

      // The hit target is the whole band, full height: nobody should have to
      // land on a 2px sliver to read a quiet day.
      const hit = svg('rect', { x: AXIS_WIDTH + i * band, y: 0, width: band, height: plot, fill: 'transparent' })
      hit.addEventListener('pointermove', (event) => {
        group.classList.add('active')
        showTip(event.clientX, event.clientY, day(d.day), [
          { label: 'spend', value: usd(d.spend), color: heat(d.hitRate) },
          { label: 'waste', value: usd(d.waste), color: 'var(--cold-3)' },
          { label: 'cache hit rate', value: pct(d.hitRate) },
          { label: 'requests', value: compact(d.requests) },
        ])
      })
      hit.addEventListener('pointerleave', () => group.classList.remove('active'))
      marks.push(group, hit)

      if (i % labelEvery === 0) {
        marks.push(svg('text', { x: x + barWidth / 2, y: height - 6, 'text-anchor': 'middle' }, day(d.day)))
      }
    })
    return marks
  })
}

export interface Cell {
  rate: HitRate
  broke: boolean
  waste: number
  title: string
  rows: TipRow[]
}

/** One cell per turn, coloured by that turn's cache state. When a session has
 *  more turns than pixels, neighbouring turns share a column and the column
 *  shows the worst of them - a break must never be averaged away. */
export function ribbon(cells: Cell[], onPick?: (index: number) => void): HTMLElement {
  const height = 64
  const top = 20
  const tall = 32

  return responsive(height, (width) => {
    const columns = Math.min(cells.length, Math.floor(width / 3))
    const per = cells.length / columns
    const slot = width / columns
    const gap = slot >= 8 ? 2 : 0
    const marks: SVGElement[] = []
    let worstBreak: { x: number; waste: number } | undefined

    for (let c = 0; c < columns; c++) {
      const from = Math.floor(c * per)
      const group = cells.slice(from, Math.max(from + 1, Math.floor((c + 1) * per)))
      const rates = group.map((cell) => cell.rate).filter((rate): rate is number => rate !== null)
      const rate = rates.length === 0 ? null : Math.min(...rates)
      const broke = group.some((cell) => cell.broke)
      const x = c * slot

      const mark = svg('rect', { class: 'mark', x, y: top, width: Math.max(1, slot - gap), height: tall, fill: heat(rate) })
      marks.push(mark)

      if (broke) {
        const waste = group.reduce((usdTotal, cell) => usdTotal + cell.waste, 0)
        marks.push(svg('line', { x1: x, x2: x, y1: top - 6, y2: top + tall + 6, stroke: 'var(--critical)', 'stroke-width': 1, 'shape-rendering': 'crispEdges' }))
        if (!worstBreak || waste > worstBreak.waste) worstBreak = { x, waste }
      }

      const hit = svg('rect', { x, y: 0, width: slot, height, fill: 'transparent' })
      const first = group[0]
      hit.addEventListener('pointermove', (event) => {
        mark.classList.add('active')
        if (!first) return
        const title = group.length > 1 ? `turns ${from + 1}-${from + group.length}, worst shown` : first.title
        showTip(event.clientX, event.clientY, title, first.rows)
      })
      hit.addEventListener('pointerleave', () => mark.classList.remove('active'))
      if (onPick) hit.addEventListener('click', () => onPick(from))
      marks.push(hit)
    }

    if (worstBreak) {
      const anchor = worstBreak.x > width - 200 ? 'end' : 'start'
      const x = anchor === 'end' ? worstBreak.x - 6 : worstBreak.x + 6
      marks.push(svg('text', { x, y: 12, 'text-anchor': anchor, style: 'fill: var(--text-secondary)' }, worstBreak.waste > 0 ? `cache broke here, ${usd(worstBreak.waste)} to rebuild` : 'cache broke here'))
    }
    return marks
  })
}

/** Where, in characters, this request stopped being served from cache. Usage
 *  is ground truth when the response carried it; otherwise the prefix diff is
 *  the best evidence; with neither, the state is unknown and drawn neutral. */
export function cacheBoundary(exchange: Exchange, total: number): number | null {
  if (exchange.promptTokens && exchange.cachedTokens !== null) {
    return Math.round((total * exchange.cachedTokens) / exchange.promptTokens)
  }
  return exchange.divergence ? exchange.divergence.reusableUntil : null
}

/** The request as one bar in render order - tools, system, messages - each
 *  segment sized by its bytes and split into hot (served from cache) and cold
 *  (recomputed). The signature view: it shows where the money went. */
export function xray(exchange: Exchange): HTMLElement {
  const height = 72
  const top = 20
  const tall = 32
  const total = exchange.segments.reduce((n, segment) => n + segment.chars, 0)
  const boundary = cacheBoundary(exchange, total)

  return responsive(height, (width) => {
    const present = exchange.segments.filter((segment) => segment.chars > 0)
    const usable = width - 2 * (present.length - 1)
    const scale = (chars: number) => (chars / Math.max(total, 1)) * usable
    const marks: SVGElement[] = []
    let x = 0
    let start = 0

    for (const segment of present) {
      const w = scale(segment.chars)
      const end = start + segment.chars
      const hotChars = boundary === null ? 0 : Math.max(0, Math.min(end, boundary) - start)
      const hotWidth = scale(hotChars)
      const fill = boundary === null ? 'var(--neutral)' : 'var(--cold-3)'

      const rows: TipRow[] = [
        { label: 'characters', value: compact(segment.chars) },
        { label: 'share of prompt', value: pct(segment.chars / Math.max(total, 1)) },
      ]
      if (boundary !== null) rows.push({ label: 'served from cache', value: pct(hotChars / segment.chars) })
      const group = svg('g', { class: 'mark' },
        svg('rect', { x, y: top, width: w, height: tall, fill }),
        hotWidth > 0 ? svg('rect', { x, y: top, width: hotWidth, height: tall, fill: 'var(--hot-3)' }) : null,
      )
      const hit = svg('rect', { x, y: 0, width: w, height, fill: 'transparent' })
      hit.addEventListener('pointermove', (event) => {
        group.classList.add('active')
        showTip(event.clientX, event.clientY, segment.name, rows)
      })
      hit.addEventListener('pointerleave', () => group.classList.remove('active'))
      marks.push(group, hit)

      // Labels sit below the bar, never inside it; a segment too narrow for
      // its name leaves it to the tooltip and the table beneath.
      if (w >= 64) marks.push(svg('text', { x, y: top + tall + 16 }, `${segment.name} ${compact(segment.chars)}`))
      x += w + 2
      start = end
    }

    if (exchange.divergence) {
      const at = Math.min(width, scale(exchange.divergence.offset) + 2 * present.findIndex((s) => s.name === exchange.divergence?.segment))
      const anchor = at > width - 200 ? 'end' : 'start'
      marks.push(
        svg('line', { x1: at, x2: at, y1: top - 6, y2: top + tall + 6, stroke: 'var(--critical)', 'stroke-width': 1, 'shape-rendering': 'crispEdges' }),
        svg('text', { x: anchor === 'end' ? at - 6 : at + 6, y: 12, 'text-anchor': anchor, style: 'fill: var(--text-secondary)' },
          `prefix broke: ${exchange.divergence.segment} +${exchange.divergence.offsetInSegment}`),
      )
    }
    return marks
  })
}
