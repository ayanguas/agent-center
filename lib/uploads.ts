// Files sent from the board (images, PDFs, documents, any file the desktop app
// takes): the mod can only submit text, so the board saves each file here and
// the message carries its path; Claude opens it with its Read tool (images,
// PDFs, text, notebooks) or its skills (Word, Excel, PowerPoint). Nothing
// deletes them: the folder is yours to empty.
//
//   ~/.claude/agent-center/uploads/<session>/<time>-<random>[-<name>].<ext>
//
// Files saved before 22/10 have no name: <time>-<random>.<ext>.

import { mkdir, readdir, stat, unlink } from "node:fs/promises"
import { join } from "node:path"
import { CENTER_DIR } from "./config"

const UPLOADS = join(CENTER_DIR, "uploads")
export const MAX_UPLOAD_BYTES = 500 * 1024 * 1024 // the file goes to disk as it arrives
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" }
const FILE_RE = /^[\w-]+\/[\w.-]+$/

// The name as the file had it, kept readable and safe for a path: letters,
// digits, dot, dash and underscore; the extension kept.
function safeName(name: string) {
  const base = name.split(/[\\/]/).pop() ?? ""
  const dot = base.lastIndexOf(".")
  const ext = dot > 0 ? base.slice(dot + 1).replace(/[^\w]/g, "").slice(0, 10).toLowerCase() : ""
  const stem = (dot > 0 ? base.slice(0, dot) : base)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w.-]+/g, "_")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 60)
  return { stem, ext }
}

export async function saveFile(sessionId: string, name: string, type: string, body: ReadableStream | null, length: number) {
  if (!/^[\w-]+$/.test(sessionId)) throw new Error("invalid session")
  if (!body || length === 0) throw new Error("the file is empty")
  if (length > MAX_UPLOAD_BYTES) throw new Error("the file is larger than 500 MB")
  const { stem, ext: fromName } = safeName(name)
  const ext = fromName || EXT[type] || "bin"
  const dir = join(UPLOADS, sessionId)
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${Date.now()}-${crypto.randomUUID().slice(0, 6)}${stem ? `-${stem}` : ""}.${ext}`)
  // Written as it arrives; a body sent without its length is counted on the way.
  const out = Bun.file(path).writer()
  let written = 0
  try {
    const reader = body.getReader()
    for (let part = await reader.read(); !part.done; part = await reader.read()) {
      const chunk = part.value
      written += chunk.byteLength
      if (written > MAX_UPLOAD_BYTES) throw new Error("the file is larger than 500 MB")
      out.write(chunk)
    }
    if (written === 0) throw new Error("the file is empty")
  } catch (err) {
    await out.end()
    await unlink(path).catch(() => {})
    throw err
  }
  await out.end()
  size.at = 0
  return path
}

// The folder in Finder, made first if no image was sent yet.
export async function openFolder() {
  await mkdir(UPLOADS, { recursive: true })
  return (await Bun.spawn(["open", UPLOADS]).exited) === 0
}

// The folder's size in bytes, for the board to show next to its button.
// Walked again at most every 30 s; an upload resets the wait.
let size = { bytes: 0, at: 0 }
export async function folderSize() {
  if (Date.now() - size.at < 30_000) return size.bytes
  let bytes = 0
  const names = await readdir(UPLOADS, { recursive: true }).catch(() => [] as string[])
  for (const name of names) {
    const info = await stat(join(UPLOADS, name)).catch(() => null)
    if (info?.isFile()) bytes += info.size
  }
  size = { bytes, at: Date.now() }
  return bytes
}

// A file of this folder, for the board to show or open; null for anything else.
export function uploadedFile(rel: string) {
  if (!FILE_RE.test(rel) || rel.includes("..")) return null
  return Bun.file(join(UPLOADS, rel))
}
