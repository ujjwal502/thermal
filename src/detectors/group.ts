import type { Turn } from '../types.ts'

export function bySession(turns: Turn[]): Map<string, Turn[]> {
  const sessions = new Map<string, Turn[]>()
  for (const turn of turns) {
    const existing = sessions.get(turn.sessionId)
    if (existing) existing.push(turn)
    else sessions.set(turn.sessionId, [turn])
  }
  return sessions
}
