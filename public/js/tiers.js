// The tier list: one row per level of importance, top to bottom, then
// "Paused" (the board's Later column) and a last row that closes a
// conversation (marks it done). The rows share the whole height. A card goes to a row by
// dragging it there, or with [ and ] on the selected card.
import { html, useContext, useState } from "../vendor/preact-htm.js"
import { Card } from "./board.js"
import { Ctx } from "./ctx.js"
import { Icon } from "./icons.js"

// lib/board.ts TIERS, plus "paused" (Later) and "close" (Done), which are columns.
export const TIERS = [
  { key: "main", label: "Main task", hint: "What matters most right now" },
  { key: "fixes", label: "Fixes", hint: "Bugs and corrections" },
  { key: "searches", label: "Searches", hint: "Look-ups and research" },
  { key: "other", label: "Other", hint: "Everything not sorted yet" },
  { key: "paused", label: "Paused", hint: "Set aside for later: drop here to pause it" },
  { key: "close", label: "Close", hint: "Drop here to close the conversation" },
]

const ROWS = ["main", "fixes", "searches", "other"] // the ones a card keeps (lib/board.ts TIERS)
export const tierOf = card =>
  card.column === "done" ? "close" : card.column === "parked" ? "paused" : ROWS.includes(card.tier) ? card.tier : "other"

// What it takes to move a card to a row: the action(s) to send, or null.
export function toTier(card, key) {
  if (!card || tierOf(card) === key) return null
  if (key === "close") return [["done", {}]]
  // Out of Done or Later first; Paused keeps the row it had for when it comes back.
  const steps = card.column === "done" ? [["undone", {}]] : card.column === "parked" ? [["unpark", {}]] : []
  if (key === "paused") return [...steps, ["park", { until: null }]]
  return [...steps, ["tier", { tier: key }]]
}

// What an empty row says (Close also when its cards are hidden).
function emptyText(key, count, canDrop) {
  if (key === "close") return canDrop ? "Drop here to close it" : count ? `${count} closed · “Done” at the top shows them` : "Drag a card here to close it"
  if (canDrop) return "Drop here"
  return key === "paused" ? "Drag a card here to pause it" : "Empty"
}

const byPin = (a, b) => Number(b.pinned) - Number(a.pinned)

export function Tiers({ cards, showDone }) {
  const ui = useContext(Ctx)
  const [over, setOver] = useState(null)
  const hidden = c => c.column === "archived"
  return html`<div class="tiers">
    ${TIERS.map((tier, i) => {
      const list = cards.filter(c => !hidden(c) && tierOf(c) === tier.key).sort(byPin)
      const isClose = tier.key === "close"
      const canDrop = !!ui.dragging && !!toTier(ui.dragging, tier.key)
      // Closed ones show only with "Done" on. Not while dragging either: they
      // would appear, then fly off to the "Done" button on the drop.
      const shown = isClose && !showDone ? [] : list
      return html`<section key=${tier.key} class=${`tier tier-${i} tier-${tier.key} ${over === tier.key && canDrop ? "drop" : ""} ${ui.dragging && !canDrop && tierOf(ui.dragging) !== tier.key ? "no-drop" : ""}`}
        data-tier=${tier.key}
        onDragOver=${e => canDrop && (e.preventDefault(), setOver(tier.key))}
        onDragLeave=${e => !e.currentTarget.contains(e.relatedTarget) && setOver(null)}
        onDrop=${e => {
          e.preventDefault()
          setOver(null)
          const card = ui.dragging
          ui.setDragging(null)
          ui.moveToTier(card, tier.key)
        }}>
        <div class="tier-label" title=${tier.hint}>
          ${isClose ? html`<${Icon} name="check" size=${18} />` : tier.key === "paused" ? html`<${Icon} name="pause" size=${16} />` : null}
          <b>${tier.label}</b>
          <span class="count">${list.length || ""}</span>
        </div>
        <div class="tier-cards">
          ${shown.map(card => html`<${Card} key=${card.id} card=${card} />`)}
          ${shown.length === 0 && html`<p class="empty">${emptyText(tier.key, list.length, ui.dragging && canDrop)}</p>`}
        </div>
      </section>`
    })}
  </div>`
}
