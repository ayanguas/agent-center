// Files sent with a message, from the reply box and from "New session". The
// mod can only send text: each file is saved on this Mac first, and the
// message names its path for Claude to open (lib/uploads.ts). Any file, as in
// the desktop app: images, PDFs, documents, spreadsheets, code… The
// conversation reads those paths back to show pictures and named files.
import { html, useContext, useEffect, useRef, useState } from "../vendor/preact-htm.js"
import { Ctx } from "./ctx.js"
import { Icon } from "./icons.js"
import { bytesText } from "./util.js"

const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"]
const MAX_FILES = 10
const MAX_BYTES = 500 * 1024 * 1024 // as lib/uploads.ts
export const IMAGE_FILE = /\.(?:png|jpe?g|gif|webp)$/i

// A saved file's path, as the message names it; and the line that names the
// files for Claude, which the conversation leaves out. ATTACH_LINES matches the
// English lines and the Spanish ones that older transcripts hold.
export const UPLOAD_RE = /\/\.claude\/agent-center\/uploads\/([\w-]+\/[\w.-]+)/g
export const ATTACH_LINES = /\n*(?:Attached (?:image|file) \([^)]*\): \S+|Attached (?:images|files) \([^)]*\):(?:\n- \S+)+|(?:Imagen|Archivo) adjunt[ao] \([^)]*\): \S+|(?:Imágenes|Archivos) adjunt[ao]s \([^)]*\):(?:\n- \S+)+)\s*$/
// The name the file had: the saved name minus its "<time>-<random>-".
export const fileName = rel => rel.split("/").pop().replace(/^\d+-[0-9a-f]{6}-?/, "") || rel.split("/").pop()

export async function uploadFile(sessionId, file) {
  try {
    const res = await fetch(`/api/sessions/${sessionId}/upload`, {
      method: "POST",
      headers: { "content-type": file.type || "application/octet-stream", "x-file-name": encodeURIComponent(file.name ?? ""), "x-agent-center": "1" },
      body: file,
    })
    const body = await res.json()
    if (!body.ok) throw new Error(body.error)
    return body.path
  } catch (err) {
    throw new Error(`${file.name || "File"}: ${err.message || "could not save it"}`)
  }
}

// Images keep their usual line; any other file makes it "Attached file(s)".
// A change to the wording must also go in ATTACH_LINES, which still finds the
// old lines in old transcripts.
export function withFiles(text, paths) {
  if (!paths.length) return text
  const allImages = paths.every(p => IMAGE_FILE.test(p))
  const list = allImages
    ? paths.length === 1 ? `Attached image (open it with Read): ${paths[0]}` : `Attached images (open them with Read):\n${paths.map(p => `- ${p}`).join("\n")}`
    : paths.length === 1 ? `Attached file (open it with Read): ${paths[0]}` : `Attached files (open them with Read):\n${paths.map(p => `- ${p}`).join("\n")}`
  return text ? `${text}\n\n${list}` : list
}

const release = list => list.forEach(f => f.url && URL.revokeObjectURL(f.url))

// The files picked for one message: { key, file, url } (url, a preview, only
// for images). `initial` comes from a kept draft. With `isKept` the previews
// outlive the component (the reply box keeps them with its draft); otherwise
// they are released when it goes.
export function useAttachments(initial = [], { isKept = false } = {}) {
  const ui = useContext(Ctx)
  const [files, setFiles] = useState(initial)
  const current = useRef(files)
  current.current = files
  useEffect(() => () => isKept || release(current.current), [])

  const add = added => {
    const ok = [...added].filter(f => f.size > 0 && f.size <= MAX_BYTES)
    if (ok.length < added.length) ui.toast("Each file can be up to 500 MB (and cannot be empty)")
    setFiles(list => {
      const next = [...list, ...ok.map(file => ({ key: crypto.randomUUID(), file, url: IMAGE_TYPES.includes(file.type) ? URL.createObjectURL(file) : null }))]
      if (next.length > MAX_FILES) ui.toast(`Up to ${MAX_FILES} files per message`)
      return next.slice(0, MAX_FILES)
    })
  }
  const remove = key => setFiles(list => list.filter(f => (f.key === key ? (release([f]), false) : true)))
  const clear = () => (release(current.current), setFiles([]))
  // Pasted files join the message instead of the text.
  const onPaste = e => {
    const pasted = [...(e.clipboardData?.files ?? [])]
    if (!pasted.length) return
    e.preventDefault()
    add(pasted)
  }
  // On the form: dragged files light it up, dropped ones join the message.
  const dropProps = {
    onDragOver: e => [...(e.dataTransfer?.items ?? [])].some(i => i.kind === "file") && (e.preventDefault(), e.currentTarget.classList.add("drop")),
    onDragLeave: e => !e.currentTarget.contains(e.relatedTarget) && e.currentTarget.classList.remove("drop"),
    onDrop: e => {
      e.currentTarget.classList.remove("drop")
      if (!e.dataTransfer?.files?.length) return
      e.preventDefault()
      add(e.dataTransfer.files)
    },
  }
  return { files, add, remove, clear, onPaste, dropProps }
}

// The paperclip and its hidden file picker.
export function AttachButton({ onFiles }) {
  const picker = useRef()
  return html`<input ref=${picker} type="file" multiple hidden onChange=${e => (onFiles(e.target.files), (e.target.value = ""))} />
    <button type="button" class="icon-btn" title="Attach images, PDFs or any file (you can also paste or drag them)"
      onClick=${() => picker.current.click()}><${Icon} name="paperclip" size=${15} /></button>`
}

// The files waiting to go: a thumbnail per image, a named chip per other file.
export function Attachments({ files, onRemove }) {
  if (!files.length) return null
  return html`<div class="composer-images">
    ${files.map(f => f.url
      ? html`<span key=${f.key} class="thumb"><img src=${f.url} alt="" />
          <button type="button" class="icon-btn" title="Remove the image" onClick=${() => onRemove(f.key)}><${Icon} name="x" size=${11} /></button></span>`
      : html`<span key=${f.key} class="file-chip draft" title=${`${f.file.name} · ${bytesText(f.file.size)}`}>
          <${Icon} name="file" size=${14} /><span>${f.file.name}</span><small>${bytesText(f.file.size)}</small>
          <button type="button" class="icon-btn" title="Remove the file" onClick=${() => onRemove(f.key)}><${Icon} name="x" size=${11} /></button></span>`)}
  </div>`
}
