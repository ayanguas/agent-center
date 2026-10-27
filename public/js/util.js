// Small helpers shared by every component.

export const STATES = {
  asking: { label: "Asking you", tone: "ask" },
  review: { label: "To review", tone: "review" },
  working: { label: "Working", tone: "work" },
  pending: { label: "Pending", tone: "pending" },
  parked: { label: "Later", tone: "muted" },
  done: { label: "Done", tone: "muted" },
}

// "review" holds what is new since you last looked; once seen it moves to
// "pending" (your queue) until the session changes again.
export const COLUMNS = ["asking", "review", "working", "pending", "parked", "done"]

// ---------- storage (per-viewer conveniences only) ----------

export function load(key, fallback) {
  try {
    const raw = localStorage.getItem(`ac.${key}`)
    return raw === null ? fallback : JSON.parse(raw)
  } catch {
    return fallback
  }
}

export function keep(key, value) {
  try {
    localStorage.setItem(`ac.${key}`, JSON.stringify(value))
  } catch {}
}

// ---------- text ----------

// Recaps and titles carry markdown: keep the words, drop the syntax.
// Single * and _ stay: they are part of names like my_project or *.tsx.
export const plain = s =>
  String(s ?? "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*|__|`/g, "")
    .replace(/(^|\s)(#{1,6}|>)\s/g, "$1")
    .replace(/\s+/g, " ")
    .trim()

export function md(text) {
  const html = window.marked ? window.marked.parse(String(text ?? ""), { breaks: true }) : ""
  const clean = window.DOMPurify ? window.DOMPurify.sanitize(html, { ADD_ATTR: ["target"] }) : ""
  return /<pre|<code|<a /.test(clean) ? enhance(clean) : clean
}

// A path Claude names (`/Users/…/report.md`, `~/x.py`, a link to a file of
// the session's folder) opens the file in the Files tab (files.js); the
// server shows it only if the session's transcript names it.
const PATH_CODE = /^(?:~|\/)[^\n]{1,300}\.[A-Za-z0-9]{1,8}$/
function fileLink(el, path) {
  el.classList.add("file-link")
  el.dataset.path = path
  el.title = `Open ${path.split("/").pop()} here`
}

// Each code block gets a copy button, and a shell block a run button (shown
// only when Setup allows it; conversation.js runs it). Added after the
// sanitizing: they are ours.
const SHELL = /\blanguage-(bash|sh|shell|zsh)\b/
const RUN_ICON = `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z"/></svg>`
const COPY_ICON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>`
function enhance(html) {
  const t = document.createElement("template")
  t.innerHTML = html
  for (const code of t.content.querySelectorAll(":not(pre) > code")) if (PATH_CODE.test(code.textContent.trim())) fileLink(code, code.textContent.trim())
  for (const a of t.content.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href")
    if (/^([a-z][a-z0-9+.-]*:|#)/i.test(href)) continue
    let path = href
    try {
      path = decodeURI(href)
    } catch {}
    a.removeAttribute("href")
    fileLink(a, path.replace(/:\d+(:\d+)?$/, ""))
  }
  for (const pre of t.content.querySelectorAll("pre")) {
    const box = document.createElement("div")
    box.className = "code-box"
    pre.replaceWith(box)
    const run = SHELL.test(pre.querySelector("code")?.className ?? "")
      ? `<button type="button" class="code-run" title="Run in the session's folder">${RUN_ICON}<span>Run</span></button>`
      : ""
    box.innerHTML = `<div class="code-tools">${run}<button type="button" class="code-copy" title="Copy">${COPY_ICON}<span>Copy</span></button></div>`
    box.append(pre)
  }
  return t.innerHTML
}

// The clipboard API, else the older copy command (some windows refuse the API).
async function copyText(text) {
  try {
    return await navigator.clipboard.writeText(text)
  } catch {
    const area = Object.assign(document.createElement("textarea"), { value: text })
    area.style.cssText = "position:fixed;opacity:0;pointer-events:none"
    document.body.append(area)
    area.select()
    const ok = document.execCommand("copy")
    area.remove()
    if (!ok) throw new Error("copy refused")
  }
}

// One listener for every copy button, wherever the markdown is shown.
document.addEventListener("click", async e => {
  const button = e.target.closest?.(".code-copy")
  if (!button) return
  const text = button.closest(".code-box").querySelector("pre")?.innerText ?? ""
  try {
    await copyText(text.replace(/\n$/, ""))
    button.classList.add("done")
    button.querySelector("span").textContent = "Copied"
    setTimeout(() => (button.classList.remove("done"), (button.querySelector("span").textContent = "Copy")), 1500)
  } catch {
    button.querySelector("span").textContent = "Could not copy"
  }
})

export function hue(name) {
  let h = 0
  for (const ch of String(name ?? "")) h = (h * 31 + ch.charCodeAt(0)) % 360
  return h
}

// ---------- time ----------

export function ago(ms, now = Date.now()) {
  const min = Math.max(0, Math.round((now - ms) / 60000))
  if (min < 1) return "now"
  if (min < 60) return `${min} min`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} h`
  const d = Math.round(h / 24)
  return d < 30 ? `${d} d` : `${Math.round(d / 30)} mo`
}

// "850 KB", "2.6 MB", "1.2 GB".
export function bytesText(n) {
  const units = ["B", "KB", "MB", "GB", "TB"]
  let i = 0
  while (n >= 1000 && i < units.length - 1) (n /= 1000), i++
  return `${n.toLocaleString("en-GB", { maximumFractionDigits: n < 10 && i > 0 ? 1 : 0 })} ${units[i]}`
}

export const clock = ms => new Date(ms).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })

export const when = ms =>
  new Date(ms).toLocaleString("en-GB", { weekday: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })

function at(daysAhead, hour) {
  const d = new Date()
  d.setDate(d.getDate() + daysAhead)
  d.setHours(hour, 0, 0, 0)
  return d.getTime()
}

export const PARK_OPTIONS = [
  { key: "1", label: "1 hour", until: () => Date.now() + 3600_000 },
  { key: "2", label: "This afternoon", hint: "16:00", until: () => at(new Date().getHours() >= 16 ? 1 : 0, 16) },
  { key: "3", label: "Tomorrow morning", hint: "9:00", until: () => at(1, 9) },
  { key: "4", label: "Monday", hint: "9:00", until: () => at(((8 - new Date().getDay()) % 7) || 7, 9) },
  { key: "5", label: "No date", until: () => null },
]

// ---------- API ----------

export async function post(path, body = {}) {
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-center": "1" },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: await res.json().catch(() => ({})) }
  } catch {
    return { status: 0, body: { error: "No connection to the server" } }
  }
}

export async function get(path) {
  try {
    const res = await fetch(path)
    return await res.json()
  } catch {
    return null
  }
}

export const isTyping = el =>
  !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable || !!el.closest?.(".monaco-editor"))
