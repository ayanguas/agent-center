// Sticky notes on the canvas: free text you leave anywhere. Drag one by its
// top strip, size it from the corner, change its colour with the dot, delete
// it with ×. Dropped on or next to a card it attaches to it and moves with it.
// Lines written as "- [ ] …" show as boxes to tick.
import { html, useEffect, useRef, useState } from "../vendor/preact-htm.js"
import { CARD_W, ENTRY, GRID, PAD, dragHandler, snap } from "./canvas-layout.js"
import { Icon } from "./icons.js"

const NOTE_COLORS = ["yellow", "pink", "blue", "green"]
const ITEM = /^(\s*[-*] \[)( |x|X)(\] ?)(.*)$/
let focusNext = null // a note just made: its text gets the cursor

// The key a note keeps for its card: the desktop app's id for the session
// when it has one, else the card's own.
export const keyOf = card => card.hostId ?? card.id

// The notes attached to a card ride along while it moves.
export function follow(card, dx, dy, isDrop) {
  for (const el of document.querySelectorAll(`.note[data-attached="${keyOf(card)}"]`)) {
    if (!isDrop) {
      el.style.transform = `translate(${dx}px, ${dy}px)`
      continue
    }
    el.style.transition = "none"
    el.style.transform = ""
    el.style.left = `${parseFloat(el.style.left) + dx}px`
    el.style.top = `${parseFloat(el.style.top) + dy}px`
    requestAnimationFrame(() => (el.style.transition = ""))
  }
}

function NoteView({ text, onToggle, onEdit }) {
  if (!text.trim()) return html`<div class="note-view note-empty" onClick=${onEdit}>Write a note…</div>`
  return html`<div class="note-view" onClick=${onEdit}>
    ${text.split("\n").map((line, i) => {
      const m = line.match(ITEM)
      if (!m) return html`<div key=${i} class="note-line">${line || "\u00a0"}</div>`
      const isDone = m[2] !== " "
      return html`<div key=${i} class=${`note-item ${isDone ? "done" : ""}`}>
        <input type="checkbox" checked=${isDone} onClick=${e => e.stopPropagation()} onChange=${() => onToggle(i)} />
        <span>${m[4] || "\u00a0"}</span>
      </div>`
    })}
  </div>`
}

// `at`: where the note sits on the canvas (its card's place plus its offset
// when attached). `findCard(rect)`: the card a note there would attach to.
export function Note({ note, at, card, scale, bounds, findCard, onPlace, onChange, onText, onRemove, isPicked = false, onPick, group }) {
  const ref = useRef()
  const area = useRef()
  const [isEditing, setEditing] = useState(focusNext === note.id)
  useEffect(() => {
    if (focusNext === note.id) focusNext = null
  }, [])
  useEffect(() => {
    const el = area.current
    if (!isEditing || !el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [isEditing])

  const within = (dx, dy) => [
    Math.min(Math.max(dx, -at.x), Math.max(0, bounds.w - at.x - note.w)),
    Math.min(Math.max(dy, -at.y), Math.max(0, bounds.h - at.y - note.h)),
  ]
  let target = null
  const mark = next => {
    if (next === target) return
    if (target) document.querySelector(`.ccard[data-id="${target.id}"]`)?.classList.remove("note-target")
    target = next
    if (target) document.querySelector(`.ccard[data-id="${target.id}"]`)?.classList.add("note-target")
  }
  const startDrag = dragHandler({
    onStart: () => ref.current.classList.add("dragging"),
    onMove: (dx, dy) => {
      ;[dx, dy] = within(dx / scale, dy / scale)
      ref.current.style.transform = `translate(${dx}px, ${dy}px) rotate(-1deg)`
      if (group?.isActive) group.move({ x: dx, y: dy })
      else mark(findCard({ x: at.x + dx, y: at.y + dy, w: note.w, h: note.h }))
    },
    onDrop: (dx, dy) => {
      ;[dx, dy] = within(dx / scale, dy / scale)
      const to = target
      mark(null)
      const el = ref.current
      el.classList.remove("dragging")
      el.style.transition = "none"
      el.style.transform = ""
      el.style.left = `${snap(at.x + dx)}px`
      el.style.top = `${snap(at.y + dy)}px`
      requestAnimationFrame(() => (el.style.transition = ""))
      const next = { x: snap(at.x + dx), y: snap(at.y + dy) }
      if (group?.isActive) return group.drop(note, next)
      onPlace(note, next, to)
    },
    onClick: ev => (ev?.metaKey || ev?.shiftKey ? onPick?.(true) : (onPick?.(false), setEditing(true))),
  })
  const sizeOf = (dx, dy) => ({
    w: Math.max(144, Math.min(note.w + dx / scale, bounds.w - at.x, 800)),
    h: Math.max(96, Math.min(note.h + dy / scale, bounds.h - at.y, 800)),
  })
  const startResize = dragHandler({
    onMove: (dx, dy) => {
      const { w, h } = sizeOf(dx, dy)
      ref.current.style.width = `${w}px`
      ref.current.style.height = `${h}px`
    },
    onDrop: (dx, dy) => {
      const { w, h } = sizeOf(dx, dy)
      onChange({ ...note, w: Math.max(144, Math.floor(w / GRID) * GRID), h: Math.max(96, Math.floor(h / GRID) * GRID) })
    },
  })

  const toggle = i => {
    const lines = note.text.split("\n")
    lines[i] = lines[i].replace(ITEM, (_, a, mark, b, rest) => `${a}${mark === " " ? "x" : " "}${b}${rest}`)
    onText(note, lines.join("\n"))
  }
  // Enter in a list line starts the next item; Enter on an empty item ends the list.
  const onKeyDown = e => {
    if (e.key === "Escape") return (e.stopPropagation(), e.currentTarget.blur())
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return
    const ta = e.currentTarget
    const pos = ta.selectionStart
    const start = ta.value.lastIndexOf("\n", pos - 1) + 1
    const m = ta.value.slice(start, pos).match(ITEM)
    if (!m) return
    e.preventDefault()
    if (m[4].trim()) ta.setRangeText(`\n${m[1]} ${m[3]}`, pos, ta.selectionEnd, "end")
    else ta.setRangeText("", start, pos, "end")
    onText(note, ta.value, { later: true })
  }
  const addItem = () => {
    const text = note.text.replace(/\s*$/, "")
    onText(note, `${text}${text ? "\n" : ""}- [ ] `)
    setEditing(true)
  }

  const items = note.text.split("\n").map(l => l.match(ITEM)).filter(Boolean)
  const ticked = items.filter(m => m[2] !== " ").length
  const nextColor = NOTE_COLORS[(NOTE_COLORS.indexOf(note.color) + 1) % NOTE_COLORS.length]
  return html`<div ref=${ref} class=${`note note-${note.color} ${card ? "attached" : ""} ${isPicked ? "picked" : ""}`} data-note=${note.id} data-attached=${card ? keyOf(card) : undefined}
    style=${`left:${at.x}px;top:${at.y}px;width:${note.w}px;height:${note.h}px`}>
    <header class="note-head" onPointerDown=${startDrag}
      title=${card ? `Attached to “${card.title}”: it moves with the card. Drag it away to detach it` : "Drag to move the note; drop it next to a card to attach it"}>
      <button class="note-dot" title="Change the colour" onClick=${() => onChange({ ...note, color: nextColor })}></button>
      ${card && html`<span class="note-link"><${Icon} name="link" size=${11} /></span>`}
      ${items.length > 0 && html`<span class="note-count">${ticked}/${items.length}</span>`}
      <span class="note-spacer"></span>
      <button class="icon-btn note-btn" title="Add a checkbox" onClick=${addItem}><${Icon} name="tasks" size=${12} /></button>
      <button class="icon-btn note-btn note-x" title="Delete the note" onClick=${() => onRemove(note)}><${Icon} name="x" size=${12} /></button>
    </header>
    ${isEditing
      ? html`<textarea ref=${area} class="note-text" defaultValue=${note.text} placeholder="Write a note… (- [ ] for a checkbox)" spellcheck="false"
          onInput=${e => onText(note, e.target.value, { later: true })} onKeyDown=${onKeyDown} onBlur=${() => setEditing(false)}></textarea>`
      : html`<${NoteView} text=${note.text} onToggle=${toggle} onEdit=${() => setEditing(true)} />`}
    <div class="note-resize" onPointerDown=${startResize} title="Resize"></div>
  </div>`
}

// A new note: where you double-clicked, or right of "Incoming".
export function newNote(notes, at = null) {
  const n = notes.length
  const note = {
    id: crypto.randomUUID(),
    text: "",
    x: at ? snap(at.x - 24) : ENTRY.x + ENTRY.cols * (CARD_W + GRID) + PAD + (n % 5) * GRID,
    y: at ? snap(at.y - 12) : ENTRY.y + (n % 5) * GRID,
    w: 216,
    h: 144,
    color: "yellow",
    cardId: null,
  }
  focusNext = note.id
  return note
}
