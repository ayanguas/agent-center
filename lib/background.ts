// What a session runs in the background right now, read live from its
// transcript (the hook only learns it when a turn ends): a tool call with
// `run_in_background: true` starts one, and a `<task-notification>` naming its
// tool call or task id ends it. A call still waiting for its result counts
// too once it has run a while (the client lists long commands the same way).
// Only what each transcript adds is read.

import { stat } from "node:fs/promises"
import { readAppended } from "./files"
import { transcriptPath } from "./transcript"

const MAX_AGE_MS = 24 * 60 * 60 * 1000 // a run older than this is taken as gone
const LONG_MS = 20_000 // a call still running after this shows as running

// type: shell, subagent…, or "current" for a call still waiting for its result.
export type BackgroundTask = { id: string; type: string; description: string | null; command: string | null; since: number; tool?: string }

// `inFlight`: main-thread calls with no result yet; a new prompt ends the turn
// and with it any that never got one (stopped with Esc).
type Scan = {
  offset: number
  running: Map<string, BackgroundTask & { toolUseId: string }>
  inFlight: Map<string, BackgroundTask>
}
const scans = new Map<string, Scan>()

const TYPE: Record<string, string> = { Bash: "shell", Agent: "subagent", Task: "subagent" }
// Calls that wait for the person, not for work: never "running".
const WAITS_FOR_YOU = /^(AskUserQuestion|ExitPlanMode|EnterPlanMode)$|^mcp__ccd_/

function ingest(scan: Scan, chunk: string) {
  for (const line of chunk.split("\n")) {
    const starts = line.includes('"run_in_background":true')
    const launched = line.includes("in background with ID") || line.includes("agentId")
    const ends = line.includes("task-notification")
    const calls = line.includes('"type":"tool_use"') || line.includes('"tool_use_id"') || line.includes('"type":"user"')
    if (!starts && !launched && !ends && !calls) continue
    if (ends) {
      // The notice is escaped inside the JSON line: read its ids straight off it.
      for (const m of line.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
        const toolUseId = m[1]!.match(/<tool-use-id>([^<]+)<\/tool-use-id>/)?.[1]
        const taskId = m[1]!.match(/<task-id>([^<]+)<\/task-id>/)?.[1]
        for (const [key, task] of scan.running)
          if (key === toolUseId || task.id === taskId) scan.running.delete(key)
      }
    }
    let row: any
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    // Only the conversation's own rows: newer clients also write copies of
    // earlier messages (api-request-blob, with no time of their own), which
    // would start every command they hold again.
    if (row.isSidechain || (row.type !== "user" && row.type !== "assistant")) continue
    const content = row.message?.content
    const at = Date.parse(row.timestamp ?? "") || Date.now()
    // A prompt (not a tool result) starts a new turn: the last one's calls are over.
    if (row.type === "user" && !row.isMeta && !(Array.isArray(content) && content.some((b: any) => b?.type === "tool_result")))
      scan.inFlight.clear()
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (block?.type === "tool_use" && block.input?.run_in_background !== true && !WAITS_FOR_YOU.test(String(block.name ?? "")))
        scan.inFlight.set(block.id, {
          id: block.id,
          type: "current",
          description: block.input?.description ?? null,
          command: typeof block.input?.command === "string" ? block.input.command.slice(0, 200) : null,
          since: at,
          tool: String(block.name ?? ""),
        } as BackgroundTask)
      else if (block?.type === "tool_result") scan.inFlight.delete(block.tool_use_id)
      if (block?.type === "tool_use" && block.input?.run_in_background === true) {
        scan.running.set(block.id, {
          toolUseId: block.id,
          id: block.id,
          type: TYPE[block.name] ?? String(block.name ?? "").toLowerCase(),
          description: block.input.description ?? null,
          command: typeof block.input.command === "string" ? block.input.command.slice(0, 200) : null,
          since: at,
        })
      } else if (block?.type === "tool_result" && scan.running.has(block.tool_use_id)) {
        // The result names the task the notice will name when it ends.
        const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "")
        const id = text.match(/background with ID: ([\w-]+)/)?.[1] ?? text.match(/agentId: ([\w-]+)/)?.[1]
        if (id) scan.running.get(block.tool_use_id)!.id = id
        if (block.is_error) scan.running.delete(block.tool_use_id)
      }
    }
  }
}

export async function backgroundOf(sessionId: string): Promise<BackgroundTask[]> {
  const path = await transcriptPath(sessionId)
  if (!path) return []
  const { size } = await stat(path)
  let scan = scans.get(path)
  if (!scan || size < scan.offset) {
    scan = { offset: 0, running: new Map(), inFlight: new Map() }
    scans.set(path, scan)
  }
  scan.offset = await readAppended(path, scan.offset, size, text => ingest(scan!, text))
  const now = Date.now()
  const long = [...scan.inFlight.values()].filter(t => now - t.since > LONG_MS && now - t.since < MAX_AGE_MS)
  return [
    ...[...scan.running.values()].filter(t => now - t.since < MAX_AGE_MS).map(({ toolUseId, ...task }) => task),
    ...long,
  ]
}
