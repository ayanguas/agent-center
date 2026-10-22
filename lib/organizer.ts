// Tasks from ~/organizer (TASKS.md per registered project, plus inbox.md).
// Reads the markdown directly; every write goes through organizer.py.

import { readFile, stat } from "node:fs/promises"
import { basename, join } from "node:path"
import { HOME } from "./config"
import { isOrganizerOn } from "./setup"
import { run } from "./proc"

const ROOT = join(HOME, "organizer")
const CLI = join(ROOT, "organizer.py")
const INBOX = join(ROOT, "inbox.md")

export type Task = {
  file: string
  line: number
  text: string // clean text: what organizer.py done-at --text compares
  priority: "high" | "med" | "low" | null
  due: string | null
  session: string | null // from the <!-- session: --> tag, when the task has one
  project: string // project name, or "inbox"
}

// Same patterns as organizer.py.
const TASK_RE = /^([ \t]*)[-*]\s\[( |x|X)\]\s+(.*)$/
const META_RE = /<!--.*?-->/g
const PRIO_RE = /(?<!\S)!(high|med|medium|low)(?!\S)/i
const DUE_RE = /(?<!\S)@(\d{4}-\d{2}-\d{2})(?!\S)/
const TAG_RE = /(?<!\S)#([A-Za-z][\w-]*)(?!\S)/g
const SESSION_RE = /<!--\s*session:\s*([\w-]+)\s*-->/

export function cleanText(body: string) {
  return body
    .replace(META_RE, "")
    .replace(new RegExp(PRIO_RE, "gi"), "")
    .replace(new RegExp(DUE_RE, "g"), "")
    .replace(TAG_RE, "")
    .replace(/\s+/g, " ")
    .trim()
}

const fileCache = new Map<string, { mtimeMs: number; tasks: Task[] }>()

async function tasksIn(file: string, project: string): Promise<Task[]> {
  try {
    const { mtimeMs } = await stat(file)
    const hit = fileCache.get(file)
    if (hit?.mtimeMs === mtimeMs) return hit.tasks
    const tasks: Task[] = []
    ;(await readFile(file, "utf8")).split("\n").forEach((raw, i) => {
      const m = raw.match(TASK_RE)
      if (!m || m[1] || m[2] !== " ") return // open, top-level tasks only
      const body = (m[3] ?? "").trimEnd()
      const prio = body.match(PRIO_RE)?.[1]?.toLowerCase()
      tasks.push({
        file,
        line: i + 1,
        text: cleanText(body),
        priority: prio === "high" ? "high" : prio === "low" ? "low" : prio ? "med" : null,
        due: body.match(DUE_RE)?.[1] ?? null,
        session: raw.match(SESSION_RE)?.[1] ?? null,
        project,
      })
    })
    fileCache.set(file, { mtimeMs, tasks })
    return tasks
  } catch {
    return []
  }
}

// Off (not installed, or turned off in the setup): no tasks anywhere.
export async function readTasks(): Promise<Task[]> {
  if (!(await isOrganizerOn())) return []
  let projects: string[] = []
  try {
    projects = JSON.parse(await readFile(join(ROOT, "config.json"), "utf8")).projects ?? []
  } catch {}
  const lists = await Promise.all([tasksIn(INBOX, "inbox"), ...projects.map(p => tasksIn(join(p, "TASKS.md"), basename(p)))])
  return lists.flat()
}

// Only a file the board itself read tasks from; the text goes as one
// `--text=` argument, so it never reads as a flag.
async function isTaskFile(file: string) {
  return (await readTasks()).some(t => t.file === file)
}

export async function closeTask(file: string, line: number, text: string) {
  if (!(await isTaskFile(file)) || !Number.isInteger(line)) return false
  return (await run(["python3", CLI, "done-at", file, String(line), `--text=${text}`], ROOT)) !== null
}

export async function reopenTask(file: string, line: number, text: string) {
  if (!(await isTaskFile(file)) || !Number.isInteger(line)) return false
  return (await run(["python3", CLI, "reopen-at", file, String(line), `--text=${text}`], ROOT)) !== null
}

// `folder` is the session's repository root (never a worktree, where
// organizer.py would start a TASKS.md of its own).
export async function addTask(text: string, folder: string | null, session: string | null) {
  const args = ["python3", CLI, "add"]
  if (session) args.push("--session", session)
  let dir = ROOT
  if (folder && (await stat(folder).then(s => s.isDirectory()).catch(() => false))) dir = folder
  else args.push("--inbox")
  // After "--" the text is never read as a flag.
  return (await run([...args, "--", text], dir)) !== null
}
