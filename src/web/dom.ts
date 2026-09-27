import type { HitRate } from '../dashboard/contract.ts'

export type Child = Node | string | number | null | undefined | false
type Props = Record<string, string | number | boolean | EventListener | undefined>

function apply(element: Element, props: Props): void {
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue
    if (typeof value === 'function') element.addEventListener(key.slice(2), value)
    else element.setAttribute(key, value === true ? '' : String(value))
  }
}

function append(element: Element, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue
    // Strings become text nodes, never markup: project names, prompts and
    // model output are all untrusted.
    element.append(typeof child === 'object' ? child : String(child))
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag)
  apply(element, props)
  append(element, children)
  return element
}

export function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): SVGElementTagNameMap[K] {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag)
  apply(element, props)
  append(element, children)
  return element
}

export function usd(amount: number): string {
  if (amount > 0 && amount < 0.01) return `$${amount.toFixed(4)}`
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

export function compact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e4) return `${Math.round(n / 1e3)}K`
  return n.toLocaleString('en-US')
}

export function pct(rate: HitRate, digits = 1): string {
  return rate === null ? '-' : `${(rate * 100).toFixed(digits)}%`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function day(iso: string): string {
  const date = new Date(iso.length === 10 ? `${iso}T00:00:00` : iso)
  return `${MONTHS[date.getMonth()]} ${String(date.getDate()).padStart(2, ' ')}`
}

export function clock(iso: string): string {
  const date = new Date(iso)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:${String(date.getSeconds()).padStart(2, '0')}`
}

export function stamp(iso: string): string {
  return `${day(iso)} ${clock(iso).slice(0, 5)}`
}

export function duration(fromIso: string, toIso: string): string {
  const minutes = Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** The DESIGN.md diverging ramp. The midpoint gray means no cache activity at
 *  all, which is a different fact from a low hit rate. */
export function heat(rate: HitRate): string {
  if (rate === null) return 'var(--neutral)'
  if (rate < 0.15) return 'var(--cold-3)'
  if (rate < 0.3) return 'var(--cold-2)'
  if (rate < 0.5) return 'var(--cold-1)'
  if (rate < 0.7) return 'var(--hot-1)'
  if (rate < 0.9) return 'var(--hot-2)'
  return 'var(--hot-3)'
}

const RAMP = ['--cold-3', '--cold-2', '--cold-1', '--neutral', '--hot-1', '--hot-2', '--hot-3']

export function rampLegend(): HTMLElement {
  return h(
    'span',
    {},
    'cold',
    h('span', { class: 'ramp', 'aria-hidden': 'true' }, ...RAMP.map((token) => h('span', { style: `background: var(${token})` }))),
    'hot',
  )
}

export function swatch(color: string): HTMLElement {
  return h('span', { class: 'swatch', style: `background: ${color}`, 'aria-hidden': 'true' })
}

export interface TipRow {
  label: string
  value: string
  color?: string
}

let tip: HTMLElement | undefined

export function showTip(x: number, y: number, title: string, rows: TipRow[]): void {
  tip ??= document.body.appendChild(h('div', { class: 'tooltip', role: 'tooltip' }))
  tip.replaceChildren(
    h('div', { class: 'title' }, title),
    ...rows.map((row) =>
      h(
        'div',
        { class: 'row' },
        h('b', {}, row.value),
        h('span', { class: 'secondary' }, row.color ? h('span', { class: 'key', style: `background: ${row.color}` }) : null, row.label),
      ),
    ),
  )
  tip.hidden = false
  const box = tip.getBoundingClientRect()
  const left = x + 16 + box.width > window.innerWidth ? x - 16 - box.width : x + 16
  const top = Math.min(y + 16, window.innerHeight - box.height - 8)
  tip.style.left = `${Math.max(8, left)}px`
  tip.style.top = `${Math.max(8, top)}px`
}

export function hideTip(): void {
  if (tip) tip.hidden = true
}
