// A session's files, as in Claude desktop's side panel: the chips Claude's
// "here is the file" turns leave in the conversation, the cards of the pages
// it published (artifacts), and the "Files" tab, a list of what the session
// sent, published or wrote with a viewer under it. The server serves only a
// file the session's transcript names (lib/session-files.ts).
import { html, useContext, useEffect, useState } from "../vendor/preact-htm.js"
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
const SOURCE = { sent: "sent", artifact: "published", written: "written" }

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
    <span class="file-ext">${ext || "file"}</span><span>${nameOf(path)}</span>
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
        <span class="file-ext">${extOf(f.path) || "file"}</span><span class="t">${f.name}</span>
        <small>${SOURCE[f.source] ?? f.source} · ${ago(f.at, ui.now)}</small></button></li>`)}
    </ul>
    ${shown && html`<${FileViewer} key=${shown} id=${id} path=${shown} />`}
  </div>`
}

function FileViewer({ id, path }) {
  const ui = useContext(Ctx)
  const [info, setInfo] = useState(null)
  const [text, setText] = useState(null)
  const [isSource, setSource] = useState(false)
  const ext = extOf(path)
  const isText = MARKDOWN.test(ext) || TEXT.test(ext) || ext === ""
  useEffect(() => {
    get(fileUrl(id, path, "fileinfo")).then(res => {
      setInfo(res ?? { error: "No connection to the server" })
      if (res && !res.error && res.isViewable && isText)
        fetch(fileUrl(id, path)).then(r => r.text()).then(setText, () => setText(""))
    })
  }, [id, path])
  const openOnMac = async () => {
    const res = await post(`/api/sessions/${id}/openfile`, { path })
    if (!res.body.ok) ui.toast(res.body.error ?? "Could not open it")
  }
  const src = fileUrl(id, path)
  const body = !info
    ? html`<p class="muted">Loading…</p>`
    : info.error
      ? html`<p class="muted">${info.error}</p>`
      : !info.isViewable
        ? html`<p class="muted">Too large to show here (${bytesText(info.size)}).</p>`
        : MARKDOWN.test(ext) && !isSource
          ? text === null ? html`<p class="muted">Loading…</p>` : html`<article class="md file-md" dangerouslySetInnerHTML=${{ __html: md(text) }}></article>`
          : isText
            ? html`<pre class="file-text">${text ?? ""}</pre>`
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
                      : html`<p class="muted">This kind of file does not show here: open it on the Mac.</p>`
  return html`<section class="file-view">
    <header class="file-head">
      <div class="file-name"><b>${nameOf(path)}</b><small title=${info?.path ?? path}>${(info?.path ?? path).replace(/^\/Users\/[^/]+/, "~")}${info?.size != null ? ` · ${bytesText(info.size)}` : ""}</small></div>
      ${MARKDOWN.test(ext) && html`<button class="btn subtle" onClick=${() => setSource(!isSource)}>${isSource ? "Rendered" : "Source"}</button>`}
      ${info && !info.error && html`<button class="btn subtle" onClick=${openOnMac} title="Open it in its app on this Mac">Open on the Mac</button>`}
    </header>
    <div class="file-body">${body}</div>
  </section>`
}
