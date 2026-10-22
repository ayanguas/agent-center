// The short notes at the bottom of the window: what just happened, and an
// undo button (also Z) when it can be taken back. main.js keeps the list.
import { html, useContext } from "../vendor/preact-htm.js"
import { Ctx, Kbd } from "./ctx.js"

export function Toasts({ toasts }) {
  const ui = useContext(Ctx)
  return html`<div class="toasts" role="status" aria-live="polite">
    ${toasts.map(
      t => html`<div key=${t.id} class="toast">
        <span>${t.text}</span>
        ${t.undo && html`<button onClick=${() => (ui.dismissToast(t.id), t.undo())}>Undo <${Kbd}>Z<//></button>`}
      </div>`,
    )}
  </div>`
}
