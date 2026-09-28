import type { Turn } from './types.ts'

interface Rate {
  /** USD per million tokens. */
  input: number
  output: number
  /** Cache read rate. Most models bill reads at a tenth of input; Fable 5.1 is
   *  documented separately at $0.25/MTok, so it is stated rather than derived. */
  cacheRead: number
  /** OpenAI caches automatically and charges nothing extra to write. */
  freeWrites?: true
}

// Cache WRITE multipliers over base input. These are the published Anthropic
// multipliers and are not model-specific, but they are the least certain numbers
// here - verify against an invoice before quoting a total to anyone.
const WRITE_5M_MULTIPLIER = 1.25
const WRITE_1H_MULTIPLIER = 2.0

const RATES: Record<string, Rate> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2 },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25 },
  // OpenAI list prices as published on developers.openai.com/api/docs/pricing,
  // read 2026-09-28.
  'gpt-4.1': { input: 2, output: 8, cacheRead: 0.5, freeWrites: true },
  'gpt-4.1-mini': { input: 0.4, output: 1.6, cacheRead: 0.1, freeWrites: true },
  'gpt-4.1-nano': { input: 0.1, output: 0.4, cacheRead: 0.025, freeWrites: true },
  'gpt-4o': { input: 2.5, output: 10, cacheRead: 1.25, freeWrites: true },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cacheRead: 0.075, freeWrites: true },
  'gpt-5': { input: 1.25, output: 10, cacheRead: 0.125, freeWrites: true },
  'gpt-5.1': { input: 1.25, output: 10, cacheRead: 0.125, freeWrites: true },
}

export const unpricedModels = new Set<string>()

function rateFor(model: string): Rate | undefined {
  const rate = RATES[model]
  if (!rate) unpricedModels.add(model)
  return rate
}

const perMillion = (tokens: number, usdPerMillion: number) => (tokens / 1_000_000) * usdPerMillion

export function costOf(turn: Turn): number {
  const rate = rateFor(turn.model)
  if (!rate) return 0
  return (
    perMillion(turn.inputTokens, rate.input) +
    perMillion(turn.cacheReadTokens, rate.cacheRead) +
    perMillion(turn.cacheWrite5mTokens, rate.input * WRITE_5M_MULTIPLIER) +
    perMillion(turn.cacheWrite1hTokens, rate.input * WRITE_1H_MULTIPLIER) +
    perMillion(turn.outputTokens, rate.output)
  )
}

/** Cost of writing these tokens to the 1h cache instead of the 5m cache. */
export function ttlPremium(tokens: number, model: string): number {
  const rate = rateFor(model)
  if (!rate) return 0
  return perMillion(tokens, rate.input * (WRITE_1H_MULTIPLIER - WRITE_5M_MULTIPLIER))
}

const writeRate = (rate: Rate) => (rate.freeWrites ? rate.input : rate.input * WRITE_5M_MULTIPLIER)

/** What it costs to write cacheable tokens again instead of reading them. Priced
 *  at the 5m write rate, the cheaper of the two, so a break is never overstated.
 *  Undefined for a model with no known price rather than a misleading $0. */
export function rebuildCost(tokens: number, model: string): number | undefined {
  const rate = rateFor(model)
  if (!rate) return undefined
  return perMillion(tokens, writeRate(rate) - rate.cacheRead)
}

/** What a prefix sent with no breakpoint cost over caching it: each warm repeat
 *  paid input price instead of a read, less the write premium caching would
 *  have added once. */
export function uncachedCost(tokens: number, warmRepeats: number, model: string): number | undefined {
  const rate = rateFor(model)
  if (!rate) return undefined
  return perMillion(tokens, warmRepeats * (rate.input - rate.cacheRead) - (writeRate(rate) - rate.input))
}

/** What a cache read saved versus paying full input price for the same tokens. */
export function readSavings(tokens: number, model: string): number {
  const rate = rateFor(model)
  if (!rate) return 0
  return perMillion(tokens, rate.input - rate.cacheRead)
}

export function writeCost(turn: Turn): number {
  const rate = rateFor(turn.model)
  if (!rate) return 0
  return (
    perMillion(turn.cacheWrite5mTokens, rate.input * WRITE_5M_MULTIPLIER) +
    perMillion(turn.cacheWrite1hTokens, rate.input * WRITE_1H_MULTIPLIER)
  )
}
