// A session's files, as in Claude desktop's side panel: the chips Claude's
// "here is the file" turns leave in the conversation, the cards of the pages
// it published (artifacts), and the "Files" tab, a list of what the session
// sent, published or wrote with a viewer under it. The server serves only a
// file the session's transcript names (lib/session-files.ts).
import { html, useContext, useEffect, useLayoutEffect, useRef, useState } from "../vendor/preact-htm.js"
import { Ctx } from "./ctx.js"
import { Icon } from "./icons.js"
import { ago, bytesText, get, md, post } from "./util.js"

const fileUrl = (id, path, what = "file") => `/api/sessions/${id}/${what}?path=${encodeURIComponent(path)}`
const nameOf = path => String(path).split("/").pop() || path
const extOf = path => (nameOf(path).match(/\.([A-Za-z0-9]{1,8})$/)?.[1] ?? "").toLowerCase()
const IMAGE = /^(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/
const VIDEO = /^(mp4|mov|webm)$/
const AUDIO = /^(mp3|wav)$/
const MARKDOWN = /^(md|markdown)$/
const TEXT = /^(txt|text|log|csv|tsv|json|jsonl|ya?ml|toml|ini|env|xml|sql|sh|zsh|bash|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|js|jsx|ts|tsx|mjs|cjs|css|scss|vue|svelte|astro|graphql|proto|tf|lock)$/
const WORD = /^(docx|doc|rtf|rtfd|odt|wordml|webarchive)$/ // as lib/office.ts: a page
const WORKBOOK = /^(xlsx|xlsm)$/ // tables
const DELIMITED = { csv: ",", tsv: "\t" }
const SOURCE = { sent: "sent", artifact: "published", written: "written" }

// The type's colour family, for its label: sheets green, documents blue…
const FAMILY = [
  [/^(xlsx|xlsm|xls|csv|tsv|numbers)$/, "sheet"],
  [/^(docx|doc|rtf|rtfd|odt|pages|md|markdown|txt)$/, "doc"],
  [/^(pptx|ppt|key)$/, "slides"],
  [/^pdf$/, "pdf"],
  [/^(png|jpe?g|gif|webp|avif|bmp|ico|svg|mp4|mov|webm|mp3|wav)$/, "media"],
]
const familyOf = ext => FAMILY.find(([re]) => re.test(ext))?.[1] ?? "code"
const ExtTag = ({ ext }) => html`<span class=${`file-ext fam-${familyOf(ext)}`}>${ext || "file"}</span>`

// A CSV or TSV line by line, quotes kept together ("a, b" is one cell).
function rowsOf(text, sep, max = 1000) {
  const rows = []
  let row = [], cell = "", quoted = false
  for (let i = 0; i < text.length && rows.length < max; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (cell += '"'), i++
      else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === sep) row.push(cell), (cell = "")
    else if (ch === "\n") row.push(cell.replace(/\r$/, "")), rows.push(row), (row = []), (cell = "")
    else cell += ch
  }
  if (cell || row.length) row.push(cell), rows.push(row)
  return rows
}

// In the conversation: one chip per file Claude showed you; a click opens it
// in the Files tab.
export function FileChips({ id, paths, caption }) {
  const ui = useContext(Ctx)
  return html`<div class="msg files-msg">
    ${caption && html`<p class="files-caption">${caption}</p>`}
    <div class="bubble-files">
      ${paths.map(p => html`<${FileChip} key=${p} id=${id} path=${p} onOpen=${() => ui.showFile(p)} />`)}
    </div>
  </div>`
}

function FileChip({ id, path, onOpen }) {
  const [info, setInfo] = useState(null)
  useEffect(() => void get(fileUrl(id, path, "fileinfo")).then(setInfo), [id, path])
  const ext = extOf(path)
  return html`<button class="file-chip" onClick=${onOpen} title=${info?.path ?? path}>
    <${ExtTag} ext=${ext} /><span>${nameOf(path)}</span>
    ${info?.size != null ? html`<small>${bytesText(info.size)}</small>` : info?.error && html`<small>gone</small>`}
  </button>`
}

// A page Claude published: its link (claude.ai, signed in) and its file.
export function ArtifactCard({ id, path, url }) {
  const ui = useContext(Ctx)
  return html`<div class="msg artifact-card">
    <${Icon} name="file" size=${16} />
    <div class="artifact-main"><b>${path ? nameOf(path).replace(/\.[^.]+$/, "") : "Artifact"}</b>
      <small>${url ? "Published on claude.ai" : "Published"}</small></div>
    ${path && html`<button class="btn subtle" onClick=${() => ui.showFile(path)}>View file</button>`}
    ${url && html`<a class="btn" href=${url} target="_blank" rel="noreferrer">Open <${Icon} name="external" size=${12} /></a>`}
  </div>`
}

// The tab: the list on top, the chosen file under it.
export function Files({ id, file }) {
  const ui = useContext(Ctx)
  const [list, setList] = useState(null)
  useEffect(() => {
    let alive = true
    const load = () => get(`/api/sessions/${id}/files`).then(res => alive && setList(res?.files ?? []))
    load()
    const timer = setInterval(load, 10_000)
    return () => ((alive = false), clearInterval(timer))
  }, [id])
  const shown = file ?? list?.[0]?.path ?? null
  return html`<div class="files-tab">
    <ul class="files-list">
      ${list === null && html`<li class="muted">Looking…</li>`}
      ${list?.length === 0 && !file && html`<li class="muted">This session has not sent or written any file yet.</li>`}
      ${list?.map(f => html`<li key=${f.path}><button class=${f.path === shown ? "on" : ""} onClick=${() => ui.showFile(f.path)} title=${f.path}>
        <${ExtTag} ext=${extOf(f.path)} /><span class="t">${f.name}</span>
        <small>${SOURCE[f.source] ?? f.source} · ${ago(f.at, ui.now)}</small></button></li>`)}
    </ul>
    ${shown && html`<${FileViewer} key=${shown} id=${id} path=${shown} />`}
  </div>`
}

// A document page (lib/office.ts) cleaned of anything that runs (DOMPurify)
// and drawn in a shadow root: its styles and the board's stay apart. Its
// links to its own parts (a workbook's sheets) scroll there.
function OfficeDoc({ html: page }) {
  const host = useRef()
  useLayoutEffect(() => {
    const root = host.current.shadowRoot ?? host.current.attachShadow({ mode: "open" })
    root.innerHTML = window.DOMPurify ? window.DOMPurify.sanitize(page, { ADD_TAGS: ["style"], FORCE_BODY: true, FORBID_TAGS: ["form", "input", "button"] }) : ""
    const jump = e => {
      const a = e.target.closest?.('a[href^="#"]')
      if (!a) return
      e.preventDefault()
      root.getElementById(a.getAttribute("href").slice(1))?.scrollIntoView({ block: "start" })
    }
    root.addEventListener("click", jump)
    return () => root.removeEventListener("click", jump)
  }, [page])
  return html`<div class="file-doc" ref=${host}></div>`
}

function FileViewer({ id, path }) {
  const ui = useContext(Ctx)
  const [info, setInfo] = useState(null)
  const [text, setText] = useState(null)
  const [isSource, setSource] = useState(false)
  const ext = extOf(path)
  const isText = MARKDOWN.test(ext) || TEXT.test(ext) || ext === ""
  const [hasNoPreview, setNoPreview] = useState(false)
  // A Word or Excel preview (lib/office.ts), cleaned and drawn in its own
  // shadow root (OfficeDoc): sandboxed frames do not show in every browser.
  const isOffice = WORD.test(ext) || WORKBOOK.test(ext)
  const [doc, setDoc] = useState(null) // { html } or { error }
  useEffect(() => {
    get(fileUrl(id, path, "fileinfo")).then(res => {
      setInfo(res ?? { error: "No connection to the server" })
      if (res && !res.error && res.isViewable && isText)
        fetch(fileUrl(id, path)).then(r => r.text()).then(setText, () => setText(""))
      if (res && !res.error && res.isViewable && isOffice)
        fetch(fileUrl(id, path, "filepreview"))
          .then(async r => (r.ok ? setDoc({ html: await r.text() }) : setDoc({ error: (await r.json().catch(() => ({}))).error ?? "No preview" })))
          .catch(() => setDoc({ error: "No connection to the server" }))
    })
  }, [id, path])
  const openOnMac = async (reveal = false) => {
    const res = await post(`/api/sessions/${id}/openfile`, { path, reveal })
    if (!res.body.ok) ui.toast(res.body.error ?? "Could not open it")
  }
  const copyPath = () => navigator.clipboard.writeText(info?.path ?? path).then(() => ui.toast("Path copied"), () => ui.toast("Could not copy"))
  const preview = fileUrl(id, path, "filepreview")
  const sep = DELIMITED[ext]
  const table = sep && text !== null ? rowsOf(text, sep) : null
  const src = fileUrl(id, path)
  const body = !info
    ? html`<p class="muted">Loading…</p>`
    : info.error
      ? html`<p class="muted">${info.error}</p>`
      : !info.isViewable
        ? html`<p class="muted">Too large to show here (${bytesText(info.size)}).</p>`
        : MARKDOWN.test(ext) && !isSource
          ? text === null ? html`<p class="muted">Loading…</p>` : html`<article class="md file-md" dangerouslySetInnerHTML=${{ __html: md(text) }}></article>`
          : table
            ? html`<div class="file-table"><table>${table.map((r, i) => html`<tr key=${i}>${r.map((c, j) => (i === 0 ? html`<th key=${j}>${c}</th>` : html`<td key=${j}>${c}</td>`))}</tr>`)}</table>
                ${table.length >= 1000 && html`<p class="muted">Only the first 1000 rows show here.</p>`}</div>`
          : isText
            ? html`<pre class="file-text">${text ?? ""}</pre>`
          : isOffice
            ? !doc ? html`<p class="muted">Reading it…</p>`
              : doc.error ? html`<p class="muted">${doc.error}: open it on the Mac.</p>`
              : html`<${OfficeDoc} html=${doc.html} />`
            : IMAGE.test(ext)
              ? html`<img class="file-img" src=${src} alt=${nameOf(path)} />`
              : ext === "pdf"
                ? html`<iframe class="file-frame" src=${src} title=${nameOf(path)}></iframe>`
                : ext === "html" || ext === "htm"
                  ? html`<iframe class="file-frame" src=${src} sandbox="allow-scripts" title=${nameOf(path)}></iframe>`
                  : VIDEO.test(ext)
                    ? html`<video class="file-img" src=${src} controls></video>`
                    : AUDIO.test(ext)
                      ? html`<audio src=${src} controls></audio>`
                      : hasNoPreview
                        ? html`<p class="muted">macOS has no preview for this kind of file: open it on the Mac.</p>`
                        : html`<figure class="file-ql"><img class="file-img" src=${preview} alt=${nameOf(path)} onError=${() => setNoPreview(true)} />
                            <figcaption class="muted">The first page, as Quick Look shows it. Open it on the Mac for all of it.</figcaption></figure>`
  return html`<section class="file-view">
    <header class="file-head">
      <div class="file-name"><b>${nameOf(path)}</b><small title=${info?.path ?? path}>${(info?.path ?? path).replace(/^\/Users\/[^/]+/, "~")}${info?.size != null ? ` · ${bytesText(info.size)}` : ""}</small></div>
      ${MARKDOWN.test(ext) && html`<button class="btn subtle" onClick=${() => setSource(!isSource)}>${isSource ? "Rendered" : "Source"}</button>`}
      ${info && !info.error && html`<button class="icon-btn" onClick=${copyPath} title="Copy the path"><${Icon} name="file" size=${14} /></button>
        <button class="btn subtle" onClick=${() => openOnMac(true)} title="Show it in Finder">Show in Finder</button>
        <button class="btn subtle" onClick=${() => openOnMac()} title="Open it in its app on this Mac">Open on the Mac</button>`}
    </header>
    <div class="file-body">${body}</div>
  </section>`
}
