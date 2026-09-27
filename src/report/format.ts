const enabled = process.env['NO_COLOR'] === undefined && process.stdout.isTTY === true

const paint = (r: number, g: number, b: number) => (text: string) =>
  enabled ? `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m` : text

// Terminal steps of the DESIGN.md thermal ramp.
export const cold = paint(79, 195, 224)
export const hot = paint(238, 176, 62)
export const critical = paint(224, 75, 87)
export const secondary = paint(154, 154, 152)
export const muted = paint(95, 95, 99)
export const bold = (text: string) => (enabled ? `\x1b[1m${text}\x1b[0m` : text)

export const usd = (amount: number) => `$${amount.toFixed(2)}`

export function count(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`
  return String(n)
}

/** Colour a cache hit rate on the thermal ramp: hot is cached, cold is not. */
export function heat(ratio: number, text: string): string {
  if (ratio >= 0.6) return hot(text)
  if (ratio >= 0.3) return secondary(text)
  return cold(text)
}

const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const

export function sparkline(values: number[]): string {
  if (values.length === 0) return ''
  const peak = Math.max(...values)
  if (peak === 0) return BLOCKS[0]!.repeat(values.length)
  return values
    .map((value) => BLOCKS[Math.min(BLOCKS.length - 1, Math.floor((value / peak) * (BLOCKS.length - 1)))]!)
    .join('')
}
