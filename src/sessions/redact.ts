import { homedir } from 'node:os'
import type { Turn } from '../types.ts'

/** Project names are directory paths, which name employers, clients and
 *  codebases. Replacing them with ranks keeps every number intact while making
 *  a screenshot safe to post. Session ids are random UUIDs and stay. */
export function redact(turns: Turn[]): Turn[] {
  const counts = new Map<string, number>()
  for (const turn of turns) counts.set(turn.project, (counts.get(turn.project) ?? 0) + 1)
  const aliases = new Map(
    [...counts].sort((a, b) => b[1] - a[1]).map(([name], rank) => [name, `project ${rank + 1}`]),
  )
  return turns.map((turn) => ({ ...turn, project: aliases.get(turn.project) ?? turn.project }))
}

/** The home directory holds the account name, which has no business in a
 *  header someone might screenshot. */
export function tildify(path: string): string {
  const home = homedir()
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}
