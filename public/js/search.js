// The search palette (⌘K, /, or the search field), as in Claude desktop: a
// window over the board with the query, tabs (all, sessions, archived)
// and the conversations it finds: the title and a quote of where the words
// are, both marked. Empty, it lists the latest sessions. ↑↓ choose, ↵ opens
// the conversation, ⌘↵ opens it in Claude, Tab changes the tab, Esc closes.
// No animation: it opens and closes many times a day.
import { html, useContext, useEffect, useLayoutEffect, useRef, useState } from "../vendor/preact-htm.js"
import { StateIcon } from "./components.js"
import { Ctx, Kbd } from "./ctx.js"
import { Icon } from "./icons.js"
import { ago, get, plain } from "./util.js"

const TABS = [
  ["all", "All", () => true],
  ["sessions", "Sessions", r => !r.isArchived],
  ["archived", "Archived", r => r.isArchived],
]

// A quote that starts a few words before the first match, so the marked
// words show even when the line is cut.
function quoteOf(text, terms) {
  const clean = text.replace(/^…|…$/g, "").trim()
  const at = Math.min(...terms.map(t => clean.toLowerCase().indexOf(t)).filter(i => i >= 0))
  if (!isFinite(at) || at < 24) return clean
  const from = clean.lastIndexOf(" ", at - 16)
  return `…${clean.slice(from > 0 ? from + 1 : at - 16)}`
}

// The query's words in `text`, marked.
function marked(text, terms) {
  if (!terms.length || !text) return text
  const re = new RegExp(`(${terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi")
  return text.split(re).map((part, i) => (i % 2 ? html`<mark>${part}</mark>` : part))
}

export function SearchPalette({ cards, onOpen, onClose }) {
  const ui = useContext(Ctx)
  const [query, setQuery] = useState("")
  const [results, setResults] = useState(null) // null: searching (or nothing typed)
  const [tab, setTab] = useState("all")
  const [index, setIndex] = useState(0)
  const field = useRef()
  const list = useRef()
  useLayoutEffect(() => field.current?.focus(), [])

  useEffect(() => {
    setIndex(0)
    if (!query.trim()) return setResults(null)
    let alive = true
    const timer = setTimeout(async () => {
      const res = await get(`/api/search?q=${encodeURIComponent(query.trim())}`)
      if (alive) setResults(res?.results ?? [])
    }, 150)
    return () => ((alive = false), clearTimeout(timer))
  }, [query])

  const terms = query.trim().toLowerCase().split(/\s+/).filter(t => t.length > 1)
  const byId = new Map(cards.map(c => [c.id, c]))
  // Nothing typed: the latest sessions, to jump to one.
  const recent = [...cards].sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0)).slice(0, 8)
    .map(c => ({ id: c.id, title: c.title, updatedAt: c.lastActivity ?? c.updatedAt, isArchived: false, snippet: "" }))
  const all = query.trim() ? (results ?? []) : recent
  const counts = Object.fromEntries(TABS.map(([key, , keep]) => [key, all.filter(keep).length]))
  const rows = all.filter(TABS.find(([key]) => key === tab)[2])
  const chosen = rows[Math.min(index, rows.length - 1)]

  useEffect(() => list.current?.querySelector(".pal-row.on")?.scrollIntoView({ block: "nearest" }), [index, tab])

  const open = (r, inClaude = false) => {
    if (!r) return
    onClose()
    if (inClaude) ui.launch(r.id)
    else onOpen(r)
  }
  const onKey = e => {
    if (e.key === "ArrowDown") (e.preventDefault(), setIndex(i => Math.min(i + 1, rows.length - 1)))
    else if (e.key === "ArrowUp") (e.preventDefault(), setIndex(i => Math.max(i - 1, 0)))
    else if (e.key === "Enter") (e.preventDefault(), open(chosen, e.metaKey || e.ctrlKey))
    else if (e.key === "Tab") {
      e.preventDefault()
      const i = TABS.findIndex(([key]) => key === tab)
      setTab(TABS[(i + (e.shiftKey ? TABS.length - 1 : 1)) % TABS.length][0])
      setIndex(0)
    } else if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), onClose())
  }

  return html`<div class="pal-backdrop" onPointerDown=${e => e.target === e.currentTarget && onClose()}>
    <div class="palette" role="dialog" aria-label="Search conversations" onKeyDown=${onKey}>
      <div class="pal-input">
        <${Icon} name="search" size=${16} />
        <input ref=${field} value=${query} placeholder="Search every conversation…" spellcheck="false"
          onInput=${e => setQuery(e.target.value)} aria-label="Search" />
        <button class="icon-btn" title="Close (Esc)" onClick=${onClose}><${Icon} name="x" size=${15} /></button>
      </div>
      <div class="pal-tabs" role="tablist">
        ${TABS.map(([key, label]) => html`<button key=${key} role="tab" aria-selected=${tab === key} class=${tab === key ? "on" : ""}
          onClick=${() => (setTab(key), setIndex(0), field.current?.focus())}>${label}${counts[key] > 0 && html`<span class="n">${counts[key]}</span>`}</button>`)}
      </div>
      <div class="pal-list" ref=${list} role="listbox">
        ${!query.trim() && html`<p class="pal-head">Recent</p>`}
        ${query.trim() && results === null && html`<p class="pal-empty">Searching…</p>`}
        ${query.trim() && results !== null && rows.length === 0 && html`<p class="pal-empty">Nothing found${tab !== "all" ? " in this tab" : ""}.</p>`}
        ${rows.map((r, i) => {
          const card = byId.get(r.id)
          return html`<button key=${r.id} role="option" aria-selected=${r === chosen} class=${`pal-row ${r === chosen ? "on" : ""}`}
            onPointerMove=${() => i !== index && setIndex(i)} onClick=${e => open(r, e.metaKey || e.ctrlKey)}>
            <span class="pal-icon">${card ? html`<${StateIcon} card=${card} size=${20} />` : html`<${Icon} name=${r.isArchived ? "archive" : "chat"} size=${15} />`}</span>
            <span class="pal-title">${marked(plain(r.title), terms)}</span>
            ${r.snippet && html`<span class="pal-quote">“${marked(quoteOf(r.snippet, terms), terms)}”</span>`}
            ${r.isArchived && html`<span class="tag">archived</span>`}
            <span class="pal-age">${r.updatedAt ? ago(r.updatedAt, ui.now) : ""}</span>
          </button>`
        })}
      </div>
      <footer class="pal-foot">
        <span><${Kbd}>↑<//><${Kbd}>↓<//> choose</span><span><${Kbd}>↵<//> open</span><span><${Kbd}>⌘↵<//> open in Claude</span>
        <span><${Kbd}>Tab<//> tab</span><span><${Kbd}>Esc<//> close</span>
      </footer>
    </div>
  </div>`
}
