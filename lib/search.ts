// Full-text search over every Claude Code conversation in ~/.claude/projects.
// Indexes only what people and Claude wrote (prompts and reply text), not tool
// output. Transcripts are append-only, so a grown file is read from where the
// last pass stopped.

import { open, readdir, stat } from "node:fs/promises"
import { basename, join } from "node:path"
import { PROJECTS_DIR as PROJECTS } from "./config"
import { isPersonPrompt, queuedPrompt, withoutReminders } from "./transcript"

const SNIPPET = 90

type Segment = { role: "user" | "assistant"; text: string; folded: string }

type Doc = {
  sessionId: string
  path: string
  mtimeMs: number
  offset: number
  cwd: string | null
  firstPrompt: string | null
  segments: Segment[]
}

export type Hit = {
  sessionId: string
  cwd: string | null
  firstPrompt: string | null
  updatedAt: number
  matches: number
  snippet: string
  role: "user" | "assistant"
}

const docs = new Map<string, Doc>()

const FOLD: Record<string, string> = {
  á: "a", à: "a", ä: "a", â: "a", é: "e", è: "e", ë: "e", ê: "e", í: "i", ì: "i", ï: "i", î: "i",
  ó: "o", ò: "o", ö: "o", ô: "o", ú: "u", ù: "u", ü: "u", û: "u", ñ: "n", ç: "c",
}

// Lower case without accents, keeping every character in place so a match
// index in the folded text is the same index in the original.
export const fold = (s: string) => s.toLowerCase().replace(/[áàäâéèëêíìïîóòöôúùüûñç]/g, c => FOLD[c] ?? c)

function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((b: any) => b?.type === "text" && typeof b.text === "string")
    .map((b: any) => b.text)
    .join("\n")
}

function ingest(doc: Doc, chunk: string) {
  for (const line of chunk.split("\n")) {
    if (!line || (!line.includes('"type":"user"') && !line.includes('"type":"assistant"') && !line.includes('"queued_command"'))) continue
    let row: any
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    doc.cwd ??= row.cwd ?? null
    const queued = queuedPrompt(row)
    if (queued) {
      doc.firstPrompt ??= queued.slice(0, 200)
      doc.segments.push({ role: "user", text: queued, folded: fold(queued) })
      continue
    }
    let role: Segment["role"] | null = null
    if (isPersonPrompt(row)) role = "user"
    else if (row.type === "assistant") role = "assistant"
    if (!role) continue
    const text = withoutReminders(textOf(row.message?.content))
    // Skip the reminders and command wrappers the engine injects as prompts.
    if (!text || (role === "user" && text.startsWith("<"))) continue
    if (role === "user") doc.firstPrompt ??= text.slice(0, 200)
    doc.segments.push({ role, text, folded: fold(text) })
  }
}

const CHUNK = 8 * 1024 * 1024

// Feeds whole lines from `from` to `to` in bounded chunks (a transcript can be
// hundreds of MB); answers the offset after the last whole line.
async function ingestRange(doc: Doc, from: number, to: number) {
  const handle = await open(doc.path, "r")
  try {
    let pos = from
    let carry = Buffer.alloc(0)
    while (pos < to) {
      const buf = Buffer.alloc(Math.min(CHUNK, to - pos))
      const { bytesRead } = await handle.read(buf, 0, buf.length, pos)
      if (bytesRead === 0) break
      pos += bytesRead
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead)
      const end = data.lastIndexOf(0x0a) + 1
      if (end > 0) ingest(doc, data.subarray(0, end).toString("utf8"))
      carry = Buffer.from(data.subarray(end))
    }
    return pos - carry.length
  } finally {
    await handle.close()
  }
}

let refreshing: Promise<void> | null = null

function refreshIndex() {
  refreshing ??= (async () => {
    let dirs: string[] = []
    try {
      dirs = (await readdir(PROJECTS, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => join(PROJECTS, d.name))
    } catch {
      return
    }
    const seen = new Set<string>()
    for (const dir of dirs) {
      let names: string[] = []
      try {
        names = (await readdir(dir)).filter(n => n.endsWith(".jsonl"))
      } catch {
        continue
      }
      for (const name of names) {
        const path = join(dir, name)
        seen.add(path)
        try {
          const { mtimeMs, size } = await stat(path)
          let doc = docs.get(path)
          if (doc && doc.mtimeMs === mtimeMs) continue
          if (!doc || size < doc.offset) {
            doc = { sessionId: basename(name, ".jsonl"), path, mtimeMs, offset: 0, cwd: null, firstPrompt: null, segments: [] }
            docs.set(path, doc)
          }
          // Only whole lines: a line still being written is read next time.
          doc.offset = await ingestRange(doc, doc.offset, size)
          doc.mtimeMs = mtimeMs
        } catch {}
      }
    }
    for (const path of [...docs.keys()]) if (!seen.has(path)) docs.delete(path)
  })().finally(() => (refreshing = null))
  return refreshing
}

export async function search(query: string, limit = 40): Promise<Hit[]> {
  await refreshIndex()
  const terms = fold(query).split(/\s+/).filter(t => t.length > 1)
  if (terms.length === 0) return []
  const hits: Hit[] = []
  for (const doc of docs.values()) {
    // Every term must appear somewhere in the conversation.
    if (!terms.every(t => doc.segments.some(s => s.folded.includes(t)))) continue
    let matches = 0
    let best: { seg: Segment; at: number; score: number } | null = null
    for (const seg of doc.segments) {
      const found = terms.filter(t => seg.folded.includes(t)).length
      if (found === 0) continue
      matches++
      if (!best || found > best.score) best = { seg, at: seg.folded.indexOf(terms[0]!), score: found }
    }
    if (!best) continue
    const at = best.at < 0 ? 0 : best.at
    const start = Math.max(0, at - SNIPPET)
    const snippet =
      (start > 0 ? "…" : "") +
      best.seg.text.slice(start, at + SNIPPET * 2).replace(/\s+/g, " ").trim() +
      (at + SNIPPET * 2 < best.seg.text.length ? "…" : "")
    hits.push({
      sessionId: doc.sessionId,
      cwd: doc.cwd,
      firstPrompt: doc.firstPrompt,
      updatedAt: doc.mtimeMs,
      matches,
      snippet,
      role: best.seg.role,
    })
  }
  return hits.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit)
}
