// The canvas view: sessions as compact cards you place anywhere, named zones
// to group them, sticky notes (canvas-notes.js), an "Incoming" corner where
// new ones land, and "Done" as the band at the bottom: drop a card there (or
// press ✓) to mark it done, lift it back up to reopen it. By default the
// canvas fits the window, drawn smaller when it must; zoomed in, it scrolls.
import { html, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "../vendor/preact-htm.js"
import { Actions, BackgroundChip, Context, PendingChip, PrChip, StateIcon, UsageMeter, ageText, onOpenKey, stateOf, urgencyOf } from "./components.js"
import { CARD_H, CARD_W, ENTRY, GRID, dragHandler, layout, onCanvas, snap } from "./canvas-layout.js"
import { Note, follow, keyOf, newNote } from "./canvas-notes.js"
import { Ctx } from "./ctx.js"
import { Icon } from "./icons.js"
import { RunChip } from "./run.js"
import { hue, isTyping, keep, load, post } from "./util.js"
import { origins } from "./motion.js"

const MAX_ZOOM = 1.5 // 150 % of the cards' real size
const MIN_ZOOM = 0.4 // zoomed out: more room around, cards at 40 %

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

// `at` is where the card sits on the canvas; `onDropped(card, to, ev, el, d)`
// gets the canvas point where it was let go. The canvas is drawn at `scale`,
// so a pointer move of 10 px is 10 / scale canvas units.
function CanvasCard({ card, at, scale, onDropped, z, isPicked = false, onPick, group }) {
  const ui = useContext(Ctx)
  const ref = useRef()
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
  }
  const onPointerDown = dragHandler({
    onStart: () => {
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
      const d = shift()
      onDropped(card, { x: at.x + d.x, y: at.y + d.y }, ev, ref.current, d)
    },
    onClick: ev => (ev?.metaKey || ev?.shiftKey ? onPick?.(true) : (onPick?.(false), ui.openReader(card.id))),
  })
  return html`<article ref=${ref} data-id=${card.id}
    class=${`ccard ${isPicked ? "picked" : ""} state-${state} ${isDone ? "" : urgencyOf(card, ui.now)} ${ui.selected === card.id ? "selected" : ""} ${ui.reader?.id === card.id ? "reading" : ""} ${card.isUnread ? "unread" : ""} ${ui.parkMenu === card.id ? "raised" : ""}`}
    style=${`left:${at.left ?? at.x}px;top:${at.top ?? at.y}px;--hue:${hue(card.repo)};animation-delay:${delay}s${z ? `;--z:${z}` : ""}`}
    tabindex="0" onPointerDown=${onPointerDown} onKeyDown=${onOpenKey(() => ui.openReader(card.id))}>
    <div class="ccard-top">
      <${StateIcon} card=${card} size=${30} />
      <div class="ccard-head">
        <span class="ctitle">${card.isUnread && html`<i class="new-dot"></i>`}${card.title}</span>
        <span class="csub"><span class="crepo">${card.repo}</span> · ${ageText(card, ui.now)}</span>
      </div>
      ${card.pinned && html`<span class="pin" title="Pinned"><${Icon} name="star" size=${12} /></span>`}
    </div>
    ${!isDone && html`<${Context} card=${card} lines=${2} />`}
    ${(card.prs?.length > 0 || card.taskCount > 0 || card.bridge?.pending > 0 || card.usage || card.run || card.background?.length) && html`<div class="cchips">
      <${BackgroundChip} card=${card} />
      <${RunChip} card=${card} />
      ${card.prs?.map(pr => html`<${PrChip} key=${pr.url} pr=${pr} repo=${card.repo} cardId=${card.id} />`)}
      ${card.taskCount > 0 && html`<button class="tag tasks" onClick=${e => (e.stopPropagation(), ui.openReader(card.id, "tasks"))}>
        <${Icon} name="tasks" size=${12} />${card.taskCount} ${card.taskCount === 1 ? "task" : "tasks"}</button>`}
      ${card.bridge?.pending > 0 && html`<${PendingChip} card=${card} />`}
      <${UsageMeter} usage=${card.usage} />
    </div>`}
    ${!isDone && card.branch && html`<div class="ccard-more"><span class="branch">${card.branch}</span></div>`}
    <${Actions} card=${card} compact />
  </article>`
}

function Zone({ zone, scale, bounds, onChange, onRemove, onMoveWith }) {
  const ref = useRef()
  const nameField = useRef()
  const [isEditing, setEditing] = useState(false)
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
    onClick: () => {},
  })
  // A zone stays on the visible canvas, above "Done".
  const within = (z, dx, dy) => [
    Math.min(Math.max(dx, -z.x), Math.max(0, bounds.w - z.x - z.w)),
    Math.min(Math.max(dy, -z.y), Math.max(0, bounds.h - z.y - z.h)),
  ]
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
      <button class="icon-btn zone-x" title="Remove the zone (the cards stay)" onClick=${() => onRemove(zone)}>
        <${Icon} name="x" size=${13} /></button>
    </header>
    <div class="zone-resize" onPointerDown=${e => (e.stopPropagation(), startResize(e))} title="Resize"></div>
  </section>`
}

// Space pans the canvas, except on these: there it presses, ticks or scrolls.
const SPACE_KEEPS = "button, a[href], summary, input, [role=button], [role=checkbox], [role=radio], [role=option], .reader-slot"

const DONE_HEAD = 48
const DONE_H = DONE_HEAD + CARD_H // the "Done" band: one row, at the bottom

export function Canvas({ cards, zones: savedZones, notes: savedNotes }) {
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
  useEffect(() => setZones(savedZones), [JSON.stringify(savedZones)])
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
    post("/api/canvas/zones", { zones: list })
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
      if (!el) continue
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
  const needW = Math.max(...openCards.map(c => pos[c.id].x + CARD_W), ...zones.map(z => z.x + z.w), ...shown.map(n => n.at.x + n.note.w), ENTRY.x + ENTRY.cols * (CARD_W + GRID)) + GRID
  const needH = Math.max(...openCards.map(c => pos[c.id].y + CARD_H), ...zones.map(z => z.y + z.h), ...shown.map(n => n.at.y + n.note.h), ENTRY.y + entryH) + GRID + DONE_H
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
  // One row; when it is full, the cards overlap like a fanned deck.
  const room = width - GRID * 2 - CARD_W
  const step = done.length > 1 ? Math.min(CARD_W + GRID, room / (done.length - 1)) : 0
  const slotOf = i => ({ x: GRID + i * step, y: DONE_HEAD - GRID / 2 })

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
    <div class=${`canvas-frame ${isZoomed ? "zoomed" : ""}`} ref=${frame}>
    <div class="canvas-sizer" style=${`width:${width * scale}px;height:${height * scale}px`}>
    <div class="canvas-area col-canvas" style=${`width:${width}px;height:${height}px;transform:scale(${scale})`}
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
          onRemove=${gone => saveZones(zones.filter(x => x.id !== gone.id))} />`,
      )}
      ${shown.map(
        ({ note: n, at, card }) => html`<${Note} key=${n.id} note=${n} at=${at} card=${card} scale=${scale} bounds=${bounds}
          findCard=${findCard} onPlace=${placeNote} onRemove=${removeNote}
          isPicked=${picked.has(`n:${n.id}`)} onPick=${isAdding => pick(`n:${n.id}`, isAdding)} group=${groupFor(`n:${n.id}`)}
          onChange=${next => saveNotes(notes.map(x => (x.id === next.id ? { ...x, w: next.w, h: next.h, color: next.color } : x)))}
          onText=${(note, text, opts) => saveNotes(notes.map(x => (x.id === note.id ? { ...x, text } : x)), opts)} />`,
      )}
      ${openCards.map(card => html`<${CanvasCard} key=${card.id} card=${card} at=${pos[card.id]} scale=${scale} onDropped=${dropped}
        isPicked=${picked.has(`c:${card.id}`)} onPick=${isAdding => pick(`c:${card.id}`, isAdding)} group=${groupFor(`c:${card.id}`)} />`)}
      ${box && html`<div class="select-box" style=${`left:${Math.min(box.x0, box.x1)}px;top:${Math.min(box.y0, box.y1)}px;width:${Math.abs(box.x1 - box.x0)}px;height:${Math.abs(box.y1 - box.y0)}px`}></div>`}
      <section class="done-area" style=${`top:${doneTop}px`}>
        <header class="done-head" data-fly="done">
          <${Icon} name="check" size=${14} />Done<span class="count">${done.length || ""}</span>
          <span class="done-hint">${done.length ? "Drop a card here to mark it as done · lift it out to reopen it" : "Drop a card here to mark it as done"}</span>
          ${done.length > 0 && html`<button class="head-btn" onClick=${() => ui.archiveAll(done)}><${Icon} name="archive" size=${13} />Archive all</button>`}
        </header>
        ${done.map((card, i) => {
          const slot = slotOf(i)
          return html`<${CanvasCard} key=${card.id} card=${card} scale=${scale} z=${done.length - i + 3}
            at=${{ x: slot.x, y: doneTop + slot.y, left: slot.x, top: slot.y }} onDropped=${dropped} />`
        })}
      </section>
    </div>
    </div>
    </div>
    ${isZoomed && html`<div class="done-dock" data-fly="done">
      <${Icon} name="check" size=${13} />Done<span class="count">${done.length || ""}</span>
      <span class="done-hint">Drop here to mark it as done</span>
      <span class="dock-chips">${done.map(card => html`<button key=${card.id} class="tag" onClick=${() => ui.openReader(card.id)}>${card.title}</button>`)}</span>
    </div>`}
    <div class="zoom-ctl" title="Zoom: pinch on the trackpad or ⌘ + wheel · keys + − 0. Zooming out gives more room">
      <button class="icon-btn" disabled=${scale <= minZoom + 0.001} onClick=${() => zoomTo(scale / 1.2)} aria-label="Zoom out">−</button>
      <span class="zoom-pct">${Math.round(scale * 100)}%</span>
      <button class="icon-btn" disabled=${scale >= MAX_ZOOM - 0.001} onClick=${() => zoomTo(scale * 1.2)} aria-label="Zoom in">+</button>
      <button class="btn subtle" disabled=${zoom === null} onClick=${() => zoomTo(null)}>Fit</button>
    </div>
  </div>`
}
