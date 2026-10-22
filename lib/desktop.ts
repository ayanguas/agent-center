// Read-only view of the Claude desktop app's own session records: title,
// archived and starred state, and the CLI session id each one runs.
// Never written here: those files belong to the app.

import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { DESKTOP_DIR } from "./config"
import { readJson } from "./files"

const ROOT = join(DESKTOP_DIR, "claude-code-sessions")

export type DesktopSession = {
  hostId: string
  cliId: string | null
  title: string | null
  cwd: string | null
  isArchived: boolean
  isStarred: boolean
  lastActivityAt: number | null
}

export type DesktopIndex = {
  ok: boolean
  byCli: Map<string, DesktopSession>
  byHost: Map<string, DesktopSession>
}

const cache = new Map<string, { mtimeMs: number; session: DesktopSession | null }>()

async function dirs(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => join(path, d.name))
  } catch {
    return []
  }
}

export async function readDesktop(): Promise<DesktopIndex> {
  const byCli = new Map<string, DesktopSession>()
  const byHost = new Map<string, DesktopSession>()
  const accounts = await dirs(ROOT)
  if (accounts.length === 0) return { ok: false, byCli, byHost }

  const seen = new Set<string>()
  for (const org of (await Promise.all(accounts.map(dirs))).flat()) {
    const archived = new Set<string>()
    try {
      for (const id of (await readJson(join(org, "archived-sessions.idx"))).archived ?? []) archived.add(id)
    } catch {}

    let names: string[] = []
    try {
      names = (await readdir(org)).filter(n => n.startsWith("local_") && n.endsWith(".json"))
    } catch {
      continue
    }
    await Promise.all(
      names.map(async name => {
        const path = join(org, name)
        seen.add(path)
        try {
          const { mtimeMs } = await stat(path)
          if (cache.get(path)?.mtimeMs !== mtimeMs) {
            const raw = await readJson(path)
            cache.set(path, {
              mtimeMs,
              session: {
                hostId: raw.sessionId,
                cliId: raw.cliSessionId ?? null,
                title: raw.title ?? null,
                cwd: raw.cwd ?? null,
                isArchived: !!raw.isArchived,
                isStarred: !!raw.isStarred,
                lastActivityAt: raw.lastActivityAt ?? null,
              },
            })
          }
        } catch {
          cache.set(path, { mtimeMs: -1, session: null })
        }
        const session = cache.get(path)?.session
        if (!session) return
        const entry = archived.has(session.hostId) ? { ...session, isArchived: true } : session
        byHost.set(entry.hostId, entry)
        if (entry.cliId) byCli.set(entry.cliId, entry)
      }),
    )
  }
  for (const path of [...cache.keys()]) if (!seen.has(path)) cache.delete(path)
  return { ok: true, byCli, byHost }
}
