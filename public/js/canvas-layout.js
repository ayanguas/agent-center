// The canvas's geometry: the grid everything snaps to, the card size, the
// "Incoming" corner where cards with no saved place line up, the place of a
// new zone, the keyboard's order on the canvas, and the pointer drag every
// piece of the canvas (cards, zones, notes) uses.

export const GRID = 24
export const CARD_W = 288
export const CARD_H = 144 // slot height in "Incoming" and "Done"; cards are about 120 tall
export const ENTRY = { x: GRID, y: GRID * 2, cols: 2 }
export const PAD = 48

export const snap = v => Math.max(0, Math.round(v / GRID) * GRID)

// Where each card sits: its saved place, else a slot in "Incoming".
export function layout(cards, local = {}) {
  const pos = {}
  let slot = 0
  for (const card of cards) {
    const p = local[card.id] ?? card.pos
    if (p) pos[card.id] = p
    else {
      pos[card.id] = {
        x: ENTRY.x + (slot % ENTRY.cols) * (CARD_W + GRID),
        y: ENTRY.y + GRID + Math.floor(slot / ENTRY.cols) * CARD_H,
      }
      slot++
    }
  }
  return { pos, entrySlots: slot }
}

// The cards the canvas places: done ones sit in "Done", archived ones leave.
export const onCanvas = cards => cards.filter(c => c.column !== "done" && c.column !== "archived")

// Keyboard order on the canvas: top to bottom, then left to right.
export function canvasOrder(cards) {
  const openCards = onCanvas(cards)
  const { pos } = layout(openCards)
  return [...openCards].sort((a, b) => pos[a.id].y - pos[b.id].y || pos[a.id].x - pos[b.id].x)
}

// A new zone right of "Incoming", nudged so new ones do not stack exactly.
// A zone drawn from (x0, y0) to (x1, y1) on the canvas, kept inside `bounds`.
// A click (no box drawn) gives a zone of the usual size from that point.
export function newZone({ x0, y0, x1 = x0, y1 = y0 }, bounds) {
  const isClick = Math.abs(x1 - x0) < GRID && Math.abs(y1 - y0) < GRID
  const w = Math.min(bounds.w, Math.max(160, isClick ? CARD_W * 2 + GRID * 3 : snap(Math.abs(x1 - x0))))
  const h = Math.min(bounds.h, Math.max(120, isClick ? CARD_H * 2 + GRID * 2 : snap(Math.abs(y1 - y0))))
  return {
    id: crypto.randomUUID(),
    name: "New zone",
    x: Math.min(snap(Math.min(x0, x1)), Math.max(0, Math.floor((bounds.w - w) / GRID) * GRID)),
    y: Math.min(snap(Math.min(y0, y1)), Math.max(0, Math.floor((bounds.h - h) / GRID) * GRID)),
    w,
    h,
  }
}

// Pointer drag with a click threshold: `onMove(dx, dy)` while dragging,
// `onDrop(dx, dy, event)` at the end, `onClick()` when it never moved.
export function dragHandler({ onStart, onMove, onDrop, onClick }) {
  return e => {
    if (e.button !== 0 || e.target.closest("button, a, input, .menu, textarea")) return
    const startX = e.clientX
    const startY = e.clientY
    let isDragging = false
    const el = e.currentTarget
    // The pointer is captured only once a drag starts: captured at the press,
    // clicks and double clicks would land on `el` instead of what was under
    // the pointer (a zone's name could not be double-clicked to rename it).
    // So the moves and the release are heard on the window: on `el` alone, a
    // quick move off a small target (a resize corner) before the drag starts
    // would leave the press unfinished, and the next pass over it would drag.
    const move = ev => {
      if (ev.pointerId !== e.pointerId) return
      if (ev.buttons === 0) return end(ev, false) // let go where no release reached the page
      const dx = ev.clientX - startX
      const dy = ev.clientY - startY
      if (!isDragging && Math.hypot(dx, dy) < 4) return
      if (!isDragging) {
        isDragging = true
        try {
          el.setPointerCapture(e.pointerId)
        } catch {} // a synthetic pointer has nothing to capture
        onStart?.()
      }
      onMove(dx, dy, ev)
    }
    const end = (ev, isRelease) => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      window.removeEventListener("pointercancel", up)
      if (isDragging) onDrop(ev.clientX - startX, ev.clientY - startY, ev)
      else if (isRelease) onClick?.(ev)
    }
    const up = ev => ev.pointerId === e.pointerId && end(ev, ev.type === "pointerup")
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    window.addEventListener("pointercancel", up)
  }
}
