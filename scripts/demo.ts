// A demo board with made-up sessions, to try the page without Claude desktop
// or to take screenshots. It builds a home of its own in a temporary folder
// (hook records, transcripts, the bridge mod's files, a few git repos), starts
// the server there and keeps the sessions' heartbeats fresh. Nothing of yours
// is read or written, and no claude:// link is opened.
//
//   bun run demo                 http://localhost:7799
//   bun run demo -- --port 7800

import { mkdir, mkdtemp, realpath, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const PORT = Number(process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : 7799)
const APP_DIR = join(import.meta.dir, "..")
// The real path: macOS's temp folder is reached through a symlink (/var →
// /private/var), and git answers with the real one.
const root = await realpath(await mkdtemp(join(tmpdir(), "agent-center-demo-")))
const home = join(root, "home")
const state = join(root, "state")
const claude = join(home, ".claude")
const now = Date.now()
const min = 60_000

const write = async (path: string, value: unknown) => {
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value, null, 2))
}
const git = (cwd: string, ...args: string[]) =>
  Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: "demo", GIT_AUTHOR_EMAIL: "demo@example.com", GIT_COMMITTER_NAME: "demo", GIT_COMMITTER_EMAIL: "demo@example.com" },
  })

// ---------- repositories ----------

const REPOS = ["acme-web", "payments-api", "data-pipeline", "docs-site", "mobile-app"]
const repo = (name: string) => join(home, "code", name)
for (const name of REPOS) {
  await mkdir(repo(name), { recursive: true })
  git(repo(name), "init", "-q", "-b", "main")
  await writeFile(join(repo(name), "README.md"), `# ${name}\n`)
  git(repo(name), "add", "-A")
  git(repo(name), "commit", "-q", "-m", "init")
}

// ---------- sessions ----------

type Demo = {
  id: string
  repo: string
  branch?: string
  title: string
  state: "working" | "asking" | "permission" | "done"
  minutesAgo: number
  ask?: string
  askKind?: "next" | "dialog"
  choices?: { label: string; message: string }[]
  summary?: string
  mode?: string
  background?: { id: string; type: string; description: string; command: string }[]
  board?: Record<string, unknown>
  context: number // tokens in the last request
  model?: string
  turns: Turn[]
}
type Turn = { prompt: string; steps?: Step[] }
type Step =
  | { text: string }
  | { tool: string; input: Record<string, unknown>; result?: string }
  | { plan: { content: string; status: string }[] }

const id = (n: number) => `0000${n}000-demo-4000-8000-${String(n).padStart(12, "0")}`
const QUESTION_ID = "toolu_demo_question"

const SESSIONS: Demo[] = [
  {
    id: id(1), repo: "acme-web", branch: "feat/checkout-redesign", title: "Redesign the checkout page", state: "asking", minutesAgo: 4,
    ask: "Which payment layout should the checkout use?", askKind: "dialog", mode: "acceptEdits", context: 182_000,
    board: { pos: { x: 432, y: 120 } },
    turns: [
      {
        prompt: "Redesign the checkout page: fewer steps, clearer totals, and keep the current payment providers.",
        steps: [
          { text: "I'll start by reading the current checkout flow and its tests." },
          { tool: "Read", input: { file_path: "src/checkout/CheckoutPage.tsx" }, result: "…" },
          { tool: "Read", input: { file_path: "src/checkout/steps.ts" }, result: "…" },
          { tool: "Bash", input: { command: "bun test src/checkout", description: "Run the checkout tests" }, result: "24 pass" },
          { plan: [
            { content: "Merge shipping and billing into one step", status: "completed" },
            { content: "Show a live order summary beside the form", status: "completed" },
            { content: "Pick the payment layout", status: "in_progress" },
            { content: "Update the tests and screenshots", status: "pending" },
          ] },
          { text: "The new flow has **two steps instead of four**:\n\n1. **Details** — shipping and billing together, with \"same as shipping\" checked by default.\n2. **Pay** — the order summary stays visible on the right.\n\nOne decision is yours: how to show the payment providers." },
          { tool: "AskUserQuestion", input: { questions: [{
            question: "Which payment layout should the checkout use?", header: "Payment", multiSelect: false,
            options: [
              { label: "Tabs", description: "One tab per provider; cards first" },
              { label: "Stacked list", description: "All providers visible, radio buttons" },
              { label: "Express buttons on top", description: "Apple Pay and PayPal first, the card form below" },
            ],
          }] } },
        ],
      },
    ],
  },
  {
    id: id(2), repo: "payments-api", branch: "fix/webhook-retries", title: "Retry failed webhooks with backoff", state: "working", minutesAgo: 1,
    mode: "auto", context: 96_000, board: { pos: { x: 432, y: 312 } },
    background: [{ id: "bg1", type: "shell", description: "Replay last night's failed webhooks against staging", command: "bun scripts/replay.ts --since 24h" }],
    turns: [{
      prompt: "Webhooks that fail are lost. Retry them with exponential backoff, up to 8 attempts, and replay last night's failures on staging.",
      steps: [
        { text: "I'll add a retry queue with backoff and a dead-letter table for the ones that never succeed." },
        { plan: [
          { content: "Add the webhook_attempts table", status: "completed" },
          { content: "Retry worker with exponential backoff", status: "completed" },
          { content: "Dead-letter after 8 attempts", status: "in_progress" },
          { content: "Replay last night's failures on staging", status: "pending" },
        ] },
        { tool: "Edit", input: { file_path: "src/webhooks/worker.ts" }, result: "ok" },
      ],
    }],
  },
  {
    id: id(3), repo: "data-pipeline", branch: "main", title: "Nightly export to the warehouse", state: "permission", minutesAgo: 7,
    mode: "default", context: 61_000, board: { pos: { x: 768, y: 120 } },
    turns: [{
      prompt: "The nightly export misses yesterday's orders. Find out why and backfill them.",
      steps: [
        { text: "The export filters on `created_at < today` in UTC, but the job runs at 00:30 local time. I'll backfill the missing day." },
        { tool: "Bash", input: { command: "psql $WAREHOUSE_URL -f backfill/2026-10-21.sql", description: "Backfill yesterday's orders in the warehouse" } },
      ],
    }],
  },
  {
    id: id(4), repo: "docs-site", title: "Rewrite the getting started guide", state: "done", minutesAgo: 22,
    summary: "Rewrote the guide around one example project and cut it from 14 to 6 steps. Preview: /docs/start.",
    context: 74_000, board: { pos: { x: 768, y: 312 } },
    turns: [{ prompt: "Rewrite the getting started guide: it is too long and the first example does not run.", steps: [{ text: "Rewrote the guide around one example project and cut it from 14 to 6 steps. Preview: /docs/start." }] }],
  },
  {
    id: id(5), repo: "acme-web", branch: "fix/flaky-login-test", title: "Fix the flaky login test", state: "working", minutesAgo: 0,
    mode: "auto", context: 38_000, board: { pos: { x: 432, y: 504 } },
    turns: [{
      prompt: "The login e2e test fails one run in ten. Make it reliable.",
      steps: [
        { plan: [
          { content: "Reproduce the failure", status: "completed" },
          { content: "Wait for the session cookie, not a timeout", status: "in_progress" },
          { content: "Run the test 50 times", status: "pending" },
        ] },
      ],
    }],
  },
  {
    id: id(6), repo: "mobile-app", branch: "feat/dark-settings", title: "Dark mode for the settings screens", state: "done", minutesAgo: 95,
    summary: "Settings follow the system theme now; three custom colours moved to tokens.", context: 120_000,
    board: { pos: { x: 1176, y: 120 }, seen_at: now - 60 * min },
    turns: [{
      prompt: "Make the settings screens follow dark mode.",
      steps: [{ text: "Settings follow the system theme now; three custom colours moved to tokens.\n\nTo see the change:\n\n```bash\ngit log --oneline -3\n```" }],
    }],
  },
  {
    id: id(7), repo: "payments-api", title: "Upgrade the Stripe SDK to v15", state: "done", minutesAgo: 180,
    summary: "Read the v15 changelog: two breaking changes affect us (idempotency keys, expandable fields).", context: 45_000,
    board: { pos: { x: 1176, y: 312 }, parked_at: now - 170 * min, parked_until: now + 20 * 60 * min },
    turns: [{ prompt: "What does it take to upgrade the Stripe SDK to v15?", steps: [{ text: "Read the v15 changelog: two breaking changes affect us (idempotency keys, expandable fields)." }] }],
  },
  {
    id: id(8), repo: "data-pipeline", title: "Investigate the slow dashboard query", state: "asking", minutesAgo: 35,
    ask: "Add the composite index now, or first try the materialized view on staging?", askKind: "next",
    choices: [
      { label: "Add the index", message: "Add the composite index now." },
      { label: "Try the view first", message: "Try the materialized view on staging first." },
    ],
    summary: "The revenue dashboard scans 40M rows: an index on (account_id, day) brings it from 9 s to 120 ms.", context: 88_000,
    board: { pos: { x: 768, y: 504 } },
    turns: [{ prompt: "The revenue dashboard takes 9 seconds to load. Why?", steps: [{ text: "The revenue dashboard scans 40M rows: an index on (account_id, day) brings it from 9 s to 120 ms." }] }],
  },
  {
    id: id(9), repo: "docs-site", title: "API reference for webhooks", state: "done", minutesAgo: 300,
    summary: "Added the webhook events reference with payload examples.", context: 52_000,
    board: { done_at: now - 280 * min },
    turns: [{ prompt: "Add an API reference page for webhook events.", steps: [{ text: "Added the webhook events reference with payload examples." }] }],
  },
]

const inbox = join(claude, "session-inbox")
for (const [n, s] of SESSIONS.entries()) {
  // A session on its own branch works in a worktree of the repo, as Claude desktop does.
  let cwd = repo(s.repo)
  if (s.branch && s.branch !== "main") {
    const tree = join(home, "code", ".worktrees", `${s.repo}-${s.branch.replace(/\W+/g, "-")}`)
    git(cwd, "worktree", "add", "-q", "-b", s.branch, tree)
    cwd = tree
  }
  const at = now - s.minutesAgo * min
  await write(join(inbox, `${s.id}.json`), {
    session_id: s.id, cwd, project: s.repo, title: s.title, state: s.state, ask: s.ask ?? null, summary: s.summary ?? null,
    choices: s.choices ?? [], ask_kind: s.askKind ?? (s.state === "permission" ? "dialog" : null), mode: s.mode ?? "default", effort: "high",
    first_prompt: s.turns[0]!.prompt, last_prompt: s.turns.at(-1)!.prompt, updated_at: at,
    background: (s.background ?? []).map(b => ({ ...b, since: at - 3 * min })), background_at: at - 2 * min,
  })

  // The transcript, a few seconds per row, ending at the session's last moment.
  const rows: unknown[] = []
  let t = at - 60_000 * 4
  const stamp = () => new Date((t += 4000)).toISOString()
  let parent: string | null = null
  const row = (r: Record<string, unknown>) => {
    const uuid = `${s.id.slice(0, 8)}-row-${rows.length}`
    rows.push({ parentUuid: parent, isSidechain: false, uuid, sessionId: s.id, cwd, timestamp: stamp(), ...r })
    parent = uuid
  }
  const usage = { input_tokens: 12, cache_read_input_tokens: s.context - 2_000, cache_creation_input_tokens: 1_500, output_tokens: 488 }
  const say = (content: unknown[]) =>
    row({ type: "assistant", message: { id: `msg_${s.id.slice(0, 4)}_${rows.length}`, role: "assistant", model: s.model ?? "claude-fable-5-1", content, usage } })
  for (const turn of s.turns) {
    row({ type: "user", message: { role: "user", content: turn.prompt } })
    for (const [k, step] of (turn.steps ?? []).entries()) {
      if ("text" in step) say([{ type: "text", text: step.text }])
      else if ("plan" in step) {
        const tool = `toolu_${n}_${k}`
        say([{ type: "tool_use", id: tool, name: "mcp__ccd_turn__update_plan", input: { items: step.plan } }])
        row({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: tool, content: "Plan shown." }] } })
      } else {
        const tool = step.tool === "AskUserQuestion" ? QUESTION_ID : `toolu_${n}_${k}`
        say([{ type: "tool_use", id: tool, name: step.tool, input: step.input }])
        if (step.result !== undefined) row({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: tool, content: step.result }] } })
      }
    }
  }
  const transcript = join(claude, "projects", `-demo-${s.repo}`, `${s.id}.jsonl`)
  await write(transcript, rows.map(r => JSON.stringify(r)).join("\n") + "\n")
  await utimes(transcript, at / 1000, at / 1000) // last written when the session last moved
}

// ---------- the bridge mod's side: heartbeats, limits, a question, an approval ----------

const center = join(claude, "agent-center")
const limits = () => ({
  at: Date.now(),
  windows: [
    { kind: "five_hour", percentUsed: 34, resetsAt: new Date(now + 2.4 * 60 * min).toISOString() },
    { kind: "seven_day", percentUsed: 58, resetsAt: new Date(now + 2.8 * 24 * 60 * min).toISOString() },
  ],
})
const OPEN = [id(1), id(2), id(3), id(5)] // sessions whose process runs
async function beat() {
  for (const sid of OPEN)
    await write(join(center, "alive", `${sid}.json`), { at: Date.now(), busy: sid === id(2) || sid === id(5), v: 7, limits: limits() })
}
await beat()
await write(join(center, "questions", `${id(1)}.json`), { id: QUESTION_ID, questions: (SESSIONS[0]!.turns[0]!.steps!.at(-1) as any).input.questions, at: now })
await write(join(center, "permissions", `${id(3)}.json`), {
  id: "perm-demo", tool: "Bash", at: now,
  input: { command: "psql $WAREHOUSE_URL -f backfill/2026-10-21.sql", description: "Backfill yesterday's orders in the warehouse" },
})

// ---------- what Setup checks, already done ----------

await write(join(claude, "hooks", "session-inbox.py"), await Bun.file(join(APP_DIR, "hooks", "session-inbox.py")).text())
const hook = { hooks: [{ type: "command", command: `python3 "${join(claude, "hooks", "session-inbox.py")}"` }] }
await write(join(claude, "settings.json"), {
  hooks: Object.fromEntries(["UserPromptSubmit", "Stop", "Notification", "SessionEnd", "PreToolUse", "PostToolUse"].map(e => [e, [{ matcher: "", ...hook }]])),
  permissions: { allow: ["Read(~/.claude/agent-center/uploads/**)"] },
})
const version = (await Bun.file(join(APP_DIR, "bridge", ".claude-plugin", "plugin.json")).json()).version
await write(join(claude, "plugins", "installed_plugins.json"), { version: 2, plugins: { "agent-center-bridge@agent-center": [{ scope: "user", version }] } })

// ---------- the board: places, zones, notes ----------

const items: Record<string, unknown> = {}
for (const s of SESSIONS) if (s.board) items[s.id] = s.board
// "Run" on shell blocks is on here (the demo's folders are made up).
await write(join(state, "settings.json"), { runCommands: true })
await write(join(state, "data", "board.json"), {
  seenEpoch: now - 24 * 60 * min,
  items,
  zones: [
    { id: "z1", name: "This sprint", x: 408, y: 72, w: 696, h: 600 },
    { id: "z2", name: "Waiting on others", x: 1152, y: 72, w: 336, h: 408 },
  ],
  notes: [
    { id: "n1", text: "Release on Thursday\n- [x] Checkout copy approved\n- [ ] Staging sign-off\n- [ ] Changelog", x: 1176, y: 504, w: 288, h: 168, color: "yellow", cardId: null },
  ],
})

// ---------- the server ----------

const server = Bun.spawn(["bun", "server.ts"], {
  cwd: APP_DIR,
  env: { ...process.env, HOME: home, AGENT_CENTER_HOME: state, AGENT_CENTER_PORT: String(PORT), AGENT_CENTER_DRY_RUN: "1" },
  stdout: "inherit",
  stderr: "inherit",
})
const timer = setInterval(() => void beat(), 2000)
const stop = () => (clearInterval(timer), server.kill(), process.exit(0))
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
console.log(`Demo board on http://localhost:${PORT} (made-up sessions in ${root}). Ctrl-C to stop.`)
await server.exited
clearInterval(timer)
