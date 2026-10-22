// "Catch me up": a short summary of what the sessions did since the last
// one. Claude writes one line per session (headless, no tools, no hooks,
// nothing saved) from what the board already knows of each: its state, its
// question, the recap of its last turn and the last prompt. The board does the
// grouping, so the shape never changes. Pressed by hand, never on a
// timer: a summary at a fixed hour needs the Mac awake at that hour.

import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { DATA_DIR } from "./config"
import { writeJsonAtomic } from "./files"
import { claudeBinary } from "./launch"
import { claudeEnv, exec } from "./proc"

const DATA = DATA_DIR
const FILE = join(DATA, "digest.json")
const FIRST_SINCE_MS = 24 * 60 * 60 * 1000 // the first one looks one day back
const TIMEOUT_MS = 120_000

// The same shape every time: the board groups the sessions by state, Claude
// writes one short line per session (what it did or asks) and what is left to
// you, and names the one to look at first.
export type DigestGroup = "waiting" | "stuck" | "finished" | "running" | "later"
export type DigestEntry = {
  id: string
  title: string
  repo: string
  group: DigestGroup
  card: { column: string; state: string; isStale: boolean; isInterrupted: boolean; progress: DigestItem["progress"] }
  line: string
  next: string | null
}
export type Digest = {
  at: number
  since: number
  count: number
  focus: { id: string; why: string } | null
  entries: DigestEntry[]
}

export type DigestItem = {
  id: string
  title: string
  repo: string
  branch: string | null
  column: string
  state: string
  ask: string | null
  recap: string | null
  lastPrompt: string | null
  progress: { done: number; total: number; current: string | null } | null
  prs: { number?: number; title?: string; state?: string }[]
  lastActivity: number
  waitingSince: number | null
  isStale: boolean
  isInterrupted: boolean
}

const COLUMN = {
  asking: "Asking you", review: "To review", working: "Working", pending: "Pending", parked: "Later", done: "Done",
} as const

export async function lastDigest(): Promise<Digest | null> {
  try {
    return (await Bun.file(FILE).json()) as Digest
  } catch {
    return null
  }
}

const clock = (t: number) =>
  new Date(t).toLocaleString("en-GB", { weekday: "long", hour: "2-digit", minute: "2-digit" })

function groupOf(i: DigestItem): DigestGroup {
  if (i.column === "asking") return "waiting"
  if (i.column === "working") return "running"
  if (i.column === "parked") return "later"
  if (i.isStale || i.isInterrupted) return "stuck"
  return "finished"
}

function promptFor(items: DigestItem[], since: number, now: number) {
  const sessions = items.map(i => ({
    id: i.id,
    title: i.title,
    repo: i.repo,
    state: i.isStale ? "Stuck (no sign of life)" : i.isInterrupted ? "Interrupted" : COLUMN[i.column as keyof typeof COLUMN] ?? i.column,
    question: i.ask,
    last_turn_recap: i.recap,
    last_prompt: i.lastPrompt?.slice(0, 400) ?? null,
    progress: i.progress ? `${i.progress.done}/${i.progress.total}${i.progress.current ? `, now: ${i.progress.current}` : ""}` : null,
    open_prs: i.prs.map(p => `#${p.number ?? "?"} ${p.title ?? ""}`.trim()),
    last_activity: clock(i.lastActivity),
    waiting_since: i.waitingSince ? clock(i.waitingSince) : null,
  }))
  return `You write the briefing of "Agent Center" for a person who runs several Claude Code sessions at once.
It is now ${clock(now)}. Below, in JSON, are the sessions with activity since ${clock(since)} and the ones that wait for the person's answer.

Return ONLY a JSON object, with no text around it and no code block, in this shape:
{"focus": {"id": "<id>", "why": "<why to look at it first>"} or null,
 "lines": {"<id>": {"line": "<the session's line>", "next": "<what is left to the person>" or null}}}

Rules:
- Language: write every "line", "next" and "why" in the language the person uses in the sessions' prompts ("last_prompt"). If you cannot tell, write in English.
- "lines" has one entry for each session in the JSON, with its exact id.
- "line": 12 words at most, without the title. Start with a verb:
  · "Asking you": what it asks ("Asks whether to delete the staging logs").
  · "Working": what it is doing ("Testing the login in the browser").
  · The rest: what it did ("Fixed the year filter and opened PR #124").
- "next": 5 words at most, in the imperative, for the person ("Answer yes or no", "Review PR #124", "Test the deploy"). null if nothing is left to the person.
- "focus": the session the person should look at first, and "why" in 12 words at most. null if there is none.
- Do not invent anything that is not in the data.

Sessions:
${JSON.stringify(sessions, null, 1)}`
}

// The JSON object in Claude's answer, even with a stray sentence around it.
function parseAnswer(text: string) {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) throw new Error("Claude did not return the expected format")
  const data = JSON.parse(text.slice(start, end + 1))
  return { focus: data.focus ?? null, lines: (data.lines ?? {}) as Record<string, { line?: string; next?: string | null }> }
}

const ORDER: DigestGroup[] = ["waiting", "stuck", "finished", "running", "later"]

async function write(items: DigestItem[], since: number): Promise<Digest> {
  const now = Date.now()
  await mkdir(DATA, { recursive: true })
  const { code, stdout: out, stderr: err } = await exec(
    [
      await claudeBinary(), "-p", "--output-format", "json", "--model", "sonnet",
      "--tools", "", "--no-session-persistence", "--settings", JSON.stringify({ disableAllHooks: true }),
    ],
    { cwd: DATA, env: claudeEnv(), input: promptFor(items, since, now), timeoutMs: TIMEOUT_MS },
  )
  let result: any = null
  try {
    result = JSON.parse(out)
  } catch {}
  if (code !== 0 || !result || result.is_error || typeof result.result !== "string")
    throw new Error(result?.result || err.trim().split("\n").pop() || `Claude ended with code ${code}`)
  const answer = parseAnswer(result.result)
  const entries: DigestEntry[] = items
    .map(i => ({
      id: i.id,
      title: i.title,
      repo: i.repo,
      group: groupOf(i),
      card: { column: i.column, state: i.state, isStale: i.isStale, isInterrupted: i.isInterrupted, progress: i.progress },
      line: String(answer.lines[i.id]?.line ?? i.ask ?? i.recap ?? "").trim(),
      next: answer.lines[i.id]?.next ? String(answer.lines[i.id]!.next).trim() : null,
    }))
    .sort((a, b) => ORDER.indexOf(a.group) - ORDER.indexOf(b.group))
  const focus = answer.focus && items.some(i => i.id === answer.focus.id) ? { id: String(answer.focus.id), why: String(answer.focus.why ?? "") } : null
  const digest: Digest = { at: now, since, count: items.length, focus, entries }
  await writeJsonAtomic(FILE, digest, { pretty: true })
  return digest
}

let pending: Promise<Digest> | null = null

// One at a time: a second press while Claude writes waits for the same one.
export function makeDigest(all: DigestItem[]): Promise<Digest> {
  if (pending) return pending
  pending = (async () => {
    const since = (await lastDigest())?.at ?? Date.now() - FIRST_SINCE_MS
    const items = all.filter(i => i.column === "asking" || i.lastActivity > since)
    return write(items, since)
  })().finally(() => (pending = null))
  return pending
}
