// Waking sleeping sessions so their messages arrive. The client keeps a
// session's process only while it is in use: it stops it after 30 idle
// minutes, or sooner under memory pressure ("CliGovernor ... evicting" in its
// log). A session without a process cannot run the bridge mod, so its messages
// wait. The client's own link (claude://code/continue) starts the process
// again; a link opened while the client still tidies up a process that just
// ended does nothing, so it is tried again every WAKE_EVERY_MS, up to WAKE_TRIES.
//
// The client skips the start when it no longer trusts the session's folder
// ("Skipping warm for local_<id> — workspace no longer trusted"): only the
// person can fix that, by opening the session in the client and accepting.

import { open, stat } from "node:fs/promises"
import { isBusy, status, waitingSessions } from "./bridge"
import { DESKTOP_LOG } from "./config"

const WAKE_EVERY_MS = 20_000
const WAKE_TRIES = 4
const LOOP_MS = 5000
const LOG = DESKTOP_LOG
const LOG_TAIL = 512 * 1024

// tries: links opened since the session went quiet; untrusted: the client
// refused to start it for its folder.
export type WakeState = { tries: number; at: number; untrusted: boolean; isOver: boolean }
const wakes = new Map<string, WakeState>()

export function wakeState(id: string) {
  const w = wakes.get(id)
  return w ? { tries: w.tries, untrusted: w.untrusted, isOver: w.isOver } : null
}

// The client's log since `since`: did it refuse to start this session?
async function isUntrusted(id: string, since: number) {
  try {
    const { size } = await stat(LOG)
    const handle = await open(LOG, "r")
    try {
      const length = Math.min(size, LOG_TAIL)
      const buf = Buffer.alloc(length)
      await handle.read(buf, 0, length, size - length)
      const needle = `Skipping warm for local_${id} — workspace no longer trusted`
      return buf
        .toString("utf8")
        .split("\n")
        .some(line => line.includes(needle) && Date.parse(line.slice(0, 19).replace(" ", "T")) >= since - 2000)
    } finally {
      await handle.close()
    }
  } catch {
    return false
  }
}

async function tick(activate: (id: string) => Promise<{ ok: boolean }>) {
  for (const id of await waitingSessions()) {
    const bridge = await status(id)
    if (!bridge.pending || bridge.isOpen || isBusy(bridge)) {
      wakes.delete(id)
      continue
    }
    const w = wakes.get(id) ?? { tries: 0, at: 0, untrusted: false, isOver: false }
    wakes.set(id, w)
    if (w.at && !w.untrusted) w.untrusted = await isUntrusted(id, w.at)
    if (w.untrusted || w.tries >= WAKE_TRIES) {
      w.isOver = true
      continue
    }
    if (Date.now() - w.at < WAKE_EVERY_MS) continue
    w.tries++
    w.at = Date.now()
    await activate(id).catch(() => {})
  }
}

// A wake asked from the board ("Wake", or a message just sent) counts as a
// try and starts the count again.
export function wokeNow(id: string) {
  wakes.set(id, { tries: 1, at: Date.now(), untrusted: false, isOver: false })
}

export function startWaking(activate: (id: string) => Promise<{ ok: boolean }>) {
  let isRunning = false
  setInterval(async () => {
    if (isRunning) return
    isRunning = true
    try {
      await tick(activate)
    } finally {
      isRunning = false
    }
  }, LOOP_MS)
}
