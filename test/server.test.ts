// End-to-end check of the server: it starts on a free port with a home of its
// own (a hook record, a transcript, an outbox) and a data folder of its own,
// and opens nothing in the desktop app (AGENT_CENTER_DRY_RUN), so nothing of
// the person's is read, written or touched. Run: bun test

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ID = "11111111-2222-3333-4444-555555555555"
const WATCHER = "66666666-7777-8888-9999-000000000000"
const STALE = "99999999-8888-7777-6666-555555555555" // a CLI id an old copy of the desktop record still names
let home = ""
let data = ""
let port = 0
let server: ReturnType<typeof Bun.spawn> | null = null
const base = () => `http://localhost:${port}`

// Answers of this server are free-form JSON: read loosely.
const jsonOf = async (res: Response | Promise<Response>): Promise<any> => (await res).json()

const post = (path: string, body: unknown = {}, headers: Record<string, string> = { "x-agent-center": "1" }) =>
  fetch(`${base()}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "agent-center-home-"))
  data = await mkdtemp(join(tmpdir(), "agent-center-data-"))
  const now = Date.now()
  await mkdir(join(home, ".claude", "session-inbox"), { recursive: true })
  await writeFile(
    join(home, ".claude", "session-inbox", `${ID}.json`),
    JSON.stringify({ session_id: ID, cwd: home, project: "demo", state: "asking", ask: "Shall I go on with the plan?", title: "Demo session", updated_at: now }),
  )
  // A turn that ended with only a monitor left: done, not working.
  await writeFile(
    join(home, ".claude", "session-inbox", `${WATCHER}.json`),
    JSON.stringify({
      session_id: WATCHER, cwd: home, project: "demo", state: "working", title: "Watcher", updated_at: now,
      background: [{ id: "m1", type: "monitor", description: "live updates for an artifact", command: null, since: now }],
    }),
  )
  await mkdir(join(home, ".claude", "projects", "demo"), { recursive: true })
  const rows = [
    { type: "user", uuid: "u1", timestamp: new Date(now - 2000).toISOString(), message: { role: "user", content: "Write the zebra report" } },
    { type: "assistant", uuid: "a1", timestamp: new Date(now - 1000).toISOString(), message: { role: "assistant", content: [{ type: "text", text: "Done: the zebra report is ready." }] } },
  ]
  await writeFile(join(home, ".claude", "projects", "demo", `${ID}.jsonl`), rows.map(r => JSON.stringify(r)).join("\n") + "\n")
  // The desktop app keeps a copy of the session's record per account folder:
  // the old one (read last) still names a CLI session that is gone.
  const desktop = join(home, "Library", "Application Support", "Claude", "claude-code-sessions")
  for (const [folder, cliSessionId, at] of [["a-account/org", ID, now], ["b-account/org", STALE, now - 90 * 86_400_000]] as const) {
    await mkdir(join(desktop, folder), { recursive: true })
    await writeFile(join(desktop, folder, "local_demo.json"), JSON.stringify({ sessionId: "local_demo", cliSessionId, cwd: home, title: "Demo session", lastActivityAt: at }))
  }

  port = 20000 + Math.floor(Math.random() * 20000)
  server = Bun.spawn(["bun", "server.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, HOME: home, AGENT_CENTER_HOME: join(home, "state"), AGENT_CENTER_PORT: String(port), AGENT_CENTER_DATA: data, AGENT_CENTER_DRY_RUN: "1" },
    stdout: "ignore",
    stderr: "ignore",
  })
  for (let i = 0; i < 100; i++) {
    if (await fetch(base()).then(() => true, () => false)) return
    await Bun.sleep(100)
  }
  throw new Error("the server did not start")
})

afterAll(() => {
  server?.kill()
})

describe("page and guard", () => {
  test("serves the page", async () => {
    expect((await fetch(base())).status).toBe(200)
    expect((await fetch(`${base()}/js/main.js`)).status).toBe(200)
  })

  test("never serves files outside public/", async () => {
    expect((await fetch(`${base()}/%2e%2e/server.ts`)).status).toBe(404)
  })

  test("refuses another host name (DNS rebinding)", async () => {
    expect((await fetch(`${base()}/api/state`, { headers: { host: `evil.example:${port}` } })).status).toBe(403)
  })

  test("refuses requests another site starts", async () => {
    expect((await fetch(`${base()}/api/state`, { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403)
    expect((await post(`/api/sessions/${ID}/seen`, {}, { "x-agent-center": "1", origin: "http://evil.example" })).status).toBe(403)
  })

  test("needs the header to change anything", async () => {
    expect((await post(`/api/sessions/${ID}/seen`, {}, {})).status).toBe(403)
  })
})

describe("board", () => {
  test("shows the session as a card that asks", async () => {
    const state = await jsonOf(fetch(`${base()}/api/state`))
    const card = state.cards.find((c: any) => c.id === ID)
    expect(card).toBeDefined()
    expect(card.title).toBe("Demo session")
    expect(card.column).toBe("asking")
    expect(card.ask).toBe("Shall I go on with the plan?")
  })

  test("follows the newest copy of the desktop app's record", async () => {
    const state = await jsonOf(fetch(`${base()}/api/state`))
    expect(state.cards.some((c: any) => c.id === ID)).toBe(true)
    expect(state.cards.some((c: any) => c.id === STALE)).toBe(false)
  })

  test("a monitor left watching is not work in progress", async () => {
    const state = await jsonOf(fetch(`${base()}/api/state`))
    const card = state.cards.find((c: any) => c.id === WATCHER)
    expect(card.state).toBe("done")
    expect(card.column).not.toBe("working")
    expect(card.background).toEqual([])
  })

  test("reads the conversation", async () => {
    const page = await jsonOf(fetch(`${base()}/api/sessions/${ID}/messages`))
    expect(page.items.map((i: any) => i.kind)).toEqual(["user", "assistant"])
    expect((await fetch(`${base()}/api/sessions/${ID}/messages?after=-1`)).status).toBe(404)
  })

  test("finds it in search", async () => {
    const { results } = await jsonOf(fetch(`${base()}/api/search?q=zebra`))
    expect(results.map((r: any) => r.id)).toContain(ID)
  })

  test("keeps the person's decisions in its own data folder", async () => {
    expect((await post(`/api/sessions/${ID}/rename`, { title: "Renamed" })).status).toBe(200)
    const board = JSON.parse(await readFile(join(data, "board.json"), "utf8"))
    expect(Object.values(board.items).some((i: any) => i.title === "Renamed")).toBe(true)
  })

  test("refuses an unknown action without touching the board", async () => {
    const before = await readFile(join(data, "board.json"), "utf8")
    expect((await post(`/api/sessions/${ID}/frobnicate`)).status).toBe(400)
    expect(await readFile(join(data, "board.json"), "utf8")).toBe(before)
  })

  test("cleans zones it is sent", async () => {
    const res = await jsonOf(post("/api/canvas/zones", { zones: [{ id: "z1", name: "  WIP  ", x: -10, y: 5, w: 10, h: 10 }] }))
    expect(res.zones).toEqual([{ id: "z1", name: "WIP", x: 0, y: 5, w: 160, h: 120 }])
  })
})

describe("messages to the session", () => {
  test("queues a message for the bridge mod and takes it back", async () => {
    const sent = await jsonOf(post(`/api/sessions/${ID}/send`, { text: "hello from the test" }))
    expect(sent.ok).toBe(true)
    const outbox = join(home, ".claude", "agent-center", "outbox", ID, `${sent.messageId}.json`)
    expect(JSON.parse(await readFile(outbox, "utf8")).text).toBe("hello from the test")
    const bridge = await jsonOf(fetch(`${base()}/api/sessions/${ID}/bridge`))
    expect(bridge.queued.map((q: any) => q.id)).toContain(sent.messageId)
    expect((await post(`/api/sessions/${ID}/unsend`, { messageId: sent.messageId })).status).toBe(200)
  })

  test("refuses an empty message", async () => {
    expect((await post(`/api/sessions/${ID}/send`, { text: "   " })).status).toBe(400)
  })

  test("saves a large file sent with the message, and refuses an empty one", async () => {
    const upload = (body: Uint8Array) =>
      fetch(`${base()}/api/sessions/${ID}/upload`, { method: "POST", headers: { "content-type": "application/pdf", "x-file-name": "report.pdf", "x-agent-center": "1" }, body })
    const saved = await jsonOf(upload(new Uint8Array(40 * 1024 * 1024).fill(7)))
    expect(saved.ok).toBe(true)
    expect(saved.path).toEndWith("-report.pdf")
    expect(Bun.file(saved.path).size).toBe(40 * 1024 * 1024)
    expect((await upload(new Uint8Array(0))).status).toBe(400)
  })
})
