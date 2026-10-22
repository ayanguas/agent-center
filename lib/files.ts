// Small file helpers shared by the readers of Claude Code's files and the
// writers of the server's own state.

import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

const CHUNK = 8 * 1024 * 1024

export async function readJson(path: string) {
  return JSON.parse(await readFile(path, "utf8"))
}

// Written aside under a unique name, then renamed: a reader never sees half a
// file, and two writers never share a temp file.
export async function writeJsonAtomic(path: string, value: unknown, { pretty = false } = {}) {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, pretty ? 2 : undefined))
  await rename(tmp, path)
}

// What a growing file (a transcript) added past `offset`, in whole lines,
// handed to `ingest` piece by piece; answers the offset to start from next
// time. A line still being written waits for the next call.
export async function readAppended(path: string, offset: number, size: number, ingest: (text: string) => void) {
  if (size <= offset) return offset
  const handle = await open(path, "r")
  try {
    while (offset < size) {
      const buf = Buffer.alloc(Math.min(CHUNK, size - offset))
      const { bytesRead } = await handle.read(buf, 0, buf.length, offset)
      if (bytesRead === 0) break
      let end = buf.subarray(0, bytesRead).lastIndexOf(0x0a) + 1
      if (end === 0) {
        if (bytesRead < CHUNK) break
        end = bytesRead // a single line longer than a chunk
      }
      ingest(buf.subarray(0, end).toString("utf8"))
      offset += end
    }
  } finally {
    await handle.close()
  }
  return offset
}
