import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { basename } from 'node:path'
import type { Turn } from '../types.ts'
import type { SessionFile } from './discover.ts'

export interface ParseResult {
  turns: Turn[]
  /** Lines that were not valid JSON. Sessions are written live, so a truncated
   *  final line is normal rather than a fault. */
  skippedLines: number
}

interface RawUsage {
  input_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  output_tokens?: number
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number }
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function toTurn(record: unknown, file: SessionFile): Turn | undefined {
  if (typeof record !== 'object' || record === null) return undefined
  const row = record as Record<string, unknown>
  const message = row['message']
  if (typeof message !== 'object' || message === null) return undefined
  const msg = message as Record<string, unknown>
  if (msg['role'] !== 'assistant') return undefined

  const usage = msg['usage'] as RawUsage | undefined
  if (!usage) return undefined

  const model = typeof msg['model'] === 'string' ? msg['model'] : 'unknown'
  const stamp = typeof row['timestamp'] === 'string' ? new Date(row['timestamp']) : undefined
  if (!stamp || Number.isNaN(stamp.getTime())) return undefined

  // Older records carry only the aggregate cache_creation_input_tokens. Treat
  // that as a 5m write, which is the cheaper assumption and keeps waste honest.
  const breakdown = usage.cache_creation
  const write5m = breakdown ? num(breakdown.ephemeral_5m_input_tokens) : num(usage.cache_creation_input_tokens)
  const write1h = breakdown ? num(breakdown.ephemeral_1h_input_tokens) : 0

  const diagnostics = msg['diagnostics'] as { cache_miss_reason?: { type?: string } } | undefined

  return {
    sessionId: basename(file.path, '.jsonl'),
    project: file.project,
    requestId: typeof row['requestId'] === 'string' ? row['requestId'] : '',
    timestamp: stamp,
    model,
    inputTokens: num(usage.input_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
    cacheWrite5mTokens: write5m,
    cacheWrite1hTokens: write1h,
    outputTokens: num(usage.output_tokens),
    cacheMissReason: diagnostics?.cache_miss_reason?.type,
  }
}

export async function parseSession(file: SessionFile): Promise<ParseResult> {
  const turns: Turn[] = []
  let skippedLines = 0

  const lines = createInterface({
    input: createReadStream(file.path, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  })

  for await (const line of lines) {
    if (!line.trim()) continue
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      skippedLines++
      continue
    }
    const turn = toTurn(record, file)
    if (turn) turns.push(turn)
  }

  turns.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())
  return { turns, skippedLines }
}
