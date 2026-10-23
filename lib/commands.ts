// "▶" on a shell block of the conversation: runs that command in the
// session's folder with your login shell (no terminal opens) and keeps its
// output for the page, which asks for it while it runs. Off unless turned on
// in Setup ("Run commands"). Several can run at once; each one stops on
// request, and all of them when the server stops. A finished one is
// forgotten after a while.

import { settings } from "./config"
import { killTree } from "./runner"

const KEEP_CHARS = 60_000 // the tail of the output the page gets
const FORGET_MS = 30 * 60_000

type Command = {
  id: string
  sessionId: string
  command: string
  cwd: string
  pid: number
  startedAt: number
  endedAt: number | null
  exitCode: number | null
  wasStopped: boolean
  output: string
}

const commands = new Map<string, Command>()

export const canRunCommands = () => settings.runCommands === true

export function runCommand(sessionId: string, cwd: string, command: string) {
  if (!canRunCommands()) throw new Error("Running commands from the board is off: turn it on in Setup")
  for (const [id, c] of commands) if (c.endedAt && Date.now() - c.endedAt > FORGET_MS) commands.delete(id)
  const proc = Bun.spawn([process.env.SHELL || "/bin/zsh", "-lc", command], {
    cwd,
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  })
  const state: Command = {
    id: crypto.randomUUID(), sessionId, command, cwd, pid: proc.pid, startedAt: Date.now(), endedAt: null, exitCode: null, wasStopped: false, output: "",
  }
  commands.set(state.id, state)
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder()
    const reader = stream.getReader()
    for (let part = await reader.read(); !part.done; part = await reader.read())
      state.output = (state.output + decoder.decode(part.value, { stream: true }).replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")).slice(-KEEP_CHARS)
  }
  void Promise.all([read(proc.stdout), read(proc.stderr)])
    .catch(() => {})
    .then(() => proc.exited)
    .then(code => {
      state.exitCode = code
      state.endedAt = Date.now()
    })
  return view(state)
}

const view = (c: Command) => ({
  id: c.id, command: c.command, cwd: c.cwd, startedAt: c.startedAt, endedAt: c.endedAt,
  exitCode: c.exitCode, wasStopped: c.wasStopped, isRunning: c.endedAt === null, output: c.output,
})

// Only a command of this session.
export function commandStatus(sessionId: string, id: string) {
  const c = commands.get(id)
  return c && c.sessionId === sessionId ? view(c) : null
}

export async function stopCommand(sessionId: string, id: string) {
  const c = commands.get(id)
  if (!c || c.sessionId !== sessionId || c.endedAt !== null) return false
  c.wasStopped = true
  await killTree(c.pid)
  return true
}

// The server going down takes the commands with it.
export async function stopAllCommands() {
  await Promise.all([...commands.values()].filter(c => c.endedAt === null).map(c => stopCommand(c.sessionId, c.id)))
}
