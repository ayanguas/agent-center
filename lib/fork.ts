// "Fork from here": a new session that knows the conversation up to just
// before one of the person's messages, and then takes a new prompt. Claude
// Code resumes a copy (`--fork-session`) cut at the last answer before that
// message (`--resume-session-at`); the original stays as it was.

import { stat } from "node:fs/promises"
import { readAppended } from "./files"
import { transcriptPath } from "./transcript"

export type ForkPoint = { sessionId: string; answerId: string | null }

// The transcript that holds the message, and the last main-thread answer
// before it (null when the message opened the conversation). Read in chunks:
// a transcript can be hundreds of MB.
export async function forkPoint(ids: string[], messageId: string): Promise<ForkPoint | null> {
  for (const sessionId of ids) {
    const path = await transcriptPath(sessionId)
    if (!path) continue
    let answerId: string | null = null
    let found: ForkPoint | null = null
    await readAppended(path, 0, (await stat(path)).size, text => {
      for (const line of text.split("\n")) {
        if (found || !line.includes('"uuid"')) continue
        let row: any
        try {
          row = JSON.parse(line)
        } catch {
          continue
        }
        if (row.uuid === messageId) found = { sessionId, answerId }
        else if (row.type === "assistant" && !row.isSidechain) answerId = row.uuid
      }
    })
    if (found) return found
  }
  return null
}
