// The left column: new session and "Catch me up", the three views, the repos
// to filter by, the plan's rate limits, what the sessions take in memory, the
// folder of sent files, and the live connection, notifications and keyboard
// help at the foot.
import { html, useContext, useState } from "../vendor/preact-htm.js"
import { MEMORY_WARN, memText } from "./components.js"
import { Ctx, Kbd } from "./ctx.js"
import { Icon } from "./icons.js"
import { ago, bytesText, hue, post } from "./util.js"

export function Sidebar({ data, repoFilter, view, connected, notify, sound }) {
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
    <${Limits} limits=${data.limits} cards=${data.cards} />
    <${SessionsMemory} data=${data} />
    <button class=${`side-uploads ${uploadsTone}`} title="Open the sent files folder in Finder"
      onClick=${async () => !(await post("/api/uploads/open")).body.ok && ui.toast("Could not open the folder")}>
      <${Icon} name="paperclip" size=${14} /><span>Sent files</span><span class="n">${bytesText(data.uploadsBytes ?? 0)}</span></button>
    <div class="side-foot">
      <span class=${`live ${connected ? "on" : ""}`}><i></i>${connected ? "Live" : "Reconnecting…"}</span>
      <button class=${`ghost-btn ${notify === "on" ? "on" : ""}`} onClick=${() => ui.toggleNotify()}
        title=${notify === "on" ? "Notifications on: a macOS notification when a session asks you something while you are in another window. Click to turn them off" : notify === "blocked" ? "Chrome blocks notifications for this app" : "Notify me (macOS) when a session asks me something while I am in another window"}>
        <${Icon} name=${notify === "on" ? "bell" : "bellOff"} size=${15} /></button>
      <button class=${`ghost-btn ${sound === "on" ? "on" : ""}`} onClick=${() => ui.toggleSound()}
        title=${sound === "on" ? "Sound on: a chime when a session finishes or asks you something, also while you look at the board. Click to turn it off" : "Play a chime when a session finishes or asks me something, also while I look at the board"}>
        <${Icon} name=${sound === "on" ? "volume" : "volumeOff"} size=${15} /></button>
      <button class="ghost-btn" onClick=${() => ui.openDialog("setup")} title="Setup: hook, mod, dictation, tasks…">
        <${Icon} name="gear" size=${15} /></button>
      <button class="ghost-btn" onClick=${() => ui.openDialog("help")} title="Keyboard shortcuts (?)">
        <${Icon} name="keyboard" size=${15} /><${Kbd}>?<//>
      </button>
    </div>
  </aside>`
}

// ---------- what the sessions take in memory ----------

const PRESSURE = { warning: "Mac short of memory", critical: "Mac out of memory" }

// The sessions together (their processes and what they started); open, the
// ones that take the most, each a click from its conversation.
function SessionsMemory({ data }) {
  const ui = useContext(Ctx)
  const [isOpen, setOpen] = useState(false)
  const [isSure, setSure] = useState(false) // "Stop them" asks once more
  const m = data.memory
  if (!m?.total) return null
  const heavy = data.cards.filter(c => c.memory?.total >= 100 * 1024 ** 2).sort((a, b) => b.memory.total - a.memory.total)
  const tone = m.pressure !== "normal" || heavy.some(c => c.memory.total >= MEMORY_WARN) ? "tone-run" : ""
  // Commands left running and unused for a while (lib/memory.ts): all at once.
  const forgotten = data.cards.flatMap(c => (c.memory?.items ?? []).filter(i => i.isForgotten).map(i => ({ ...i, session: c.title })))
  const forgottenBytes = forgotten.reduce((sum, i) => sum + i.bytes, 0)
  const stopForgotten = async () => {
    if (!isSure) return (setSure(true), setTimeout(() => setSure(false), 4000))
    setSure(false)
    const res = await post("/api/memory/stopforgotten")
    ui.toast(res.body.ok ? `Stopped ${res.body.stopped} of ${forgotten.length}` : (res.body.error ?? "Could not stop them"))
  }
  return html`<div class="side-memory">
    <button class=${`side-uploads ${tone}`} aria-expanded=${isOpen} onClick=${() => setOpen(!isOpen)}
      title="Memory your sessions and what they started take on this Mac (Activity Monitor's Memory column). Click to see which">
      <${Icon} name="gauge" size=${14} /><span>Sessions</span>
      ${PRESSURE[m.pressure] && html`<span class="mem-pressure">${PRESSURE[m.pressure]}</span>`}
      <span class="n">${memText(m.total)}</span></button>
    ${forgotten.length > 0 && html`<div class="mem-forgotten"
      title=${`Up for hours and idle for over 30 min:\n${forgotten.map(i => `• ${i.label}${i.cwd ? ` · ${i.cwd}` : ""} · ${memText(i.bytes)} (${i.session})`).join("\n")}`}>
      <span>${forgotten.length} left running, unused · ${memText(forgottenBytes)}</span>
      <button class=${`link-btn ${isSure ? "sure" : ""}`} onClick=${stopForgotten}>${isSure ? "Sure? Stop them" : "Stop them"}</button>
    </div>`}
    ${isOpen && html`<ul class="mem-list">
      ${heavy.map(c => html`<li key=${c.id}><button class=${c.memory.total >= MEMORY_WARN ? "warn" : ""} onClick=${() => ui.openReader(c.id)}
        title=${c.memory.items.filter(i => i.bytes >= 10 * 1024 ** 2).map(i => `• ${i.label}${i.cwd ? ` · ${i.cwd}` : ""} · ${memText(i.bytes)}`).join("\n")}>
        <span class="t">${c.title}</span><span class="n">${memText(c.memory.total)}</span></button></li>`)}
      ${!heavy.length && html`<li class="muted">No session takes 100 MB</li>`}
    </ul>`}
  </div>`
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

// A time later today ("14:20"), or with its day.
function clockOf(t, now) {
  const d = new Date(t)
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
  return new Date(now).toDateString() === d.toDateString() ? time : `${d.toLocaleDateString("en-GB", { weekday: "short" })} ${time}`
}

function resetAt(t, now) {
  const d = new Date(t)
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
  if (new Date(now).toDateString() === d.toDateString()) return `today at ${time}`
  if (new Date(now + 86400_000).toDateString() === d.toDateString()) return `tomorrow at ${time}`
  return `${d.toLocaleDateString("en-GB", { weekday: "long" })} at ${time}`
}

// Where a window gets at this pace: full before it resets (and when), or
// how much it will have used when it does. Too early in it to tell: null.
function forecast(pct, reset, span, now) {
  const gone = span - (reset - now)
  if (pct < 3 || gone < span * 0.08) return null
  const rate = pct / gone
  const fullAt = now + (100 - pct) / rate
  return fullAt < reset ? { fullAt } : { atReset: Math.min(100, Math.round(pct + rate * (reset - now))) }
}

// The sessions that spent the most of the last 5 hours (API prices as the
// measure: the plan does not say what each one used).
function topSpenders(cards) {
  const spent = cards.filter(c => c.usage?.recentCost > 0)
  const total = spent.reduce((sum, c) => sum + c.usage.recentCost, 0)
  return total ? spent.sort((a, b) => b.usage.recentCost - a.usage.recentCost).slice(0, 3).map(c => ({ card: c, share: Math.round((c.usage.recentCost / total) * 100) })) : []
}

// The account's rate-limit windows, as the freshest session read them (the
// bridge mod), in the sidebar: how much is used (amber from 70%, red from
// 90%), a mark for the time gone by in the window, when it resets, whether
// the use runs ahead of that time and where it gets at this pace; under the
// 5-hour window, which sessions used most of it.
function Limits({ limits, cards = [] }) {
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
      ahead: reset && span && !hasReset ? forecast(w.percentUsed, reset, span, ui.now) : null,
    }
  })
  const spenders = topSpenders(cards)
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
        ${r.ahead && html`<div class=${`limit-ahead ${r.ahead.fullAt ? "full" : ""}`} title="If you keep the pace of the time gone by in this window">
          ${r.ahead.fullAt ? html`At this pace, full at <b>${clockOf(r.ahead.fullAt, ui.now)}</b>` : html`At this pace, about <b>${r.ahead.atReset}%</b> at reset`}</div>`}
        ${r.kind === "five_hour" && spenders.length > 0 && html`<div class="limit-spenders"
          title="Share of what your sessions spent in the last 5 hours, at API prices (the plan does not say what each one used)">
          ${spenders.map(({ card, share }) => html`<button key=${card.id} onClick=${() => ui.openReader(card.id)}><span class="t">${card.title}</span><span class="n">${share}%</span></button>`)}
        </div>`}
      </div>`,
    )}
  </section>`
}
