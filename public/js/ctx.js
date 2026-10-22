// What every component reaches without prop drilling: the app's actions and
// UI state (main.js provides them), and the key cap used in hints. Kept apart
// so the views can import it without importing each other.
import { html, createContext } from "../vendor/preact-htm.js"

export const Ctx = createContext(null)

export function Kbd({ children }) {
  return html`<kbd>${children}</kbd>`
}
