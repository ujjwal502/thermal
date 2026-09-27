import { readdir, stat } from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, sep } from 'node:path'

export interface SessionFile {
  path: string
  project: string
  /** Subagent transcripts are separate API conversations with their own caches,
   *  so they count as sessions in their own right. */
  isSubagent: boolean
  bytes: number
}

export function defaultRoot(): string {
  return join(homedir(), '.claude', 'projects')
}

/** Claude Code encodes a project's absolute path as a directory name by
 *  replacing every non-alphanumeric character with a dash, which is lossy. We
 *  cannot decode it, but we can strip the identically-encoded home directory so
 *  that sibling projects stay distinguishable. */
function encodePath(path: string): string {
  return path.replaceAll(/[^a-zA-Z0-9]/g, '-')
}

const ENCODED_HOME = encodePath(homedir())

function projectName(dirName: string): string {
  const trimmed = dirName.startsWith(ENCODED_HOME) ? dirName.slice(ENCODED_HOME.length) : dirName
  return (trimmed.replace(/^-+/, '') || dirName).replaceAll('-', '/')
}

async function collect(dir: string, project: string, found: SessionFile[]): Promise<void> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return // Unreadable directory. Not worth failing the whole run over.
  }

  for (const entry of entries) {
    const path = join(dir, entry)
    let info: Stats
    try {
      info = await stat(path)
    } catch {
      continue
    }
    if (info.isDirectory()) {
      await collect(path, project, found)
    } else if (entry.endsWith('.jsonl')) {
      found.push({ path, project, isSubagent: path.includes(`${sep}subagents${sep}`), bytes: info.size })
    }
  }
}

export async function discover(root: string): Promise<SessionFile[]> {
  let projectDirs: string[]
  try {
    projectDirs = await readdir(root)
  } catch (cause) {
    throw new Error(
      `Could not read session directory ${root}. Thermal reads Claude Code logs ` +
        `from ~/.claude/projects. Pass --root to point somewhere else.`,
      { cause },
    )
  }

  const files: SessionFile[] = []
  for (const dir of projectDirs) {
    const full = join(root, dir)
    const info = await stat(full).catch(() => undefined)
    if (!info?.isDirectory()) continue
    await collect(full, projectName(relative(root, full)), files)
  }
  return files
}
