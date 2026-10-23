// The list views: the board (one column per state, or one lane per repo, with
// drag and drop between columns), the inbox (one list grouped by state) and
// the search results. A click, or Enter on a focused card or row, opens the
// conversation.
import { html, useContext, useState } from "../vendor/preact-htm.js"
import { Actions, Context, Meta, RepoIcon, RepoTag, StateIcon, ageText, onOpenKey, urgencyOf } from "./components.js"
import { Ctx } from "./ctx.js"
import { Icon } from "./icons.js"
import { COLUMNS, STATES, ago, hue, keep, load, plain } from "./util.js"

// ---------- board ----------

function Card({ card, inStack = false }) {
  const ui = useContext(Ctx)
  const isSelected = ui.selected === card.id
  const isReading = ui.reader?.id === card.id
  return html`<article
    class=${`card ${isSelected ? "selected" : ""} ${isReading ? "reading" : ""} ${ui.parkMenu === card.id ? "raised" : ""} ${card.isUnread ? "unread" : ""} ${urgencyOf(card, ui.now)}`}
    data-id=${card.id} style=${`--hue:${hue(card.repo)}`} tabindex="0" draggable="true"
    onClick=${() => ui.openReader(card.id)} onKeyDown=${onOpenKey(() => ui.openReader(card.id))}
    onDragStart=${e => {
      e.dataTransfer.setData("text/plain", card.id)
      e.dataTransfer.effectAllowed = "move"
      ui.setDragging(card)
    }}
    onDragEnd=${() => ui.setDragging(null)}>
    <header>
      <${StateIcon} card=${card} size=${30} />
      <div class="card-head">
        <h3>${card.title}</h3>
        <div class="card-sub">
          ${!inStack && html`<${RepoTag} name=${card.repo} />`}
          ${card.branch && html`<span class="branch" title=${card.branch}>${card.branch}</span>`}
          <span class="age" title=${card.waitingSince ? "How long it has been waiting for you" : new Date(card.lastActivity ?? card.updatedAt).toLocaleString("en-GB")}>
            ${ageText(card, ui.now)}</span>
        </div>
      </div>
      ${card.isUnread && html`<span class="new-badge" title="Updated since you last looked at it">New</span>`}
      ${card.pinned && html`<span class="pin" title="Pinned: it shows first in its column"><${Icon} name="star" size=${13} /></span>`}
    </header>
    <${Context} card=${card} />
    <${Meta} card=${card} />
    <${Actions} card=${card} compact />
  </article>`
}

function dropAction(card, column) {
  if (!card || card.column === column) return null
  if (column === "parked") return ["park", { until: null }]
  if (column === "done") return ["done", {}]
  if (column === "pending" && card.column === "review") return ["seen", {}]
  if (card.column === "parked") return ["unpark", {}]
  if (card.column === "done") return ["undone", {}]
  return null
}

// Consecutive cards of one repository, in the column's time order: runs of
// two or more show as one group; the order itself never changes.
function runsOf(list) {
  const runs = []
  for (const card of list) {
    const last = runs.at(-1)
    if (last && last.repoRoot === card.repoRoot && last.pinned === card.pinned) last.cards.push(card)
    else runs.push({ repoRoot: card.repoRoot, repo: card.repo, pinned: card.pinned, cards: [card] })
  }
  return runs
}

// Every run is a group, one card or many: the repo heads it once.
function Stack({ run }) {
  return html`<div class="stack" style=${`--hue:${hue(run.repo)}`}>
    <div class="stack-head"><${RepoIcon} name=${run.repo} size=${16} /><span>${run.repo}</span>
      ${run.cards.length > 1 && html`<span class="count">${run.cards.length}</span>`}</div>
    ${run.cards.map(card => html`<${Card} key=${card.id} card=${card} inStack />`)}
  </div>`
}

// The cards of one column (in one lane, when grouped): a drop target too.
function Cell({ col, list, over, setOver, header, stack = false }) {
  const ui = useContext(Ctx)
  const action = dropAction(ui.dragging, col)
  return html`<section class=${`column col-${col} ${over === col && action ? "drop" : ""} ${
    ui.dragging && !action && ui.dragging.column !== col ? "no-drop" : ""
  }`}
    onDragOver=${e => action && (e.preventDefault(), setOver(col))}
    onDragLeave=${e => !e.currentTarget.contains(e.relatedTarget) && setOver(null)}
    onDrop=${e => {
      e.preventDefault()
      setOver(null)
      const card = ui.dragging
      ui.setDragging(null)
      if (action) ui.act(card, action[0], action[1])
    }}>
    ${header}
    <div class="cards">
      ${stack
        ? runsOf(list).map(run => html`<${Stack} key=${run.cards[0].id} run=${run} />`)
        : list.map(card => html`<${Card} key=${card.id} card=${card} />`)}
      ${list.length === 0 && html`<p class="empty">${ui.dragging && action ? "Drop here" : header ? (col === "asking" ? "Nothing waiting for you" : "Empty") : ""}</p>`}
    </div>
  </section>`
}

const byPin = (a, b) => Number(b.pinned) - Number(a.pinned)

function ColumnHead({ col, count, done }) {
  const ui = useContext(Ctx)
  return html`<h2><i class=${`dot tone-${STATES[col].tone}`}></i>${STATES[col].label}<span class="count">${count || ""}</span>
    ${col === "done" && done?.length > 0 && !ui.dragging &&
    html`<button class="head-btn" onClick=${() => ui.archiveAll(done)} title="Archive all done sessions">
      <${Icon} name="archive" size=${13} />Archive all</button>`}</h2>`
}

export function Board({ cards, showDone, groupBy, repos }) {
  const ui = useContext(Ctx)
  const [over, setOver] = useState(null)
  const [folded, setFolded] = useState(() => load("foldedLanes", {}))
  const columns = COLUMNS.filter(c => c !== "done" || showDone || ui.dragging)
  const inCol = (list, col) => list.filter(c => c.column === col).sort(byPin)

  if (groupBy !== "repo")
    return html`<div class="board">
      ${columns.map(col => {
        const list = inCol(cards, col)
        return html`<${Cell} key=${col} col=${col} list=${list} over=${over} setOver=${setOver} stack
          header=${html`<${ColumnHead} col=${col} count=${list.length} done=${list} />`} />`
      })}
    </div>`

  // Swimlanes: one row per repository, the state columns above them all.
  const lanes = repos
    .map(r => ({ ...r, cards: cards.filter(c => c.repoRoot === r.root && columns.includes(c.column)) }))
    .filter(l => l.cards.length > 0)
  const fold = root => {
    const next = { ...folded, [root]: !folded[root] }
    setFolded(next)
    keep("foldedLanes", next)
  }
  return html`<div class="board lanes" style=${`--cols:${columns.length}`}>
    <div class="lane-heads">
      ${columns.map(col => html`<div key=${col} class=${`column col-${col} head-only`}>
        <${ColumnHead} col=${col} count=${inCol(cards, col).length} done=${inCol(cards, "done")} /></div>`)}
    </div>
    ${lanes.map(lane => {
      const isFolded = folded[lane.root] && !lane.cards.some(c => c.id === ui.selected)
      const asking = lane.cards.filter(c => c.column === "asking").length
      return html`<section key=${lane.root} class=${`lane ${isFolded ? "folded" : ""}`} data-lane=${lane.root} style=${`--hue:${hue(lane.name)}`}>
        <button class="lane-title" onClick=${() => fold(lane.root)} aria-expanded=${!isFolded} title=${lane.root}>
          <${Icon} name=${isFolded ? "chevron" : "down"} size=${14} />
          <${RepoIcon} name=${lane.name} size=${18} />
          <span class="lane-name">${lane.name}</span>
          <span class="count">${lane.cards.length}</span>
          ${asking > 0 && html`<span class="pill-ask">${asking} asking you</span>`}
        </button>
        ${!isFolded && html`<div class="lane-cells">
          ${columns.map(col => html`<${Cell} key=${col} col=${col} list=${inCol(lane.cards, col)} over=${over === `${lane.root}|${col}` ? col : null}
            setOver=${c => setOver(c ? `${lane.root}|${c}` : null)} />`)}
        </div>`}
      </section>`
    })}
  </div>`
}

// ---------- inbox: one list, grouped by state ----------

function Row({ card }) {
  const ui = useContext(Ctx)
  const isSelected = ui.selected === card.id
  const isReading = ui.reader?.id === card.id
  return html`<div class=${`row ${isSelected ? "selected" : ""} ${isReading ? "reading" : ""} ${ui.parkMenu === card.id ? "raised" : ""} ${card.isUnread ? "unread" : ""} ${urgencyOf(card, ui.now)}`}
    data-id=${card.id} style=${`--hue:${hue(card.repo)}`} tabindex="0"
    onClick=${() => ui.openReader(card.id)} onKeyDown=${onOpenKey(() => ui.openReader(card.id))}>
    <div class="row-main">
      <div class="row-line">
        <${StateIcon} card=${card} size=${24} />
        ${card.isUnread && html`<span class="new-badge" title="Updated since you last looked at it">New</span>`}
        <span class="row-title">${card.title}</span>
        <${RepoTag} name=${card.repo} />
        ${card.pinned && html`<span class="pin" title="Pinned"><${Icon} name="star" size=${11} /></span>`}
      </div>
      <${Context} card=${card} lines=${1} />
    </div>
    <${Meta} card=${card} />
    <span class="age">${ageText(card, ui.now)}</span>
    <${Actions} card=${card} />
  </div>`
}

export function Inbox({ cards, showDone }) {
  const ui = useContext(Ctx)
  const [folded, setFolded] = useState({ parked: true })
  const groups = [
    ["pinned", "Pinned", cards.filter(c => c.pinned && c.column !== "done")],
    ...COLUMNS.filter(c => c !== "done" || showDone).map(col => [
      col,
      STATES[col].label,
      cards.filter(c => c.column === col && !(c.pinned && c.column !== "done")),
    ]),
  ].filter(([key, , list]) => list.length > 0 || key === "asking")
  return html`<div class="inbox">
    ${groups.map(([key, label, list]) => {
      const isFolded = folded[key] && !list.some(c => c.id === ui.selected)
      return html`<section key=${key} class=${`group group-${key}`}>
        <div class="group-bar">
        <button class="group-head" data-fly=${key} onClick=${() => setFolded(f => ({ ...f, [key]: !f[key] }))} aria-expanded=${!isFolded}>
          <${Icon} name=${isFolded ? "chevron" : "down"} size=${14} />
          ${key === "pinned" ? html`<${Icon} name="star" size=${12} class="tone-ask" />` : html`<i class=${`dot tone-${STATES[key].tone}`}></i>`}
          ${label}<span class="count">${list.length}</span>
        </button>
        ${key === "done" && list.length > 0 &&
        html`<button class="head-btn" onClick=${() => ui.archiveAll(list)} title="Archive all done sessions">
          <${Icon} name="archive" size=${13} />Archive all</button>`}
        </div>
        ${!isFolded &&
        (list.length
          ? list.map(card => html`<${Row} key=${card.id} card=${card} />`)
          : html`<p class="empty-row">Nothing is waiting for you. When a session asks you something, it shows up here.</p>`)}
      </section>`
    })}
  </div>`
}

// ---------- search ----------

export function SearchResults({ query, results }) {
  const ui = useContext(Ctx)
  if (!results) return html`<div class="results"><p class="muted">Searching…</p></div>`
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 1)
  const mark = text => {
    const parts = []
    let rest = text
    const re = new RegExp(`(${terms.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "i")
    while (terms.length && rest) {
      const m = rest.match(re)
      if (!m) break
      parts.push(rest.slice(0, m.index), html`<mark>${m[0]}</mark>`)
      rest = rest.slice(m.index + m[0].length)
    }
    parts.push(rest)
    return parts
  }
  return html`<div class="results">
    <p class="muted">${results.length ? `${results.length} ${results.length === 1 ? "conversation" : "conversations"}` : "No results"}</p>
    ${results.map(
      r => html`<div key=${r.id} class=${`row result ${ui.selected === r.id ? "selected" : ""} ${ui.reader?.id === r.id ? "reading" : ""}`}
        data-id=${r.id} tabindex="0" onClick=${() => ui.openReader(r.id)} onKeyDown=${onOpenKey(() => ui.openReader(r.id))}>
        <div class="row-main">
          <div class="row-line">
            ${r.repo && html`<${RepoTag} name=${r.repo} />`}
            <span class="row-title">${plain(r.title)}</span>
            ${r.isOnBoard && html`<span class="tag">in the inbox</span>`}
            ${r.isArchived && html`<span class="tag">archived</span>`}
          </div>
          <p class="snippet">${r.role === "user" ? "» " : ""}${mark(r.snippet)}</p>
        </div>
        <span class="tag">${r.matches} ${r.matches === 1 ? "message" : "messages"}</span>
        <span class="age">${ago(r.updatedAt, ui.now)}</span>
        <div class="actions"><button class="icon-btn" title="Open in Claude" onClick=${e => (e.stopPropagation(), ui.launch(r.id))}>
          <${Icon} name="external" size=${15} /></button></div>
      </div>`,
    )}
  </div>`
}
