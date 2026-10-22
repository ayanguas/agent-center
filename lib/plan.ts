// The task list of a session's current turn, kept up to date by reading only
// what each transcript adds: a new prompt starts a turn with no list, a full
// list replaces it, and steps move it on (same rules as the reader).

import { stat } from "node:fs/promises"
import { readAppended } from "./files"
import { applyPlanOp, isPersonPrompt, transcriptPath, queuedPrompt, type PlanStep } from "./transcript"


type Scan = { offset: number; steps: PlanStep[] | null }
const scans = new Map<string, Scan>()

function ingest(scan: Scan, chunk: string) {
  for (const line of chunk.split("\n")) {
    const isTool = line.includes("ccd_turn__")
    if (!isTool && !line.includes('"type":"user"')) continue
    let row: any
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (row.isSidechain) continue
    if (isPersonPrompt(row) && !queuedPrompt(row)) {
      scan.steps = null
      continue
    }
    if (row.type !== "assistant" || !Array.isArray(row.message?.content)) continue
    for (const b of row.message.content) {
      if (b?.type !== "tool_use") continue
      const name = String(b.name ?? "")
      if (name.endsWith("ccd_turn__update_plan")) {
        const input = b.input ?? {}
        if (Array.isArray(input.items))
          scan.steps = input.items.map((i: any) => ({ content: String(i.content ?? ""), status: i.status ?? "pending" }))
        else if (scan.steps) scan.steps = applyPlanOp(scan.steps, { advance: !!input.advance, done: input.done, start: input.start })
      } else if (name.endsWith("ccd_turn__wrap_up") && scan.steps) scan.steps = applyPlanOp(scan.steps, { finish: true })
    }
  }
}

export type Progress = { done: number; total: number; current: string | null }

export async function progressOf(sessionId: string): Promise<Progress | null> {
  const path = await transcriptPath(sessionId)
  if (!path) return null
  const { size } = await stat(path)
  let scan = scans.get(path)
  if (!scan || size < scan.offset) {
    scan = { offset: 0, steps: null }
    scans.set(path, scan)
  }
  scan.offset = await readAppended(path, scan.offset, size, text => ingest(scan!, text))
  if (!scan.steps?.length) return null
  return {
    done: scan.steps.filter(s => s.status === "completed").length,
    total: scan.steps.length,
    current: scan.steps.find(s => s.status === "in_progress")?.content ?? null,
  }
}
