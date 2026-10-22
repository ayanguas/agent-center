// The left column: new session and "Catch me up", the three views, the repos
// to filter by, the plan's rate limits, the folder of sent files, and the
// live connection, notifications and keyboard help at the foot.
import { html, useContext } from "../vendor/preact-htm.js"
import { Ctx, Kbd } from "./ctx.js"
import { Icon } from "./icons.js"
import { ago, bytesText, hue, post } from "./util.js"

export function Sidebar({ data, repoFilter, view, connected, notify }) {
  const ui = useContext(Ctx)
  const open = data.cards.filter(c => c.column !== "done")
  const asking = open.filter(c => c.column === "asking").length
  const unread = open.filter(c => c.isUnread).length
  // The folder of sent files: amber from 500 MB, red from 1 GB, time to empty it.
  const bytes = data.uploadsBytes ?? 0
  const uploadsTone = bytes >= 1e9 ? "tone-bad" : bytes >= 5e8 ? "tone-ask" : ""
  return html`<aside class="sidebar">
    <div class="brand">
      <span class="logo"><i></i><i></i><i></i></span>
      <span>Agent Center</span>
    </div>
    <div class="side-actions">
      <button class="btn primary" onClick=${() => ui.openDialog("new")} title="New session (N)">
        <${Icon} name="plus" size=${15} />New session<${Kbd}>N<//></button>
      <button class="btn" onClick=${() => ui.openDialog("digest")} title="Summary of what your sessions did since you last looked (D)">
        <${Icon} name="sun" size=${14} />Catch me up<${Kbd}>D<//></button>
    </div>
    <nav class="nav">
      <button class=${view === "inbox" ? "on" : ""} onClick=${() => ui.setView("inbox")} title="Inbox (1)">
        <${Icon} name="inbox" />Inbox
        ${unread > 0 && html`<span class="pill new" title="Updated since you last looked">${unread} new</span>`}
        ${asking > 0 && html`<span class="pill" title="Asking you something">${asking}</span>`}
      </button>
      <button class=${view === "board" ? "on" : ""} onClick=${() => ui.setView("board")} title="Board (2)">
        <${Icon} name="board" />Board
      </button>
      <button class=${view === "canvas" ? "on" : ""} onClick=${() => ui.setView("canvas")} title="Canvas (3)">
        <${Icon} name="canvas" />Canvas
      </button>
    </nav>
    <div class="side-title">Repos</div>
    <nav class="nav repos">
      <button class=${!repoFilter ? "on" : ""} onClick=${() => ui.setRepoFilter(null)}>
        <i class="swatch all"></i>All<span class="n">${open.length}</span>
      </button>
      ${data.repos.map(
        r => html`<button key=${r.root} class=${repoFilter === r.root ? "on" : ""} title=${r.root}
          onClick=${() => ui.setRepoFilter(repoFilter === r.root ? null : r.root)}>
          <i class="swatch" style=${`--hue:${hue(r.name)}`}></i><span class="ellipsis">${r.name}</span><span class="n">${r.count || ""}</span>
        </button>`,
      )}
    </nav>
    <${Limits} limits=${data.limits} />
    <button class=${`side-uploads ${uploadsTone}`} title="Open the sent files folder in Finder"
      onClick=${async () => !(await post("/api/uploads/open")).body.ok && ui.toast("Could not open the folder")}>
      <${Icon} name="paperclip" size=${14} /><span>Sent files</span><span class="n">${bytesText(data.uploadsBytes ?? 0)}</span></button>
    <div class="side-foot">
      <span class=${`live ${connected ? "on" : ""}`}><i></i>${connected ? "Live" : "Reconnecting…"}</span>
      <button class=${`ghost-btn ${notify === "on" ? "on" : ""}`} onClick=${() => ui.toggleNotify()}
        title=${notify === "on" ? "Notifications on: you get one when a session asks you something. Click to turn them off" : notify === "blocked" ? "Chrome blocks notifications for this app" : "Notify me when a session asks me something"}>
        <${Icon} name=${notify === "on" ? "bell" : "bellOff"} size=${15} /></button>
      <button class="ghost-btn" onClick=${() => ui.openDialog("setup")} title="Setup: hook, mod, dictation, tasks…">
        <${Icon} name="gear" size=${15} /></button>
      <button class="ghost-btn" onClick=${() => ui.openDialog("help")} title="Keyboard shortcuts (?)">
        <${Icon} name="keyboard" size=${15} /><${Kbd}>?<//>
      </button>
    </div>
  </aside>`
}

// ---------- the plan's limits ----------

const WINDOW_MS = { five_hour: 5 * 3600_000, seven_day: 7 * 86400_000, seven_day_opus: 7 * 86400_000, seven_day_sonnet: 7 * 86400_000 }

const PACE_SHORT = { under: "under pace", even: "on pace", over: "over pace" }
const LIMIT_NAME = { five_hour: "5 hours", seven_day: "Week", seven_day_opus: "Week · Opus", seven_day_sonnet: "Week · Sonnet" }

// Time left until a window resets: "34 min", "2 h 10 min", "2 d 10 h".
function untilText(ms) {
  const min = Math.max(0, Math.ceil(ms / 60_000))
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return min % 60 ? `${h} h ${min % 60} min` : `${h} h`
  return h % 24 ? `${Math.floor(h / 24)} d ${h % 24} h` : `${Math.floor(h / 24)} d`
}

function resetAt(t, now) {
  const d = new Date(t)
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
  if (new Date(now).toDateString() === d.toDateString()) return `today at ${time}`
  if (new Date(now + 86400_000).toDateString() === d.toDateString()) return `tomorrow at ${time}`
  return `${d.toLocaleDateString("en-GB", { weekday: "long" })} at ${time}`
}

// The account's rate-limit windows, as the freshest session read them (the
// bridge mod), in the sidebar: how much is used (amber from 70%, red from
// 90%), a mark for the time gone by in the window, when it resets and whether
// the use runs ahead of that time.
function Limits({ limits }) {
  const ui = useContext(Ctx)
  if (!limits?.windows?.length) return null
  const isOld = ui.now - limits.at > 30 * 60_000
  const rows = limits.windows.map(w => {
    const reset = w.resetsAt ? Date.parse(w.resetsAt) : null
    const hasReset = reset !== null && reset <= ui.now
    const pct = hasReset ? 0 : Math.round(w.percentUsed)
    const span = WINDOW_MS[w.kind]
    const elapsed = reset && span && !hasReset ? Math.min(100, Math.max(0, Math.round(100 - ((reset - ui.now) / span) * 100))) : null
    return {
      kind: w.kind,
      label: LIMIT_NAME[w.kind] ?? w.kind,
      pct,
      tone: pct >= 90 ? "bad" : pct >= 70 ? "ask" : "ok",
      reset,
      hasReset,
      left: reset && !hasReset ? untilText(reset - ui.now) : null,
      elapsed,
      // Use against time gone by, with 5 points of slack.
      pace: elapsed === null ? null : pct > elapsed + 5 ? "over" : pct < elapsed - 5 ? "under" : "even",
    }
  })
  return html`<section class=${`side-limits ${isOld ? "old" : ""}`}
    title=${isOld ? `Data from ${ago(limits.at, ui.now)} ago: no open session has updated it` : "Plan limits"}>
    ${rows.map(
      r => html`<div key=${r.kind} class=${`limit-row tone-${r.tone}`}>
        <div class="limit-row-head"><b>${r.label}</b><span class="limit-pct">${r.pct}%</span></div>
        <div class="limit-track" title=${r.elapsed !== null ? `${r.elapsed}% of the time has passed` : ""}><i style=${`width:${Math.min(100, r.pct)}%`}></i>
          ${r.elapsed !== null && html`<s style=${`left:${r.elapsed}%`}></s>`}</div>
        <div class="limit-row-foot">
          ${r.hasReset ? "Already reset" : r.reset ? html`Resets in <b>${r.left}</b>` : "No reset time"}
        </div>
        ${(r.reset && !r.hasReset) && html`<div class="limit-pace">${resetAt(r.reset, ui.now)}${r.pace && html` · <span class=${`pace-${r.pace}`}>${PACE_SHORT[r.pace]}</span>`}</div>`}
      </div>`,
    )}
  </section>`
}
