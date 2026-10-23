// "Run": starts a session's project in the session's own folder (its
// worktree, if any) with the command saved for that repository, and finds
// the ports it listens on. One run per session; the board stops it on request.
//
// data/run.json  { "<repo root>": { command } }  written only by this server
// logs/run-<session>.log                          the run's output

import { mkdir, readFile } from "node:fs/promises"
import { createServer } from "node:net"
import { join } from "node:path"
import { DATA_DIR, LOGS_DIR } from "./config"
import { writeJsonAtomic } from "./files"
import { run as exec } from "./proc"

const LOGS = LOGS_DIR
const CONFIG = join(DATA_DIR, "run.json")
const KEEP_LINES = 200

export type RunState = {
  command: string
  cwd: string
  pid: number
  startedAt: number
  port: number // offered in $PORT; many dev servers take it
  ports: number[] // what it listens on
  exitCode: number | null
  wasStopped: boolean // ended by "Stop", not by itself
  lines: string[]
}

const runs = new Map<string, RunState>()

async function config(): Promise<Record<string, { command: string }>> {
  try {
    return JSON.parse(await readFile(CONFIG, "utf8"))
  } catch {
    return {}
  }
}

export async function commandFor(root: string) {
  return (await config())[root]?.command ?? null
}

export async function saveCommand(root: string, command: string) {
  const all = await config()
  all[root] = { command }
  await writeJsonAtomic(CONFIG, all, { pretty: true })
}

// A first guess from the folder: the dev script of package.json, a Makefile
// target, Django's runserver.
export async function suggest(cwd: string) {
  const has = (name: string) => Bun.file(join(cwd, name)).exists()
  const pkg = await Bun.file(join(cwd, "package.json")).json().catch(() => null)
  if (pkg?.scripts) {
    const runner = (await has("pnpm-lock.yaml")) ? "pnpm" : (await has("bun.lockb")) || (await has("bun.lock")) ? "bun" : (await has("yarn.lock")) ? "yarn" : "npm run"
    const script = ["dev", "start", "serve"].find(s => pkg.scripts[s])
    if (script) return runner === "npm run" ? `npm run ${script}` : `${runner} ${script}`
  }
  const make = await Bun.file(join(cwd, "Makefile")).text().catch(() => "")
  const target = ["dev", "run", "serve", "start"].find(t => new RegExp(`^${t}:`, "m").test(make))
  if (target) return `make ${target}`
  if (await has("manage.py")) return "python manage.py runserver $PORT"
  return null
}

async function freePort(from = 3100) {
  for (let port = from; port < from + 200; port++) {
    const isFree = await new Promise<boolean>(resolve => {
      const server = createServer()
      server.once("error", () => resolve(false))
      server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)))
    })
    if (isFree) return port
  }
  return from
}

// The process and every child it started (npm → node → …).
async function tree(pid: number): Promise<number[]> {
  const out = [pid]
  for (let i = 0; i < out.length && out.length < 200; i++) {
    const kids = (await exec(["pgrep", "-P", String(out[i])], "/"))?.split("\n").filter(Boolean).map(Number) ?? []
    out.push(...kids)
  }
  return out
}

async function listening(pid: number) {
  const pids = await tree(pid)
  // Full path: the server's PATH (launchd) has no /usr/sbin.
  const out = (await exec(["/usr/sbin/lsof", "-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", pids.join(",")], "/")) ?? ""
  return [...new Set([...out.matchAll(/:(\d+) \(LISTEN\)/g)].map(m => Number(m[1])))].sort((a, b) => a - b)
}

export async function start(id: string, cwd: string, command: string) {
  await stop(id)
  await mkdir(LOGS, { recursive: true })
  const port = await freePort()
  const logPath = join(LOGS, `run-${id}.log`)
  const proc = Bun.spawn(["/bin/zsh", "-lc", command], {
    cwd,
    env: { ...process.env, PORT: String(port), FORCE_COLOR: "0" },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  })
  const state: RunState = { command, cwd, pid: proc.pid, startedAt: Date.now(), port, ports: [], exitCode: null, wasStopped: false, lines: [] }
  runs.set(id, state)
  const log = Bun.file(logPath).writer()
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder()
    let rest = ""
    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true })
      log.write(text)
      const parts = (rest + text).split("\n")
      rest = parts.pop() ?? ""
      state.lines.push(...parts.map(l => l.replace(/\x1b\[[0-9;]*m/g, "")))
      if (state.lines.length > KEEP_LINES) state.lines.splice(0, state.lines.length - KEEP_LINES)
    }
  }
  void Promise.all([read(proc.stdout), read(proc.stderr)]).finally(() => log.end())
  void proc.exited.then(code => {
    state.exitCode = code
    state.ports = []
  })
  return state
}

export async function stop(id: string) {
  const state = runs.get(id)
  if (!state || state.exitCode !== null) return false
  state.wasStopped = true
  await killTree(state.pid)
  return true
}

// SIGTERM to a process and its children, youngest first; SIGKILL 4 s later.
export async function killTree(root: number) {
  const pids = await tree(root)
  for (const pid of pids.reverse()) {
    try {
      process.kill(pid, "SIGTERM")
    } catch {}
  }
  setTimeout(() => pids.forEach(pid => { try { process.kill(pid, "SIGKILL") } catch {} }), 4000)
}

// The run as the board shows it, with fresh ports while it lives.
export async function status(id: string) {
  const state = runs.get(id)
  if (!state) return null
  if (state.exitCode === null) state.ports = await listening(state.pid).catch(() => state.ports)
  return { ...state, isRunning: state.exitCode === null, lines: state.lines.slice(-80) }
}

// For the cards: which sessions run something, and on which ports (looked up
// again at most every few seconds).
const checkedAt = new Map<string, number>()
export async function summary(id: string) {
  const state = runs.get(id)
  if (!state || state.exitCode !== null) return null
  if (Date.now() - (checkedAt.get(id) ?? 0) > 5000) {
    checkedAt.set(id, Date.now())
    state.ports = await listening(state.pid).catch(() => state.ports)
  }
  return { ports: state.ports }
}

// The server going down takes the runs with it: none is left behind with
// nobody able to stop it.
export async function stopAll() {
  await Promise.all([...runs.keys()].map(id => stop(id)))
}
