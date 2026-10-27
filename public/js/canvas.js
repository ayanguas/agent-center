// The canvas view: sessions as compact cards you place anywhere, named zones
// to group them, sticky notes (canvas-notes.js), an "Incoming" corner where
// new ones land, and "Done" as the band at the bottom: drop a card there (or
// press ✓) to mark it done, lift it back up to reopen it. By default the
// canvas fits the window, drawn smaller when it must; zoomed in, it scrolls.
import { html, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "../vendor/preact-htm.js"
import { Actions, BackgroundChip, Context, MemoryChip, OverlapChip, PendingChip, PrChip, StateIcon, UsageMeter, ageText, onOpenKey, stateOf, urgencyOf } from "./components.js"
import { CARD_H, CARD_W, ENTRY, GRID, dragHandler, layout, newZone, onCanvas, snap } from "./canvas-layout.js"
import { Note, follow, keyOf, newNote } from "./canvas-notes.js"
import { Ctx } from "./ctx.js"
import { Icon } from "./icons.js"
import { RunChip } from "./run.js"
import { hue, isTyping, keep, load, plain, post } from "./util.js"
import { origins, quietly } from "./motion.js"

const MAX_ZOOM = 1.5 // 150 % of the cards' real size
const MIN_ZOOM = 0.4 // zoomed out: more room around, cards at 40 %
// Semantic zoom: what a card shows depends on how big it is drawn. Far, only
// its state and title, drawn larger; mid, also one line of context; near, all.
const levelOf = scale => (scale < 0.62 ? "lod-far" : scale < 0.85 ? "lod-mid" : "lod-near")

function hashOf(id) {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return h
}


const inside = (rect, x, y) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom

// Dropped on "Done": below the band's top edge in the canvas, or on the dock
// that stands in for it while zoomed in.
const isOverDone = ev => {
  const dock = document.querySelector(".done-dock")
  if (dock && inside(dock.getBoundingClientRect(), ev.clientX, ev.clientY)) return true
  const area = document.querySelector(".done-area")
  const frame = document.querySelector(".canvas-frame")?.getBoundingClientRect()
  return !!area && ev.clientY >= area.getBoundingClientRect().top && (!frame || ev.clientY <= frame.bottom)
}
const markDone = on => document.querySelectorAll(".done-area, .done-dock").forEach(el => el.classList.toggle("drop", on))
// The folded zone under the pointer while a card is dragged: it takes it.
const markFolder = ev => {
  const over = ev && document.elementsFromPoint(ev.clientX, ev.clientY).find(e => e.matches?.(".zone.folder"))
  document.querySelectorAll(".zone.folder").forEach(el => el.classList.toggle("drop", el === over))
}

// While a card is dragged near an edge of a zoomed canvas, the canvas scrolls.
function edgeScroller(onScroll) {
  const box = document.querySelector(".canvas-frame")
  let vx = 0
  let vy = 0
  let raf = 0
  const tick = () => {
    box.scrollBy(vx, vy)
    onScroll()
    raf = vx || vy ? requestAnimationFrame(tick) : 0
  }
  return {
    update(ev) {
      if (!box || (box.scrollWidth <= box.clientWidth && box.scrollHeight <= box.clientHeight)) return
      const r = box.getBoundingClientRect()
      const E = 48
      vy = ev.clientY > r.bottom - E ? 14 : ev.clientY < r.top + E ? -14 : 0
      vx = ev.clientX > r.right - E ? 14 : ev.clientX < r.left + E ? -14 : 0
      if ((vx || vy) && !raf) raf = requestAnimationFrame(tick)
    },
    stop() {
      vx = vy = 0
      cancelAnimationFrame(raf)
      raf = 0
    },
    offset: () => ({ x: box?.scrollLeft ?? 0, y: box?.scrollTop ?? 0 }),
  }
}

// How tall each card was when last drawn: a card folded away in a zone is
// not on screen, and its place still counts when another joins the zone.
const heights = new Map()
const heightOf = id => heights.get(id) ?? CARD_H

// `at` is where the card sits on the canvas; `onDropped(card, to, ev, el, d)`
// gets the canvas point where it was let go. The canvas is drawn at `scale`,
// so a pointer move of 10 px is 10 / scale canvas units.
function CanvasCard({ card, at, scale, onDropped, z, isPicked = false, onPick, group, onHover }) {
  const ui = useContext(Ctx)
  const ref = useRef()
  useLayoutEffect(() => void (ref.current && heights.set(card.id, ref.current.offsetHeight)))
  const isDone = card.column === "done"
  const [state] = stateOf(card)
  const delay = -((hashOf(card.id) % 7000) / 1000) // stagger the nudges
  // The pointer's move plus what the canvas scrolled meanwhile, in canvas units.
  let scroll = null
  let start = null
  let last = { dx: 0, dy: 0, ev: null }
  const shift = () => {
    const o = scroll.offset()
    return { x: (last.dx + o.x - start.x) / scale, y: (last.dy + o.y - start.y) / scale }
  }
  const paint = () => {
    const d = shift()
    ref.current.style.transform = `translate(${d.x}px, ${d.y}px) rotate(1.5deg)`
    follow(card, d.x, d.y, false)
    group?.move(d)
    if (last.ev) markDone(!isDone && isOverDone(last.ev))
    markFolder(last.ev)
  }
  const onPointerDown = dragHandler({
    onStart: () => {
      onHover?.(null)
      ref.current.classList.add("dragging")
      scroll = edgeScroller(paint)
      start = scroll.offset()
    },
    onMove: (dx, dy, ev) => {
      last = { dx, dy, ev }
      paint()
      scroll.update(ev)
    },
    onDrop: (dx, dy, ev) => {
      last = { dx, dy, ev }
      scroll.stop()
      markDone(false)
      markFolder(null)
      const d = shift()
      onDropped(card, { x: at.x + d.x, y: at.y + d.y }, ev, ref.current, d)
    },
    onClick: ev => (ev?.metaKey || ev?.shiftKey ? onPick?.(true) : (onPick?.(false), ui.openReader(card.id))),
  })
  return html`<article ref=${ref} data-id=${card.id}
    class=${`ccard ${isPicked ? "picked" : ""} state-${state} ${isDone ? "" : urgencyOf(card, ui.now)} ${ui.selected === card.id ? "selected" : ""} ${ui.reader?.id === card.id ? "reading" : ""} ${card.isUnread ? "unread" : ""} ${ui.parkMenu === card.id ? "raised" : ""}`}
    style=${`left:${at.left ?? at.x}px;top:${at.top ?? at.y}px;--hue:${hue(card.repo)};animation-delay:${delay}s${z ? `;--z:${z}` : ""}`}
    tabindex="0" onPointerDown=${onPointerDown} onKeyDown=${onOpenKey(() => ui.openReader(card.id))}
    onPointerEnter=${e => e.pointerType === "mouse" && onHover?.(card.id, ref.current)} onPointerLeave=${() => onHover?.(null)}>
    <div class="ccard-top">
      <${StateIcon} card=${card} size=${22} />
      <span class="ctitle" title=${card.title}>${card.title}</span>
      ${card.pinned && html`<span class="pin" title="Pinned"><${Icon} name="star" size=${12} /></span>`}
      ${card.isUnread && html`<i class="cunread" title="New since you last looked"></i>`}
    </div>
    ${!isDone && html`<${Context} card=${card} lines=${2} />`}
    <footer class="ccard-foot">
      <span class="crepo" title=${card.branch ? `${card.repo} · ${card.branch}` : card.repo}><i></i>${card.repo}</span>
      <span class="cage">${ageText(card, ui.now)}</span>
      ${!isDone && html`<span class="csignals">
        <${OverlapChip} card=${card} />
        <${BackgroundChip} card=${card} />
        <${MemoryChip} card=${card} />
        <${RunChip} card=${card} />
        ${card.prs?.length === 1 && html`<${PrChip} pr=${card.prs[0]} repo=${card.repo} cardId=${card.id} />`}
        ${card.prs?.length > 1 && html`<button class="tag" title=${card.prs.map(pr => `#${pr.number} ${pr.title}`).join("\n")}
          onClick=${e => (e.stopPropagation(), ui.openReader(card.id, "prs"))}><${Icon} name="pr" size=${12} />${card.prs.length}</button>`}
        ${card.taskCount > 0 && html`<button class="tag tasks" title=${`${card.taskCount} ${card.taskCount === 1 ? "task" : "tasks"}`}
          onClick=${e => (e.stopPropagation(), ui.openReader(card.id, "tasks"))}><${Icon} name="tasks" size=${12} />${card.taskCount}</button>`}
        ${card.bridge?.pending > 0 && html`<${PendingChip} card=${card} />`}
        <${UsageMeter} usage=${card.usage} />
      </span>`}
    </footer>
    <${Actions} card=${card} compact />
  </article>`
}

// A card's preview, after a moment over it: what you asked last and the
// whole of what it says now (the card cuts it to a line or two), beside the
// card, at its real size whatever the zoom.
const PEEK_DELAY = 450
const PEEK_W = 340
function Peek({ card, rect }) {
  const ui = useContext(Ctx)
  const now = card.column === "asking" ? card.ask : card.column === "working" ? card.progress?.current : card.recap
  const p = card.progress
  const panel = document.querySelector(".app.with-reader .reader-slot .reader")?.getBoundingClientRect().left ?? innerWidth
  const left = rect.right + 12 + PEEK_W < panel ? rect.right + 12 : Math.max(8, rect.left - 12 - PEEK_W)
  const top = Math.min(Math.max(8, rect.top), innerHeight - 260)
  return html`<div class="peek" style=${`left:${left}px;top:${top}px;width:${PEEK_W}px`} role="tooltip">
    <header><${StateIcon} card=${card} size=${20} /><b>${card.title}</b></header>
    ${card.lastPrompt && html`<p class="peek-you"><span>You</span>${plain(card.lastPrompt)}</p>`}
    ${now && html`<p class=${`peek-now ${card.column === "asking" ? "ask" : ""}`}>${plain(now)}</p>`}
    ${p && card.column === "working" && html`<p class="peek-steps">Step ${Math.min(p.done + 1, p.total)} of ${p.total}</p>`}
    <footer><span class="crepo" style=${`--hue:${hue(card.repo)}`}><i></i>${card.repo}</span>${card.branch && html`<span class="mono">${card.branch}</span>`}<span>${ageText(card, ui.now)}</span></footer>
  </div>`
}

// Folding and unfolding a zone, and a card dropped on a folder, move only
// transform and opacity, with the board's ease-out (motion.js); nothing
// moves with reduced motion.
const FOLD_EASE = "cubic-bezier(0.22, 1, 0.36, 1)"
const isCalm = () => matchMedia("(prefers-reduced-motion: reduce)").matches
const FOLDER_H = 96 // about a folder tile's height
const folderClip = z => `inset(0 ${Math.max(0, z.w - CARD_W)}px ${Math.max(0, z.h - FOLDER_H)}px 0 round 14px)`

// The way from a card on the canvas to the middle of its zone's folder.
function towardFolder(el, zone) {
  const x = parseFloat(el.style.left)
  const y = parseFloat(el.style.top)
  return { dx: zone.x - x, dy: zone.y + FOLDER_H / 2 - (y + el.offsetHeight / 2) }
}

// A folded zone's summary: what of its sessions waits for you, works, is new.
function folderSummary(cards) {
  const count = test => cards.filter(test).length
  return [
    [count(c => c.column === "asking" && c.state !== "permission"), "asks you", "ask"],
    [count(c => c.column === "asking" && c.state === "permission"), "approval", "permission"],
    [count(c => c.column === "working"), "working", "work"],
    [count(c => c.isUnread && c.column !== "asking"), "new", "new"],
  ].filter(([n]) => n > 0)
}

// A zone groups the cards and notes inside it; folded ("collapsed"), it is a
// folder tile: its name, how many sessions it holds and what of them waits
// for you. Their places stay as they were: unfolding puts them back.
function Zone({ zone, scale, bounds, onChange, onRemove, onMoveWith, isNew = false, members = [] }) {
  const ui = useContext(Ctx)
  const ref = useRef()
  const nameField = useRef()
  const [isEditing, setEditing] = useState(isNew) // a zone just drawn asks for its name
  // Enter keeps the name and Esc drops it. Both end in a blur (the field goes
  // away), which must neither save twice nor save what Esc dropped.
  const isSettled = useRef(false)
  const finish = isSaving => {
    if (isSettled.current) return
    isSettled.current = true
    const name = nameField.current.value.trim() || zone.name
    if (isSaving && name !== zone.name) onChange({ ...zone, name })
    setEditing(false)
  }
  // A field added after the page loaded ignores `autofocus`: focus it by hand.
  useEffect(() => {
    if (!isEditing) return
    isSettled.current = false
    nameField.current?.focus()
    nameField.current?.select()
  }, [isEditing])
  const startDrag = dragHandler({
    onStart: () => ref.current.classList.add("dragging"),
    onMove: (dx, dy) => {
      ;[dx, dy] = within(zone, dx / scale, dy / scale)
      ref.current.style.transform = `translate(${dx}px, ${dy}px)`
      onMoveWith(zone, dx, dy, false)
    },
    onDrop: (dx, dy) => {
      ;[dx, dy] = within(zone, dx / scale, dy / scale)
      ref.current.classList.remove("dragging")
      ref.current.style.transform = ""
      onMoveWith(zone, dx, dy, true)
      onChange({ ...zone, x: snap(zone.x + dx), y: snap(zone.y + dy) })
    },
    onClick: () => zone.collapsed && fold(false), // a click on a folder unfolds it
  })
  // A zone stays on the visible canvas, above "Done": as big as it shows
  // (folded, a folder's size; unfolding makes room, below).
  const within = (z, dx, dy) => {
    const w = z.collapsed ? CARD_W : z.w
    const h = z.collapsed ? (ref.current?.offsetHeight ?? FOLDER_H) : z.h
    return [Math.min(Math.max(dx, -z.x), Math.max(0, bounds.w - z.x - w)), Math.min(Math.max(dy, -z.y), Math.max(0, bounds.h - z.y - h))]
  }
  const sizeOf = (dx, dy) => ({
    w: Math.max(160, Math.min(zone.w + dx / scale, bounds.w - zone.x)),
    h: Math.max(120, Math.min(zone.h + dy / scale, bounds.h - zone.y)),
  })
  const startResize = dragHandler({
    onMove: (dx, dy) => {
      const { w, h } = sizeOf(dx, dy)
      ref.current.style.width = `${w}px`
      ref.current.style.height = `${h}px`
    },
    onDrop: (dx, dy) => {
      const { w, h } = sizeOf(dx, dy)
      onChange({ ...zone, w: Math.max(160, Math.floor(w / GRID) * GRID), h: Math.max(120, Math.floor(h / GRID) * GRID) })
    },
  })
  // Folding: the cards fly into the folder, one after another, and the zone
  // closes up to its size; the change is saved once they are in. Unfolding
  // (below) plays it backwards.
  const closing = useRef(null)
  // Unfolding a folder left low or far right: the zone first moves (with
  // its cards) up or left as much as it needs to fit above "Done".
  const shift = useRef({ dx: 0, dy: 0 })
  const unfold = () => {
    const dx = Math.max(-zone.x, Math.min(0, bounds.w - zone.x - zone.w))
    const dy = Math.max(-zone.y, Math.min(0, bounds.h - zone.y - zone.h))
    shift.current = { dx, dy }
    if (dx || dy) onMoveWith(zone, dx, dy, true)
    onChange({ ...zone, x: zone.x + dx, y: zone.y + dy, collapsed: false })
  }
  const fold = isFolded => {
    quietly(members.map(c => c.id))
    if (!isFolded) return unfold()
    if (isCalm()) return onChange({ ...zone, collapsed: true })
    const flights = members
      .map(c => document.querySelector(`.ccard[data-id="${c.id}"]`))
      .filter(Boolean)
      .map((el, i) => {
        const { dx, dy } = towardFolder(el, zone)
        return el.animate([{ transform: "none", opacity: 1 }, { transform: `translate(${dx}px, ${dy}px) scale(0.35)`, opacity: 0 }],
          { duration: 240, delay: i * 18, easing: FOLD_EASE, fill: "forwards" })
      })
    closing.current = ref.current.animate([{ clipPath: "inset(0 round 14px)" }, { clipPath: folderClip(zone) }], { duration: 260, easing: FOLD_EASE, fill: "forwards" })
    Promise.all([closing.current, ...flights].map(a => a.finished)).catch(() => {}).finally(() => onChange({ ...zone, collapsed: true }))
  }
  const wasFolded = useRef(!!zone.collapsed)
  useLayoutEffect(() => {
    const was = wasFolded.current
    wasFolded.current = !!zone.collapsed
    closing.current?.cancel()
    closing.current = null
    if (was === !!zone.collapsed || isCalm() || !ref.current) return
    if (zone.collapsed) {
      ref.current.animate([{ transform: "scale(0.96)" }, { transform: "none" }], { duration: 220, easing: FOLD_EASE })
      return
    }
    // From where the folder was (the zone may have moved up to fit).
    const { dx: sx, dy: sy } = shift.current
    shift.current = { dx: 0, dy: 0 }
    const folderAt = { ...zone, x: zone.x - sx, y: zone.y - sy }
    ref.current.animate([{ clipPath: folderClip(zone), transform: `translate(${-sx}px, ${-sy}px)` }, { clipPath: "inset(0 round 14px)", transform: "none" }],
      { duration: 300, easing: FOLD_EASE })
    members.forEach((c, i) => {
      const el = document.querySelector(`.ccard[data-id="${c.id}"]`)
      if (!el) return
      const { dx, dy } = towardFolder(el, folderAt)
      el.animate([{ transform: `translate(${dx}px, ${dy}px) scale(0.35)`, opacity: 0 }, { transform: "none", opacity: 1 }],
        { duration: 320, delay: 40 + i * 22, easing: FOLD_EASE, fill: "backwards" })
    })
  }, [zone.collapsed])
  if (zone.collapsed)
    return html`<section ref=${ref} class="zone folder" data-zone=${zone.id} style=${`left:${zone.x}px;top:${zone.y}px;width:${CARD_W}px;--hue:${hue(zone.name)}`}
      onPointerDown=${startDrag} title="Click to unfold · drag to move it · drop a card on it to add it">
      <header class="zone-head">
        <${Icon} name="folder" size=${15} />
        <span class="zone-name">${zone.name}</span><span class="folder-count">${members.length}</span>
        <button class="icon-btn" title="Unfold" onClick=${() => fold(false)}><${Icon} name="expand" size=${13} /></button>
      </header>
      <div class="folder-states">
        ${folderSummary(members).map(([n, label, tone]) => html`<span key=${tone} class=${`folder-state ${tone}`}>${n} ${label}</span>`)}
        ${!members.length && html`<span class="muted">Empty</span>`}
      </div>
      ${members.length > 0 && html`<div class="folder-icons">
        ${members.slice(0, 9).map(c => html`<button key=${c.id} class="folder-icon" title=${c.title} onClick=${e => (e.stopPropagation(), ui.openReader(c.id))}>
          <${StateIcon} card=${c} size=${22} /></button>`)}
        ${members.length > 9 && html`<span class="folder-more">+${members.length - 9}</span>`}
      </div>`}
    </section>`
  return html`<section ref=${ref} class="zone" style=${`left:${zone.x}px;top:${zone.y}px;width:${zone.w}px;height:${zone.h}px;--hue:${hue(zone.name)}`}
    onPointerDown=${startDrag} title="Drag to move the zone with its cards and notes">
    <header class="zone-head" onDblClick=${() => setEditing(true)} title="Drag to move the zone · double-click to rename">
      ${isEditing
        ? html`<input ref=${nameField} class="zone-name-input" defaultValue=${zone.name} maxLength="60"
            onKeyDown=${e => {
              if (e.key === "Enter") finish(true)
              if (e.key === "Escape") (e.stopPropagation(), finish(false))
            }}
            onBlur=${() => finish(true)} />`
        : html`<span class="zone-name">${zone.name}</span>`}
      <button class="icon-btn zone-fold" title="Fold into a folder (its cards stay where they are)" onClick=${() => fold(true)}>
        <${Icon} name="shrink" size=${13} /></button>
      <button class="icon-btn zone-x" title="Remove the zone (the cards stay)" onClick=${() => onRemove(zone)}>
        <${Icon} name="x" size=${13} /></button>
    </header>
    <div class="zone-resize" onPointerDown=${e => (e.stopPropagation(), startResize(e))} title="Resize"></div>
  </section>`
}

// The done sessions "Done" has no room for: open, reopen or archive each.
function DoneList({ cards, bottom, onClose }) {
  const ui = useContext(Ctx)
  const ref = useRef()
  useEffect(() => {
    const away = e => !ref.current?.contains(e.target) && !e.target.closest?.(".done-more-tile") && onClose()
    const esc = e => e.key === "Escape" && (e.stopPropagation(), onClose())
    window.addEventListener("pointerdown", away, true)
    window.addEventListener("keydown", esc, true)
    return () => (window.removeEventListener("pointerdown", away, true), window.removeEventListener("keydown", esc, true))
  }, [])
  return html`<div class="done-list" ref=${ref} style=${`bottom:${bottom}px`} role="dialog" aria-label="More done sessions">
    <header><${Icon} name="check" size=${13} />${cards.length} more done</header>
    <ul>${cards.map(card => html`<li key=${card.id}>
      <button class="done-list-open" onClick=${() => (onClose(), ui.openReader(card.id))} title="Open the conversation">
        <span class="t">${card.title}</span><small>${card.repo} · ${ageText(card, ui.now)}</small></button>
      <button class="icon-btn" title="Reopen: back on the canvas" onClick=${() => ui.act(card, "undone")}><${Icon} name="undo" size=${14} /></button>
      <button class="icon-btn" title="Archive" onClick=${() => ui.act(card, "archive")}><${Icon} name="archive" size=${14} /></button>
    </li>`)}</ul>
  </div>`
}

// Space pans the canvas, except on these: there it presses, ticks or scrolls.
const SPACE_KEEPS = "button, a[href], summary, input, [role=button], [role=checkbox], [role=radio], [role=option], .reader-slot"

const DONE_HEAD = 48
const DONE_H = DONE_HEAD + CARD_H // the "Done" band: one row, at the bottom

export function Canvas({ cards, zones: savedZones, notes: savedNotes, isDrawingZone = false, onZoneDrawn }) {
  const ui = useContext(Ctx)
  const [local, setLocal] = useState({})
  const [zones, setZones] = useState(savedZones)
  const [notes, setNotes] = useState(savedNotes)
  // Text being typed is saved a moment later; until then the server's copy is
  // older than this one, so it does not replace it. Notes it has that this
  // list never knew (made elsewhere meanwhile) join it, and go in the save.
  const unsaved = useRef(null) // the save under way: { timer } while it waits
  const latestNotes = useRef(savedNotes) // what the save sends when it runs
  const synced = useRef(savedNotes) // the server's copy, as last seen
  useEffect(() => {
    if (!unsaved.current) {
      latestNotes.current = savedNotes
      setNotes(savedNotes)
    } else {
      const known = new Set([...synced.current, ...latestNotes.current].map(n => n.id))
      const added = savedNotes.filter(n => !known.has(n.id))
      if (added.length) {
        latestNotes.current = [...latestNotes.current, ...added]
        setNotes(latestNotes.current)
      }
    }
    synced.current = savedNotes
  }, [JSON.stringify(savedNotes)])
  const [view, setView] = useState({ w: 0, h: 0 })
  // The card under the mouse, once it stayed a moment: { id, rect }.
  const [peek, setPeek] = useState(null)
  const peekTimer = useRef(0)
  const hover = (id, el) => {
    clearTimeout(peekTimer.current)
    if (!id) return setPeek(null)
    peekTimer.current = setTimeout(() => el.isConnected && !el.classList.contains("dragging") && setPeek({ id, rect: el.getBoundingClientRect() }), PEEK_DELAY)
  }
  useEffect(() => () => clearTimeout(peekTimer.current), [])
  // Zoom: null fits the whole canvas in the window; a number draws it at that
  // scale, up to MAX_ZOOM, and the canvas scrolls. Kept in this browser.
  const [zoom, setZoomRaw] = useState(() => load("canvasZoom", null))
  const setZoom = z => (setZoomRaw(z), keep("canvasZoom", z))
  const wrap = useRef()
  const frame = useRef()
  const anchor = useRef(null) // the canvas point to keep under the cursor while zooming
  // Several cards and notes picked at once (a box drawn on the empty canvas, or
  // ⌘/⇧-click) move together. Keys: "c:<card id>", "n:<note id>".
  const [picked, setPicked] = useState(() => new Set())
  const [box, setBox] = useState(null) // the selection box being drawn, in canvas units
  const isSpace = useRef(false)
  const dragRef = useRef(null) // cards riding along with a zone
  // While a change of zones is being saved, a snapshot made before it would
  // put the old zones back for a moment: only one after it counts.
  const zonesSaving = useRef(0)
  useEffect(() => void (zonesSaving.current || setZones(savedZones)), [JSON.stringify(savedZones)])
  useLayoutEffect(() => {
    const r = wrap.current.getBoundingClientRect()
    setView({ w: r.width, h: r.height })
    const ro = new ResizeObserver(([e]) => setView({ w: e.contentRect.width, h: e.contentRect.height }))
    ro.observe(wrap.current)
    return () => ro.disconnect()
  }, [])

  // An archived card leaves at once (motion.js drops it): kept, the layout
  // would first move it to the entry.
  const openCards = onCanvas(cards)
  const done = cards.filter(c => c.column === "done")
  const { pos, entrySlots } = useMemo(() => layout(openCards, local), [openCards, local])

  // A saved place the server now reports makes the local one redundant.
  useEffect(() => {
    setLocal(l => {
      const next = { ...l }
      for (const c of cards) if (next[c.id] && c.pos && c.pos.x === next[c.id].x && c.pos.y === next[c.id].y) delete next[c.id]
      return next
    })
  }, [cards])

  const place = (card, p) => {
    setLocal(l => ({ ...l, [card.id]: p }))
    post(`/api/sessions/${card.id}/move`, p)
  }

  const saveNotes = (list, { later = false } = {}) => {
    latestNotes.current = list
    setNotes(list)
    clearTimeout(unsaved.current?.timer)
    // Only the newest save lets the server's copy back in when it ends.
    const mine = {}
    unsaved.current = mine
    const send = () => post("/api/canvas/notes", { notes: latestNotes.current }).finally(() => unsaved.current === mine && (unsaved.current = null))
    if (later) mine.timer = setTimeout(send, 600)
    else send()
  }
  // Where each note shows: its own place, or its card's plus its offset. A
  // note whose card is not on the canvas (done, archived) waits unseen.
  const openByKey = new Map(openCards.map(c => [keyOf(c), c]))
  const shown = notes.flatMap(n => {
    if (!n.cardId) return [{ note: n, at: { x: n.x, y: n.y }, card: null }]
    const c = openByKey.get(n.cardId)
    return c ? [{ note: n, at: { x: pos[c.id].x + n.x, y: pos[c.id].y + n.y }, card: c }] : []
  })
  // What each zone holds: the cards and free notes whose top centre lies in
  // it. A folded zone hides them (their places stay).
  const isIn = (z, x, y) => x >= z.x && x <= z.x + z.w && y >= z.y && y <= z.y + z.h
  const membersOf = z => openCards.filter(c => isIn(z, pos[c.id].x + CARD_W / 2, pos[c.id].y + 40))
  const folded = zones.filter(z => z.collapsed)
  const hidden = new Set(folded.flatMap(z => membersOf(z).map(c => c.id)))
  // Where a card added to a zone goes: the first place inside it that no
  // card takes (a grid step apart), else below them all, the zone taller to
  // hold it. `taken`: the rects already in the zone; `h`: the card's height.
  const placeIn = (z, taken, h) => {
    const isFree = (x, y) => taken.every(r => x + CARD_W + GRID <= r.x || r.x + r.w + GRID <= x || y + h + GRID <= r.y || r.y + r.h + GRID <= y)
    for (let y = z.y + 48; y + h <= z.y + z.h - GRID; y += GRID)
      for (let x = z.x + GRID; x + CARD_W <= z.x + z.w - GRID; x += GRID) if (isFree(x, y)) return { at: { x: snap(x), y: snap(y) }, zone: z }
    const at = { x: snap(z.x + GRID), y: snap(Math.max(z.y + 48, ...taken.map(r => r.y + r.h + GRID))) }
    return { at, zone: { ...z, w: Math.max(z.w, CARD_W + GRID * 2), h: Math.max(z.h, at.y - z.y + h + GRID) } }
  }
  const isNoteHidden = n => (n.card ? hidden.has(n.card.id) : folded.some(z => isIn(z, n.at.x + n.note.w / 2, n.at.y + 20)))

  // The card a note at `r` would attach to: the nearest one it overlaps or
  // comes within a grid step of.
  const findCard = r => {
    let best = null
    for (const c of openCards) {
      const p = pos[c.id]
      const h = document.querySelector(`.ccard[data-id="${c.id}"]`)?.offsetHeight ?? 120
      const gap = Math.max(0, p.x - (r.x + r.w), r.x - (p.x + CARD_W), p.y - (r.y + r.h), r.y - (p.y + h))
      if (gap <= GRID && (!best || gap < best.gap)) best = { card: c, gap }
    }
    return best?.card ?? null
  }
  const placeNote = (note, at, card) => {
    const next = card
      ? { cardId: keyOf(card), x: at.x - pos[card.id].x, y: at.y - pos[card.id].y }
      : { cardId: null, x: at.x, y: at.y }
    saveNotes(notes.map(x => (x.id === note.id ? { ...x, ...next } : x)))
  }

  // ---- moving what is picked together ----
  const pick = (key, isAdding) =>
    setPicked(cur => {
      if (!isAdding) return cur.has(key) && cur.size > 1 ? cur : new Set()
      const next = new Set(cur)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  const elOf = key =>
    key.startsWith("c:") ? document.querySelector(`.ccard[data-id="${key.slice(2)}"]`) : document.querySelector(`.note[data-note="${key.slice(2)}"]`)
  const cardOf = key => openCards.find(c => c.id === key.slice(2))
  const othersOf = key => (picked.has(key) && picked.size > 1 ? [...picked].filter(k => k !== key) : [])
  const groupMove = (key, d) => {
    for (const k of othersOf(key)) {
      const el = elOf(k)
      if (el) el.style.transform = `translate(${d.x}px, ${d.y}px)`
      const c = k.startsWith("c:") && cardOf(k)
      if (c) follow(c, d.x, d.y, false)
    }
  }
  const groupReset = key => {
    for (const k of othersOf(key)) {
      const el = elOf(k)
      if (el) el.style.transform = ""
      const c = k.startsWith("c:") && cardOf(k)
      if (c) follow(c, 0, 0, true)
    }
  }
  // The rest of the group lands moved by `delta` (the dragged item's own move).
  const groupDrop = (key, delta, notesNow = notes) => {
    const moved = new Map()
    for (const k of othersOf(key)) {
      const el = elOf(k)
      if (el) el.style.transform = ""
      if (k.startsWith("c:")) {
        const c = cardOf(k)
        if (!c) continue
        const p = pos[c.id]
        const next = {
          x: Math.max(0, Math.min(snap(p.x + delta.x), Math.floor((width - CARD_W) / GRID) * GRID)),
          y: Math.max(0, Math.min(snap(p.y + delta.y), Math.floor((doneTop - CARD_H) / GRID) * GRID)),
        }
        if (el) {
          el.style.transition = "none"
          el.style.left = `${next.x}px`
          el.style.top = `${next.y}px`
          requestAnimationFrame(() => (el.style.transition = ""))
        }
        follow(c, next.x - p.x, next.y - p.y, true)
        place(c, next)
      } else moved.set(k.slice(2), delta)
    }
    if (moved.size)
      saveNotes(notesNow.map(n => (moved.has(n.id) && !n.cardId ? { ...n, x: Math.max(0, snap(n.x + delta.x)), y: Math.max(0, snap(n.y + delta.y)) } : n)))
  }
  const groupFor = key => ({
    isActive: picked.has(key) && picked.size > 1,
    move: d => groupMove(key, d),
    drop: (note, at) => {
      // A note leading the group: it moves, the others follow by as much.
      const delta = { x: at.x - note.x, y: at.y - note.y }
      const after = notes.map(x => (x.id === note.id ? { ...x, x: at.x, y: at.y } : x))
      saveNotes(after)
      groupDrop(key, delta, after)
    },
  })

  // The window listeners of a box or a pan under way: gone with the canvas.
  const detach = useRef(null)
  useEffect(() => () => detach.current?.(), [])

  // ---- the selection box ----
  const startBox = e => {
    const area = e.currentTarget
    const r0 = area.getBoundingClientRect()
    const toWorld = ev => ({ x: (ev.clientX - r0.left) / scale, y: (ev.clientY - r0.top) / scale })
    const a = toWorld(e)
    const isAdding = e.metaKey || e.shiftKey
    const before = picked
    let hasMoved = false
    const hits = b => {
      const x0 = Math.min(b.x0, b.x1), x1 = Math.max(b.x0, b.x1), y0 = Math.min(b.y0, b.y1), y1 = Math.max(b.y0, b.y1)
      const overlaps = (x, y, w, h) => x < x1 && x + w > x0 && y < y1 && y + h > y0
      const keys = openCards.filter(c => overlaps(pos[c.id].x, pos[c.id].y, CARD_W, elOf(`c:${c.id}`)?.offsetHeight ?? 120)).map(c => `c:${c.id}`)
      keys.push(...shown.filter(n => !n.card && overlaps(n.at.x, n.at.y, n.note.w, n.note.h)).map(n => `n:${n.note.id}`))
      return keys
    }
    const move = ev => {
      const b = { x0: a.x, y0: a.y, ...((p => ({ x1: p.x, y1: p.y }))(toWorld(ev))) }
      if (!hasMoved && Math.hypot(b.x1 - b.x0, b.y1 - b.y0) * scale < 4) return
      hasMoved = true
      setBox(b)
      setPicked(new Set([...(isAdding ? before : []), ...hits(b)]))
    }
    const off = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      detach.current = null
    }
    const up = () => {
      off()
      setBox(null)
      if (!hasMoved && !isAdding) setPicked(new Set()) // a click on the empty canvas lets go
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    detach.current = off
  }

  const removeNote = gone => {
    const before = notes
    saveNotes(notes.filter(n => n.id !== gone.id))
    if (gone.text.trim()) ui.toast("Note deleted", () => saveNotes(before))
  }

  const saveZones = list => {
    setZones(list)
    zonesSaving.current++
    post("/api/canvas/zones", { zones: list }).finally(() => zonesSaving.current--)
  }

  // ---- drawing a new zone ----
  // With "Zone" on, a layer over the canvas takes the next drag, over cards
  // and notes too, and draws the zone there; a click gives one of the usual
  // size. Esc, the button again or another view cancels.
  const [draft, setDraft] = useState(null) // the zone being drawn, in canvas units
  const [newZoneId, setNewZoneId] = useState(null)
  const drawn = useRef(onZoneDrawn)
  drawn.current = onZoneDrawn
  useEffect(() => () => drawn.current?.(), [])
  useLayoutEffect(() => {
    if (!isDrawingZone) return
    const onKey = e => e.key === "Escape" && (e.stopPropagation(), drawn.current?.())
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [isDrawingZone])
  const startZone = e => {
    if (e.button !== 0) return
    e.preventDefault()
    const r0 = e.currentTarget.parentElement.getBoundingClientRect()
    const toWorld = ev => ({
      x: Math.min(Math.max((ev.clientX - r0.left) / scale, 0), bounds.w),
      y: Math.min(Math.max((ev.clientY - r0.top) / scale, 0), bounds.h),
    })
    const a = toWorld(e)
    let b = { x0: a.x, y0: a.y }
    const move = ev => {
      const p = toWorld(ev)
      b = { x0: a.x, y0: a.y, x1: p.x, y1: p.y }
      setDraft(b)
    }
    const off = () => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      detach.current = null
    }
    const up = () => {
      off()
      setDraft(null)
      const zone = newZone(b, bounds)
      setNewZoneId(zone.id)
      saveZones([...zones, zone])
      drawn.current?.()
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    detach.current = off
  }

  // A zone carries the cards whose centre lies inside it when the drag starts.
  const moveWith = (zone, dx, dy, isDrop) => {
    const isIn = (cx, cy) => cx >= zone.x && cx <= zone.x + zone.w && cy >= zone.y && cy <= zone.y + zone.h
    if (!dragRef.current || dragRef.current.zone !== zone.id) {
      dragRef.current = {
        zone: zone.id,
        cards: openCards.filter(c => isIn(pos[c.id].x + CARD_W / 2, pos[c.id].y + 40)),
        notes: notes.filter(n => !n.cardId && isIn(n.x + n.w / 2, n.y + 20)),
      }
    }
    for (const c of dragRef.current.cards) follow(c, dx, dy, isDrop)
    for (const n of dragRef.current.notes) {
      const el = document.querySelector(`.note[data-note="${n.id}"]`)
      if (el) el.style.transform = isDrop ? "" : `translate(${dx}px, ${dy}px)`
    }
    if (isDrop && dragRef.current.notes.length) {
      const moved = new Set(dragRef.current.notes.map(n => n.id))
      saveNotes(notes.map(n => (moved.has(n.id) ? { ...n, x: snap(n.x + dx), y: snap(n.y + dy) } : n)))
    }
    for (const c of dragRef.current.cards) {
      const el = document.querySelector(`.ccard[data-id="${c.id}"]`)
      // In a folded zone: no card on screen, but its place moves with the zone.
      if (!el) {
        if (isDrop) place(c, { x: snap(pos[c.id].x + dx), y: snap(pos[c.id].y + dy) })
        continue
      }
      if (!isDrop) el.style.transform = `translate(${dx}px, ${dy}px)`
      else {
        el.style.transform = ""
        const p = pos[c.id]
        const next = { x: snap(p.x + dx), y: snap(p.y + dy) }
        el.style.transition = "none"
        el.style.left = `${next.x}px`
        el.style.top = `${next.y}px`
        requestAnimationFrame(() => (el.style.transition = ""))
        place(c, next)
      }
    }
    if (isDrop) dragRef.current = null
  }

  // At "Fit" the whole canvas fits the window: when the cards and zones
  // need more room than the window has, everything is drawn smaller, and a
  // card can only go where you can see. Zoomed in, it scrolls (see below).
  // "Done" is the bottom band.
  const entryH = Math.max(1, Math.ceil(entrySlots / ENTRY.cols)) * CARD_H + GRID
  // A folded zone counts as its folder: its cards and notes are out of sight.
  const seen = openCards.filter(c => !hidden.has(c.id))
  const seenNotes = shown.filter(n => !isNoteHidden(n))
  const needW = Math.max(...seen.map(c => pos[c.id].x + CARD_W), ...zones.map(z => z.x + (z.collapsed ? CARD_W : z.w)), ...seenNotes.map(n => n.at.x + n.note.w), ENTRY.x + ENTRY.cols * (CARD_W + GRID)) + GRID
  const needH = Math.max(...seen.map(c => pos[c.id].y + CARD_H), ...zones.map(z => z.y + (z.collapsed ? FOLDER_H : z.h)), ...seenNotes.map(n => n.at.y + n.note.h), ENTRY.y + entryH) + GRID + DONE_H
  const fit = view.w && view.h ? Math.min(1, view.w / needW, view.h / needH) : 1
  const minZoom = Math.min(fit, MIN_ZOOM)
  const scale = zoom ? Math.min(MAX_ZOOM, Math.max(minZoom, zoom)) : fit
  const isZoomed = scale > fit + 0.001
  // Zoomed in, the canvas keeps the size that fits the window and is drawn
  // larger (it scrolls). Zoomed out, it grows to fill the window: more room.
  const width = view.w / Math.min(scale, fit)
  const height = view.h / Math.min(scale, fit)
  const doneTop = height - DONE_H
  const bounds = { w: width, h: doneTop }
  // One row, as many as the canvas is wide (newest first); the rest wait
  // behind "+N more", a list with their actions.
  const slots = Math.max(1, Math.floor((width - GRID) / (CARD_W + GRID)))
  const shownDone = done.length > slots ? done.slice(0, slots - 1) : done
  const moreDone = done.slice(shownDone.length)
  const slotOf = i => ({ x: GRID + i * (CARD_W + GRID), y: DONE_HEAD - GRID / 2 })
  const [isMoreOpen, setMoreOpen] = useState(false)
  useEffect(() => void (moreDone.length || setMoreOpen(false)), [moreDone.length])

  // Let go above the line: a place on the canvas. Below it: done.
  const dropped = (card, to, ev, el, d) => {
    const isDone = card.column === "done"
    const toDone = isOverDone(ev)
    const key = `c:${card.id}`
    if (toDone && isDone) {
      // Back to its slot.
      el.classList.remove("dragging")
      el.style.transform = ""
      el.animate([{ transform: `translate(${d.x}px, ${d.y}px)` }, { transform: "none" }], { duration: 280, easing: "cubic-bezier(0.22, 1, 0.36, 1)" })
      return
    }
    // Fly on from the drop point when the card changes side.
    if (toDone !== isDone) origins.set(card.id, el.getBoundingClientRect())
    el.classList.remove("dragging")
    if (toDone) {
      el.style.transform = ""
      follow(card, 0, 0, true) // its notes wait unseen until it comes back
      // The picked cards go to "Done" with it; picked notes stay where they were.
      for (const k of othersOf(key)) {
        const other = k.startsWith("c:") && cardOf(k)
        if (other) origins.set(other.id, elOf(k)?.getBoundingClientRect())
      }
      groupReset(key)
      for (const k of othersOf(key)) if (k.startsWith("c:") && cardOf(k)) ui.act(cardOf(k), "done")
      setPicked(new Set())
      return ui.act(card, "done")
    }
    // Let go on a folded zone: into it (and the picked cards with it), each
    // at a place inside the zone, for when it unfolds.
    const folderEl = document.elementsFromPoint(ev.clientX, ev.clientY).find(e => e.matches?.(".zone.folder"))
    const folder = folderEl && zones.find(z => z.id === folderEl.dataset.zone)
    if (folder) {
      const moving = [card, ...othersOf(key).filter(k => k.startsWith("c:")).map(cardOf).filter(Boolean)]
      // In, once the card has shrunk into the folder (which gives a little
      // bump as it lands): placed earlier, it would vanish mid-flight.
      const putIn = () => {
        quietly(moving.map(c => c.id))
        el.style.transform = ""
        groupReset(key)
        const taken = membersOf(folder).map(c => ({ ...pos[c.id], w: CARD_W, h: heightOf(c.id) }))
        let zone = folder
        for (const c of moving) {
          follow(c, 0, 0, true)
          const spot = placeIn(zone, taken, heightOf(c.id))
          zone = spot.zone
          taken.push({ ...spot.at, w: CARD_W, h: heightOf(c.id) })
          place(c, spot.at)
          if (c.column === "done") ui.act(c, "undone")
        }
        if (zone !== folder) saveZones(zones.map(z => (z.id === zone.id ? zone : z)))
        setPicked(new Set())
      }
      if (isCalm()) putIn()
      else {
        const { dx, dy } = towardFolder(el, folder)
        el.animate([{ transform: el.style.transform || "none", opacity: 1 }, { transform: `translate(${dx}px, ${dy}px) scale(0.3)`, opacity: 0 }],
          { duration: 200, easing: FOLD_EASE, fill: "forwards" }).finished.catch(() => {}).finally(putIn)
        folderEl.animate([{ transform: "none" }, { transform: "scale(1.05)", offset: 0.6 }, { transform: "none" }], { duration: 300, delay: 120, easing: FOLD_EASE })
      }
      return ui.toast(`${moving.length === 1 ? "Added" : `${moving.length} added`} to ${folder.name}`)
    }
    const next = {
      x: Math.min(snap(to.x), Math.floor((width - CARD_W) / GRID) * GRID),
      y: Math.min(snap(to.y), Math.floor((doneTop - CARD_H) / GRID) * GRID),
    }
    if (isDone) {
      // Stays where it was let go until the server moves it out of "Done".
      setTimeout(() => el.isConnected && (el.style.transform = ""), 3000)
      place(card, next)
      return ui.act(card, "undone")
    }
    // Land where dropped, without sliding from the old place; its notes too.
    el.style.transform = ""
    el.style.transition = "none"
    el.style.left = `${next.x}px`
    el.style.top = `${next.y}px`
    requestAnimationFrame(() => (el.style.transition = ""))
    follow(card, next.x - pos[card.id].x, next.y - pos[card.id].y, true)
    groupDrop(key, { x: next.x - pos[card.id].x, y: next.y - pos[card.id].y })
    place(card, next)
  }

  // Zoom keeping the canvas point under (cx, cy) — relative to the window — in place.
  // A zoom that passes the "Fit" point stops on it; going further takes a
  // new step (or a new pinch). Answers whether it stopped there.
  const zoomTo = (next, cx = view.w / 2, cy = view.h / 2) => {
    const f = frame.current
    let n = next === null ? fit : Math.min(MAX_ZOOM, Math.max(minZoom, next))
    const isAtFit = zoom === null
    const crosses = next !== null && !isAtFit && (scale - fit) * (n - fit) <= 0
    if (crosses) n = fit
    anchor.current = { x: (f.scrollLeft + cx) / scale, y: (f.scrollTop + cy) / scale, cx, cy }
    setZoom(next === null || crosses || Math.abs(n - fit) < 0.01 ? null : n)
    return crosses
  }
  // The listeners below are added once: they read the newest zoom from here.
  const zoomNow = useRef({})
  zoomNow.current = { zoomTo, scale }
  // One pinch is a run of wheel events with no pause longer than this.
  const gesture = useRef({ last: 0, isHeld: false })
  useLayoutEffect(() => {
    const a = anchor.current
    if (!a) return
    anchor.current = null
    frame.current.scrollLeft = a.x * scale - a.cx
    frame.current.scrollTop = a.y * scale - a.cy
  }, [scale])
  // Pinch on the trackpad (Chrome sends it as a wheel with ctrlKey) or ⌘ + wheel;
  // + − 0 on the keyboard. Space held down makes a drag on the empty canvas pan.
  useEffect(() => {
    const f = frame.current
    const onWheel = e => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const g = gesture.current
      const now = performance.now()
      if (now - g.last > 300) g.isHeld = false // a new pinch
      g.last = now
      if (g.isHeld) return // stopped on "Fit" until the fingers lift
      const r = f.getBoundingClientRect()
      const { zoomTo, scale } = zoomNow.current
      g.isHeld = zoomTo(scale * Math.exp(-e.deltaY * 0.004), e.clientX - r.left, e.clientY - r.top)
    }
    const onKey = e => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented || isTyping(document.activeElement) || document.querySelector("dialog[open]")) return
      if (e.key === " ") {
        // Space keeps its own job on a control, and in the conversation panel.
        if (e.target.closest?.(SPACE_KEEPS)) return
        isSpace.current = true
        frame.current.classList.add("can-pan")
        return e.preventDefault()
      }
      if (e.key === "Escape") return setPicked(new Set())
      const { zoomTo, scale } = zoomNow.current
      if (e.key === "+" || e.key === "=") zoomTo(scale * 1.2)
      else if (e.key === "-") zoomTo(scale / 1.2)
      else if (e.key === "0") zoomTo(null)
      else return
      e.preventDefault()
    }
    const onKeyUp = e => {
      if (e.key !== " ") return
      isSpace.current = false
      frame.current?.classList.remove("can-pan")
    }
    f.addEventListener("wheel", onWheel, { passive: false })
    window.addEventListener("keydown", onKey)
    window.addEventListener("keyup", onKeyUp)
    return () => (f.removeEventListener("wheel", onWheel), window.removeEventListener("keydown", onKey), window.removeEventListener("keyup", onKeyUp))
  }, [])
  // "Next up" (and anything else that names a card): the canvas zooms in to at
  // least its real size and brings the card to the middle of what the
  // conversation panel leaves free, and the card flashes once.
  const focusCard = id => {
    const p = pos[id]
    const el = document.querySelector(`.ccard[data-id="${id}"]`)
    if (!p || !el) return // done, archived, or folded away in a zone
    const n = Math.min(MAX_ZOOM, Math.max(scale, 1))
    const panel = document.querySelector(".reader-slot .reader")?.offsetWidth ?? 0
    const cx = Math.max(view.w - panel, view.w * 0.4) / 2
    const target = { x: p.x + CARD_W / 2, y: p.y + heightOf(id) / 2 }
    if (Math.abs(n - scale) < 0.001) frame.current.scrollTo({ left: target.x * n - cx, top: target.y * n - view.h / 2, behavior: isCalm() ? "auto" : "smooth" })
    else {
      anchor.current = { ...target, cx, cy: view.h / 2 }
      setZoom(n)
    }
    el.classList.remove("flash")
    void el.offsetWidth // restart the animation
    el.classList.add("flash")
    setTimeout(() => el.classList.remove("flash"), 1600)
  }
  const focusNow = useRef(focusCard)
  focusNow.current = focusCard
  useEffect(() => {
    const on = e => focusNow.current(e.detail)
    window.addEventListener("canvas:focus", on)
    return () => window.removeEventListener("canvas:focus", on)
  }, [])

  // Zoomed in, dragging the empty canvas moves the view.
  const onBackground = e => {
    if (e.target !== e.currentTarget) return
    if (e.button === 1 || (e.button === 0 && isSpace.current)) return pan(e)
    if (e.button === 0) startBox(e)
  }
  const pan = e => {
    e.preventDefault()
    const f = frame.current
    const x0 = e.clientX
    const y0 = e.clientY
    const left = f.scrollLeft
    const top = f.scrollTop
    f.classList.add("panning")
    const move = ev => ((f.scrollLeft = left - (ev.clientX - x0)), (f.scrollTop = top - (ev.clientY - y0)))
    const off = () => (window.removeEventListener("pointermove", move), window.removeEventListener("pointerup", up), (detach.current = null))
    const up = () => (f.classList.remove("panning"), off())
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    detach.current = off
  }

  return html`<div class="canvas-wrap" ref=${wrap}>
    <div class=${`canvas-frame ${isZoomed ? "zoomed" : ""}`} ref=${frame} onScroll=${() => peek && setPeek(null)}>
    <div class="canvas-sizer" style=${`width:${width * scale}px;height:${height * scale}px`}>
    <div class=${`canvas-area col-canvas ${levelOf(scale)}`} style=${`width:${width}px;height:${height}px;transform:scale(${scale});--unscale:${1 / scale}`}
      onPointerDown=${onBackground}
      onDblClick=${e => {
        // A double click on the empty canvas leaves a note there.
        if (e.target !== e.currentTarget && !e.target.classList.contains("zone")) return
        const r = e.currentTarget.getBoundingClientRect()
        const at = { x: (e.clientX - r.left) / scale, y: Math.min((e.clientY - r.top) / scale, doneTop - 144) }
        saveNotes([...notes, newNote(notes, at)])
      }}>
      <div class="entry-zone" style=${`left:${ENTRY.x - 12}px;top:${ENTRY.y - 12}px;width:${ENTRY.cols * (CARD_W + GRID)}px;height:${entryH + 12}px`}>
        <span>Incoming</span>
      </div>
      ${zones.map(
        z => html`<${Zone} key=${z.id} zone=${z} scale=${scale} bounds=${bounds} onMoveWith=${moveWith}
          onChange=${next => saveZones(zones.map(x => (x.id === next.id ? next : x)))}
          onRemove=${gone => saveZones(zones.filter(x => x.id !== gone.id))} isNew=${z.id === newZoneId} members=${membersOf(z)} />`,
      )}
      ${seenNotes.map(
        ({ note: n, at, card }) => html`<${Note} key=${n.id} note=${n} at=${at} card=${card} scale=${scale} bounds=${bounds}
          findCard=${findCard} onPlace=${placeNote} onRemove=${removeNote}
          isPicked=${picked.has(`n:${n.id}`)} onPick=${isAdding => pick(`n:${n.id}`, isAdding)} group=${groupFor(`n:${n.id}`)}
          onChange=${next => saveNotes(notes.map(x => (x.id === next.id ? { ...x, w: next.w, h: next.h, color: next.color } : x)))}
          onText=${(note, text, opts) => saveNotes(notes.map(x => (x.id === note.id ? { ...x, text } : x)), opts)} />`,
      )}
      ${seen.map(card => html`<${CanvasCard} key=${card.id} card=${card} at=${pos[card.id]} scale=${scale} onDropped=${dropped} onHover=${hover}
        isPicked=${picked.has(`c:${card.id}`)} onPick=${isAdding => pick(`c:${card.id}`, isAdding)} group=${groupFor(`c:${card.id}`)} />`)}
      ${isDrawingZone && html`<div class="zone-draw" style=${`height:${doneTop}px`} onPointerDown=${startZone}></div>`}
      ${draft && html`<div class="zone zone-draft" style=${`left:${Math.min(draft.x0, draft.x1)}px;top:${Math.min(draft.y0, draft.y1)}px;width:${Math.abs(draft.x1 - draft.x0)}px;height:${Math.abs(draft.y1 - draft.y0)}px;--hue:${hue("New zone")}`}></div>`}
      ${box && html`<div class="select-box" style=${`left:${Math.min(box.x0, box.x1)}px;top:${Math.min(box.y0, box.y1)}px;width:${Math.abs(box.x1 - box.x0)}px;height:${Math.abs(box.y1 - box.y0)}px`}></div>`}
      <section class="done-area" style=${`top:${doneTop}px`}>
        <header class="done-head" data-fly="done">
          <${Icon} name="check" size=${14} />Done<span class="count">${done.length || ""}</span>
          <span class="done-hint">${done.length ? "Drop a card here to mark it as done · lift it out to reopen it" : "Drop a card here to mark it as done"}</span>
          ${done.length > 0 && html`<button class="head-btn" onClick=${() => ui.archiveAll(done)}><${Icon} name="archive" size=${13} />Archive all</button>`}
        </header>
        ${shownDone.map((card, i) => {
          const slot = slotOf(i)
          return html`<${CanvasCard} key=${card.id} card=${card} scale=${scale} z=${3}
            at=${{ x: slot.x, y: doneTop + slot.y, left: slot.x, top: slot.y }} onDropped=${dropped} />`
        })}
        ${moreDone.length > 0 && html`<button class=${`done-more-tile ${isMoreOpen ? "on" : ""}`} aria-expanded=${isMoreOpen}
          style=${`left:${slotOf(shownDone.length).x}px;top:${slotOf(0).y}px;width:${CARD_W}px`} onClick=${() => setMoreOpen(!isMoreOpen)}>
          <b>+${moreDone.length}</b><span>more done</span></button>`}
      </section>
    </div>
    </div>
    </div>
    ${isZoomed && html`<div class="done-dock" data-fly="done">
      <${Icon} name="check" size=${13} />Done<span class="count">${done.length || ""}</span>
      <span class="done-hint">Drop here to mark it as done</span>
      <span class="dock-chips">${done.map(card => html`<button key=${card.id} class="tag" onClick=${() => ui.openReader(card.id)}>${card.title}</button>`)}</span>
    </div>`}
    ${peek && ui.reader?.id !== peek.id && cards.some(c => c.id === peek.id) && html`<${Peek} card=${cards.find(c => c.id === peek.id)} rect=${peek.rect} />`}
    ${isDrawingZone && !draft && html`<div class="zone-draw-hint">Drag to draw the zone · Esc to cancel</div>`}
    ${isMoreOpen && html`<${DoneList} cards=${moreDone} bottom=${(height - doneTop) * scale + 8} onClose=${() => setMoreOpen(false)} />`}
    <div class="zoom-ctl" title="Zoom: pinch on the trackpad or ⌘ + wheel · keys + − 0. Zooming out gives more room">
      <button class="icon-btn" disabled=${scale <= minZoom + 0.001} onClick=${() => zoomTo(scale / 1.2)} aria-label="Zoom out">−</button>
      <span class="zoom-pct">${Math.round(scale * 100)}%</span>
      <button class="icon-btn" disabled=${scale >= MAX_ZOOM - 0.001} onClick=${() => zoomTo(scale * 1.2)} aria-label="Zoom in">+</button>
      <button class="btn subtle" disabled=${zoom === null} onClick=${() => zoomTo(null)}>Fit</button>
    </div>
  </div>`
}
