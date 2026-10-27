// The "Code" tab: a session's folder as an editor sees it. Its root is the git
// repository the session works in (else its folder); the tree is what git
// tracks plus new files it does not ignore, each with its git status. A file
// opens as text and saves back only if nobody changed it since it was read
// (Claude may edit it meanwhile): else the page decides what wins.

import { readdir, readFile, realpath, stat, writeFile } from "node:fs/promises"
import { basename, join, relative, sep } from "node:path"
import { exec, run } from "./proc"

const MAX_FILES = 20_000
const MAX_TEXT = 4 * 1024 * 1024 // bytes opened in the editor at most
const SKIPPED = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", "dist", "build", ".next", ".turbo", ".cache", "DerivedData", "Library"])

export type CodeTree = { root: string; name: string; files: string[]; status: Record<string, string>; isGit: boolean; truncated: boolean }

const git = (cwd: string, args: string[]) => run(["git", "-C", cwd, ...args], cwd, { timeoutMs: 15_000 })

export async function rootOf(cwd: string) {
  return (await git(cwd, ["rev-parse", "--show-toplevel"])) ?? cwd
}

// A folder that is not a repository: walked, without what is never source.
async function walk(root: string) {
  const out: string[] = []
  const visit = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (out.length >= MAX_FILES) return
      if (entry.isDirectory()) {
        if (!SKIPPED.has(entry.name)) await visit(join(dir, entry.name))
      } else if (entry.isFile()) out.push(relative(root, join(dir, entry.name)))
    }
  }
  await visit(root)
  return out
}

// "M", "A", "D", "R" or "U" (new, untracked) per path, as `git status` says.
async function statusOf(root: string) {
  const status: Record<string, string> = {}
  // Not trimmed: the first entry may start with a space (" M path").
  const { stdout } = await exec(["git", "-C", root, "status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: root, timeoutMs: 15_000 })
  const parts = stdout.split("\0")
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]!
    if (entry.length < 4) continue
    const code = entry.slice(0, 2)
    const path = entry.slice(3)
    status[path] = code === "??" ? "U" : code.includes("D") ? "D" : code.includes("R") ? "R" : code.includes("A") ? "A" : "M"
    if (code.startsWith("R")) i++ // a rename names its old path next
  }
  return status
}

export async function codeTree(cwd: string): Promise<CodeTree> {
  const root = await rootOf(cwd)
  const listed = await git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
  const isGit = listed !== null
  const all = isGit ? [...new Set(listed.split("\0").filter(Boolean))] : await walk(root)
  const status = isGit ? await statusOf(root) : {}
  // A deleted file is still in git's index: gone from the tree, unless it is back.
  const files = all.filter(f => status[f] !== "D").sort((a, b) => a.localeCompare(b))
  return { root, name: basename(root), files: files.slice(0, MAX_FILES), status, isGit, truncated: files.length > MAX_FILES }
}

// `rel` inside the root, also after links are followed; else null.
async function inside(root: string, rel: string) {
  if (!rel || rel.includes("\0")) return null
  const realRoot = await realpath(root)
  const full = join(realRoot, rel)
  if (!full.startsWith(realRoot + sep)) return null
  const real = await realpath(full).catch(() => null)
  return real && real.startsWith(realRoot + sep) ? real : null
}

// A file as text; `onlyTime`: only when it last changed (the page asks often).
export async function readCode(cwd: string, rel: string, onlyTime = false) {
  const path = await inside(await rootOf(cwd), rel)
  if (!path) return { error: "This file is not in the session's folder", status: 404 }
  const info = await stat(path)
  if (!info.isFile()) return { error: "Not a file", status: 404 }
  if (onlyTime) return { path: rel, mtime: info.mtimeMs, size: info.size }
  if (info.size > MAX_TEXT) return { path: rel, mtime: info.mtimeMs, size: info.size, tooBig: true }
  const buf = await readFile(path)
  if (buf.subarray(0, 8000).includes(0)) return { path: rel, mtime: info.mtimeMs, size: info.size, binary: true }
  return { path: rel, mtime: info.mtimeMs, size: info.size, text: buf.toString("utf8") }
}

// Saves `text` if the file is still as it was read (`mtime`), or `force`.
export async function saveCode(cwd: string, rel: string, text: string, mtime: number, force: boolean) {
  const path = await inside(await rootOf(cwd), rel)
  if (!path) return { error: "This file is not in the session's folder", status: 404 }
  const info = await stat(path)
  if (!info.isFile()) return { error: "Not a file", status: 404 }
  if (!force && info.mtimeMs !== mtime) return { error: "It changed on disk since you opened it", conflict: true, mtime: info.mtimeMs, status: 409 }
  await writeFile(path, text)
  return { ok: true, mtime: (await stat(path)).mtimeMs }
}
