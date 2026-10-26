// Cards and rows that move: after each render, every [data-id] element that
// changed its group (column, lane, inbox section) or its place in it travels
// from where it was (FLIP, transform only). One that left the view flies to
// where it went (a hidden "Done", a folded group), drops out of view when
// archived, or fades out; a new one fades in. Scrolling alone never animates: only a change of place does.
//
// A trip to another group flies a copy in a layer above the page: the
// columns scroll, and a scrolling box clips whatever crosses its edge. The
// real element stays hidden until the copy lands. A card alone in its group
// box flies with the box (its repo header included).
import { useLayoutEffect, useRef } from "../vendor/preact-htm.js"

const EASE = "cubic-bezier(0.22, 1, 0.36, 1)"
const DROP_GAP_MS = 260 // how long the others wait while an archived card falls

// Where a trip starts when it is not where the card last rested: a card
// dropped by hand flies on from the drop point. Set just before the change.
export const origins = new Map()
// Cards that appear or leave with an animation of their own (a canvas zone
// folding or unfolding, a card dropped into a folder): left alone, once.
export const quiet = new Set()
export function quietly(ids) {
  for (const id of ids) quiet.add(id)
  setTimeout(() => ids.forEach(id => quiet.delete(id)), 1000) // in case no render saw them
}
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches

// Where an element sits: its group and its index among that group's items.
function placeOf(el) {
  const group = el.closest(".column, .group, .results, .done-area, .canvas-area") ?? el.parentElement
  const items = group ? [...group.querySelectorAll("[data-id]")] : []
  const kind = group?.className.match(/\b(col|group)-[\w-]+/)?.[0] ?? ""
  const lane = el.closest(".lane")?.getAttribute("data-lane") ?? ""
  return { group: `${lane}|${kind}`, index: items.indexOf(el) }
}

// What travels: the group box when the card is alone in it, else the card.
function unitOf(el) {
  const stack = el.closest(".stack")
  return stack && stack.querySelectorAll("[data-id]").length === 1 ? stack : el
}

// How much smaller than its own size an element is drawn (the canvas scales).
const shrinkOf = el => (el.offsetWidth ? el.getBoundingClientRect().width / el.offsetWidth : 1)

// A copy of `node` pinned at `rect`, in a layer above everything, drawn at
// `k` of its size. CSS zoom also multiplies left, top and any translate, so
// the trip's offsets are divided by `k` too (see `by`).
function copyAt(node, rect, k = 1) {
  const copy = node.cloneNode(true)
  Object.assign(copy.style, {
    position: "fixed", left: `${rect.left / k}px`, top: `${rect.top / k}px`,
    width: `${rect.width / k}px`, height: `${rect.height / k}px`, zoom: String(k),
    margin: "0", zIndex: "60", pointerEvents: "none", transition: "none", boxSizing: "border-box",
  })
  copy.classList.add("ghost")
  document.body.append(copy)
  return copy
}

function once(fn) {
  let done = false
  return () => done || ((done = true), fn())
}

// `scope` changing (another view, filter or search) means a fresh start:
// nothing animates on the first render of a scope. `whereTo(id)` names the
// column a vanished card went to, so it can fly there.
export function useFlip(ref, scope, whereTo) {
  const prev = useRef(new Map())
  const lastScope = useRef(null)

  useLayoutEffect(() => {
    const root = ref.current
    if (!root) return
    const isFresh = lastScope.current !== scope
    lastScope.current = scope
    const now = new Map()
    for (const el of root.querySelectorAll("[data-id]")) now.set(el.dataset.id, el)
    const calm = isFresh || reduced()
    // A card dropping out (archived) falls first; the rest close the gap after.
    const settleDelay = [...prev.current].some(([id, old]) => !now.has(id) && old.unit && whereTo(id) === "archived") ? DROP_GAP_MS : 0

    if (!calm) {
      for (const [id, el] of now) {
        const old = prev.current.get(id)
        if (!old) {
          if (quiet.delete(id)) continue
          unitOf(el).animate(
            [{ opacity: 0, transform: "translateY(6px) scale(0.98)" }, { opacity: 1, transform: "none" }],
            { duration: 260, easing: EASE },
          )
          continue
        }
        const place = placeOf(el)
        if (place.group === old.place.group && place.index === old.place.index) continue

        if (place.group === old.place.group) {
          // Same column: a short slide in place; no box edge to cross.
          const rect = el.getBoundingClientRect()
          const dy = old.rect.top - rect.top
          const dx = old.rect.left - rect.left
          if (Math.abs(dx) < 2 && Math.abs(dy) < 2) continue
          el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], { duration: 320, delay: settleDelay, easing: EASE, fill: "backwards" })
          continue
        }

        // Another column: fly a copy above the page, then show the real one.
        const unit = unitOf(el)
        const to = unit.getBoundingClientRect()
        const from = origins.get(id) ?? old.unitRect
        origins.delete(id)
        const k = shrinkOf(unit)
        const copy = copyAt(unit, { left: from.left, top: from.top, width: to.width, height: to.height }, k)
        unit.style.opacity = "0"
        const dx = (to.left - from.left) / k
        const dy = (to.top - from.top) / k
        const far = Math.hypot(dx, dy)
        const duration = Math.min(620, 320 + far * 0.3)
        const land = once(() => {
          copy.remove()
          unit.style.opacity = ""
          unit.animate([{ transform: "scale(1.015)" }, { transform: "none" }], { duration: 180, easing: EASE })
        })
        copy.animate(
          [
            { transform: "translate(0, 0) scale(1)", boxShadow: "0 1px 2px rgb(0 0 0 / 0.1)" },
            { transform: `translate(${dx * 0.5}px, ${dy * 0.5 - 14}px) scale(1.03)`, boxShadow: "0 18px 40px rgb(0 0 0 / 0.35)", offset: 0.5 },
            { transform: `translate(${dx}px, ${dy}px) scale(1)`, boxShadow: "0 1px 2px rgb(0 0 0 / 0.1)" },
          ],
          { duration, easing: EASE },
        ).finished.finally(land)
        setTimeout(land, duration + 250) // a hidden window pauses animations
      }

      for (const [id, old] of prev.current) {
        if (now.has(id) || !old.unit || quiet.delete(id)) continue
        const ghost = copyAt(old.unit, old.unitRect, old.k)
        const goesTo = whereTo(id)
        // Archived: a small lift, then it drops out of the view, tilting as it falls.
        if (goesTo === "archived") {
          const fall = innerHeight - old.unitRect.top + 40
          const gone = once(() => ghost.remove())
          ghost.animate(
            [
              { transform: "none", opacity: 1 },
              { transform: "translateY(-8px) scale(1.02)", opacity: 1, offset: 0.18 },
              { transform: `translateY(${Math.min(fall, 260) / old.k}px) rotate(-4deg) scale(0.94)`, opacity: 0 },
            ],
            { duration: 460, easing: "cubic-bezier(0.55, 0, 0.75, 0.3)" },
          ).finished.finally(gone)
          setTimeout(gone, 700)
          continue
        }
        const target = document.querySelector(`[data-fly="${goesTo}"]`)
        let frames
        if (target) {
          const t = target.getBoundingClientRect()
          const dx = (t.left + t.width / 2 - (old.unitRect.left + old.unitRect.width / 2)) / old.k
          const dy = (t.top + t.height / 2 - (old.unitRect.top + old.unitRect.height / 2)) / old.k
          frames = [
            { transform: "none", opacity: 1 },
            { transform: `translate(${dx * 0.6}px, ${dy * 0.6}px) scale(0.6)`, opacity: 0.9, offset: 0.6 },
            { transform: `translate(${dx}px, ${dy}px) scale(0.15)`, opacity: 0 },
          ]
          target.animate([{ transform: "scale(1)" }, { transform: "scale(1.12)" }, { transform: "scale(1)" }], {
            duration: 260, delay: 420, easing: EASE,
          })
        } else frames = [{ opacity: 1, transform: "none" }, { opacity: 0, transform: "scale(0.96) translateY(-4px)" }]
        const duration = target ? 540 : 220
        const gone = once(() => ghost.remove())
        ghost.animate(frames, { duration, easing: target ? "cubic-bezier(0.55, 0, 0.3, 1)" : EASE }).finished.finally(gone)
        setTimeout(gone, duration + 250)
      }
    }

    // Remember where everything is now, and a detached copy-source for each:
    // the unit (box or card) as it looks now, for a later exit.
    const next = new Map()
    for (const [id, el] of now) {
      const unit = unitOf(el)
      next.set(id, { rect: el.getBoundingClientRect(), unit, unitRect: unit.getBoundingClientRect(), k: shrinkOf(unit), place: placeOf(el) })
    }
    prev.current = next
  })
}
