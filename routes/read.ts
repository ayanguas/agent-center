// What the page reads: the board, its live stream, conversations, changes,
// PRs, tasks, runs, files sent and search. GET only; none changes anything
// the person decided.

import { basename } from "node:path"
import { status as bridgeStatus } from "../lib/bridge"
import { changesOf } from "../lib/changes"
import { HOME } from "../lib/config"
import { readDesktop } from "../lib/desktop"
import { lastDigest } from "../lib/digest"
import { detail as prDetail, lookup as prLookup, openThreads } from "../lib/github"
import { json } from "../lib/http"
import { latestJson, stream } from "../lib/live"
import { readTasks } from "../lib/organizer"
import { branchState, knownRepos, repoInfo } from "../lib/repo"
import { commandFor, status as runStatus, suggest as suggestRun } from "../lib/runner"
import { search } from "../lib/search"
import { setupStatus } from "../lib/setup"
import { readSessions } from "../lib/sessions"
import { groupOf, prRefs } from "../lib/snapshot"
import { refreshLinks, sessionOf } from "../lib/task-links"
import { readMessages } from "../lib/transcript"
import { isReady as voiceReady } from "../lib/transcribe"
import { uploadedFile } from "../lib/uploads"
import { wakeState } from "../lib/wake"

async function searchResults(query: string) {
  const [hits, desktop, sessions] = await Promise.all([search(query), readDesktop(), readSessions()])
  const onBoard = new Set(sessions.map(s => s.session_id))
  return Promise.all(
    hits.map(async h => {
      const app = desktop.byCli.get(h.sessionId)
      const repo = h.cwd ? await repoInfo(h.cwd) : null
      return {
        id: h.sessionId,
        hostId: app?.hostId ?? null,
        title: app?.title || h.firstPrompt || h.sessionId,
        repo: repo?.name ?? null,
        updatedAt: h.updatedAt,
        matches: h.matches,
        snippet: h.snippet,
        role: h.role,
        isOnBoard: onBoard.has(h.sessionId),
        isArchived: !!app?.isArchived,
      }
    }),
  )
}

// A file sent from the board. Pictures and PDFs open in the browser; anything
// else downloads, so a sent HTML or SVG never runs on the board's origin.
async function sentFile(rel: string) {
  const file = uploadedFile(rel)
  if (!file || !(await file.exists())) return new Response("Not found", { status: 404 })
  const type = file.type.split(";")[0]!
  const isShown = (type.startsWith("image/") && type !== "image/svg+xml") || type === "application/pdf"
  const name = (file.name ?? "").split("/").pop()!.replace(/^\d+-[0-9a-f]{6}-?/, "")
  return new Response(file, {
    headers: {
      "x-content-type-options": "nosniff",
      ...(isShown ? {} : { "content-security-policy": "sandbox", "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}` }),
    },
  })
}

// A byte offset in a query string, or undefined; NaN when not one.
const offset = (value: string | null) => (value === null ? undefined : Number(value))

async function sessionRead(id: string, what: string, url: URL) {
  const group = groupOf(id)
  switch (what) {
    case "messages": {
      const page = await readMessages(id, { before: offset(url.searchParams.get("before")), after: offset(url.searchParams.get("after")) })
      return page ? json(page) : json({ error: "Cannot find this session's transcript" }, 404)
    }
    case "changes": {
      const result = group ? await changesOf(group.lead.cwd) : null
      return result ? json(result) : json({ error: "This session's folder is not a git repository" }, 404)
    }
    case "bridge":
      return json({ ...(await bridgeStatus(id)), wake: wakeState(id) })
    case "prs": {
      const refs = group ? await prRefs(group.ids, group.root, group.branch) : await prRefs([id], HOME, null)
      // The branch's PR resolves to a URL through the summary cache.
      const urls = [...new Set(refs.map(r => (r.ref.startsWith("https://") ? r.ref : prLookup(r.key, r.ref, r.cwd)?.url)).filter(Boolean) as string[])]
      return json({ prs: (await Promise.all(urls.slice(0, 12).map(prDetail))).filter(Boolean) })
    }
    // "Ready to merge?": what the PR card does not say on its own. The
    // review comments still open, the session's folder (anything uncommitted
    // or unpushed on the PR's branch) and the session's open tasks.
    case "readiness": {
      const prUrl = url.searchParams.get("url") ?? ""
      const [pr, threads, tasks] = await Promise.all([
        prDetail(prUrl),
        openThreads(prUrl),
        readTasks().then(all => all.filter(t => (group?.ids ?? [id]).includes(sessionOf(t) ?? ""))),
      ])
      const local = group && pr ? await branchState(group.lead.cwd, pr.headRefName) : null
      return json({ threads, local, tasks: tasks.map(t => t.text) })
    }
    // "Run": the saved command of the repo (or a guess) and the run, if any.
    case "run":
      if (!group) return json({ error: "unknown session" }, 404)
      return json({
        command: await commandFor(group.root),
        suggestion: await suggestRun(group.lead.cwd),
        repo: basename(group.root),
        cwd: group.lead.cwd,
        run: await runStatus(id),
      })
    case "tasks": {
      await refreshLinks()
      const ids = group?.ids ?? [id]
      const tasks = (await readTasks()).filter(t => ids.includes(sessionOf(t) ?? ""))
      return json({ tasks: tasks.map(({ file, line, text, priority, due, project }) => ({ file, line, text, priority, due, project })) })
    }
  }
  return null
}

export async function handleRead(url: URL): Promise<Response | null> {
  const path = url.pathname
  if (path === "/api/state") {
    const text = await latestJson()
    return text ? new Response(text, { headers: { "content-type": "application/json" } }) : json({ error: "The board is not ready" }, 503)
  }
  if (path === "/api/stream") return stream()
  if (path === "/api/repos") return json({ repos: await knownRepos() })
  if (path === "/api/digest") return json({ digest: await lastDigest() })
  if (path === "/api/search") return json({ results: await searchResults(url.searchParams.get("q") ?? "") })
  if (path === "/api/transcribe") return json({ ready: await voiceReady() })
  if (path === "/api/setup") return json(await setupStatus())
  const file = path.match(/^\/api\/uploads\/(.+)$/)
  if (file) return sentFile(decodeURIComponent(file[1]!))
  const session = path.match(/^\/api\/sessions\/([\w-]+)\/(\w+)$/)
  if (session) return sessionRead(session[1]!, session[2]!, url)
  return null
}
