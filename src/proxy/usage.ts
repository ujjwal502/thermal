import type { Provider } from './prefix.ts'

export interface ObservedUsage {
  promptTokens: number
  cachedTokens: number
}

interface AnthropicUsage {
  input_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/** Two shapes in the wild. Chat Completions reports prompt_tokens with a
 *  prompt_tokens_details block; the Responses API reports input_tokens with an
 *  input_tokens_details block. Reading only the first silently returns zero on
 *  Responses traffic, which looks exactly like a healthy result. */
interface OpenAiUsage {
  prompt_tokens?: number
  prompt_tokens_details?: { cached_tokens?: number }
  input_tokens?: number
  input_tokens_details?: { cached_tokens?: number }
}

const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0

function fromAnthropic(usage: AnthropicUsage): ObservedUsage {
  const cached = num(usage.cache_read_input_tokens)
  return {
    promptTokens: num(usage.input_tokens) + cached + num(usage.cache_creation_input_tokens),
    cachedTokens: cached,
  }
}

function fromOpenAi(usage: OpenAiUsage): ObservedUsage {
  return {
    promptTokens: num(usage.prompt_tokens) || num(usage.input_tokens),
    cachedTokens:
      num(usage.prompt_tokens_details?.cached_tokens) || num(usage.input_tokens_details?.cached_tokens),
  }
}

function pick(payload: unknown, provider: Provider): ObservedUsage | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const record = payload as Record<string, unknown>
  // Anthropic's streaming message_start nests the usage one level down.
  const nested = record['message']
  const source =
    record['usage'] ??
    (typeof nested === 'object' && nested !== null ? (nested as Record<string, unknown>)['usage'] : undefined)
  if (typeof source !== 'object' || source === null) return undefined
  return provider === 'openai' ? fromOpenAi(source) : fromAnthropic(source)
}

/** Response bodies arrive either as one JSON document or as a stream of SSE
 *  `data:` lines. Usage can appear in more than one event, so later values with
 *  a real prompt count win. */
export function extractUsage(body: string, provider: Provider): ObservedUsage | undefined {
  const trimmed = body.trimStart()
  if (trimmed.startsWith('{')) {
    try {
      return pick(JSON.parse(trimmed), provider)
    } catch {
      return undefined
    }
  }

  let best: ObservedUsage | undefined
  for (const line of body.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload === '' || payload === '[DONE]') continue
    try {
      const found = pick(JSON.parse(payload), provider)
      if (found && found.promptTokens > 0) best = found
    } catch {
      continue // Partial or non-JSON event. Streams contain plenty of both.
    }
  }
  return best
}
