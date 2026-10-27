// The "Changes" tab: the session's diff against its base branch (with what is
// not committed yet), file by file. A click on a line leaves a comment there;
// the comments go to the session as one message. A draft of them survives
// closing the panel. "Side by side" shows them in VS Code's diff view instead.
import { html, useEffect, useRef, useState } from "../vendor/preact-htm.js"
import { SideBySide } from "./code.js"
import { Kbd } from "./ctx.js"
import { Icon } from "./icons.js"
import { get, keep, load } from "./util.js"

const MAX_LINES = 400 // a longer file opens folded

function reviewMessage(comments, branch) {
  const list = Object.values(comments).sort((a, b) => a.path.localeCompare(b.path) || a.no - b.no)
  return `Comments on your changes${branch ? ` (branch ${branch})` : ""}:\n\n${list
    .map((c, i) => `${i + 1}. \`${c.path}:${c.no}\`${c.side === "old" ? " (deleted line)" : ""}\n   > ${c.code.trim() || "(empty line)"}\n   ${c.text.trim().replace(/\n/g, "\n   ")}`)
    .join("\n\n")}\n\nApply these comments and tell me what you changed.`
}

function DiffLine({ line, file, comment, isEditing, onPick, onSave, onRemove, onCancel }) {
  const side = line.kind === "del" ? "old" : "new"
  const no = side === "old" ? line.old : line.new
  const sign = line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "
  return html`<div class=${`dl dl-${line.kind} ${comment ? "has-comment" : ""}`} onClick=${() => onPick({ path: file.path, side, no, code: line.text })}
      title="Click to comment on this line">
      <span class="dl-no">${line.old ?? ""}</span><span class="dl-no">${line.new ?? ""}</span>
      <span class="dl-sign">${sign}</span><span class="dl-code">${line.text || " "}</span>
    </div>
    ${(isEditing || comment) && html`<${LineComment} comment=${comment} isEditing=${isEditing}
      onSave=${text => onSave({ path: file.path, side, no, code: line.text, text })} onRemove=${onRemove} onCancel=${onCancel}
      onEdit=${() => onPick({ path: file.path, side, no, code: line.text })} />`}`
}

function LineComment({ comment, isEditing, onSave, onRemove, onCancel, onEdit }) {
  const area = useRef()
  useEffect(() => isEditing && area.current?.focus(), [isEditing])
  if (!isEditing)
    return html`<div class="dl-comment" onClick=${onEdit} title="Click to edit it"><${Icon} name="pencil" size=${12} /><span>${comment.text}</span>
      <button class="icon-btn" title="Remove the comment" onClick=${e => (e.stopPropagation(), onRemove())}><${Icon} name="x" size=${12} /></button></div>`
  const save = () => (area.current.value.trim() ? onSave(area.current.value) : comment ? onRemove() : onCancel())
  return html`<div class="dl-editor" onClick=${e => e.stopPropagation()}>
    <textarea ref=${area} rows="2" defaultValue=${comment?.text ?? ""} placeholder="What needs to change here?"
      onKeyDown=${e => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.preventDefault(), save())
        if (e.key === "Escape") (e.stopPropagation(), onCancel())
      }}></textarea>
    <div class="dl-editor-bar"><span class="muted"><${Kbd}>⌘<//><${Kbd}>↵<//> save · <${Kbd}>Esc<//> cancel</span>
      <button class="btn subtle" onClick=${onCancel}>Cancel</button><button class="btn primary" onClick=${save}>Save</button></div>
  </div>`
}

function FileBlock({ file, comments, editing, setEditing, setComment, removeComment }) {
  const total = file.hunks.reduce((n, h) => n + h.lines.length, 0)
  const [isOpen, setOpen] = useState(!file.collapsed && total <= MAX_LINES)
  const keyOf = (side, no) => `${file.path}:${side}:${no}`
  const count = Object.values(comments).filter(c => c.path === file.path).length
  return html`<section class="df">
    <header class="df-head" onClick=${() => setOpen(!isOpen)}>
      <${Icon} name="chevron" size=${12} class=${isOpen ? "open" : ""} />
      <span class=${`df-status s-${file.status}`}>${{ added: "new", deleted: "deleted", renamed: "renamed", modified: "" }[file.status]}</span>
      <span class="df-path" title=${file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>${file.path}</span>
      ${count > 0 && html`<span class="tag tone-ask">${count} ${count === 1 ? "comment" : "comments"}</span>`}
      <span class="df-stat"><b class="add">+${file.additions}</b> <b class="del">−${file.deletions}</b></span>
    </header>
    ${isOpen && (file.binary
      ? html`<p class="muted df-note">Binary file.</p>`
      : file.collapsed
        ? html`<p class="muted df-note">Generated or dependency file: not shown.</p>`
        : file.hunks.map((h, i) => html`<div class="dh" key=${i}>
            ${h.header && html`<div class="dh-head">${h.header}</div>`}
            ${h.lines.map((line, j) => {
              const side = line.kind === "del" ? "old" : "new"
              const key = keyOf(side, side === "old" ? line.old : line.new)
              return html`<${DiffLine} key=${j} line=${line} file=${file} comment=${comments[key]} isEditing=${editing === key}
                onPick=${c => setEditing(keyOf(c.side, c.no))} onCancel=${() => setEditing(null)}
                onSave=${c => (setComment(key, c), setEditing(null))} onRemove=${() => (removeComment(key), setEditing(null))} />`
            })}
          </div>`))}
  </section>`
}

export function Changes({ id, onSend }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [comments, setComments] = useState(() => load(`review.${id}`, {})) // a draft survives closing the panel
  const [editing, setEditing] = useState(null)
  const [isSending, setSending] = useState(false)
  const [view, setViewRaw] = useState(() => load("changesView", "lines")) // "lines" or "side"
  const setView = v => (setViewRaw(v), keep("changesView", v))
  const refresh = () =>
    get(`/api/sessions/${id}/changes`).then(res => (res?.files ? (setData(res), setError(null)) : setError(res?.error ?? "Could not read the changes")))
  useEffect(() => void refresh(), [id])
  useEffect(() => keep(`review.${id}`, comments), [comments])

  const setComment = (key, c) => setComments(cs => ({ ...cs, [key]: c }))
  const removeComment = key => setComments(({ [key]: _, ...rest }) => rest)
  const n = Object.keys(comments).length
  const send = async () => {
    setSending(true)
    const ok = await onSend(reviewMessage(comments, data?.branch))
    setSending(false)
    if (ok) setComments({})
  }

  if (error) return html`<div class="pane-empty">${error}</div>`
  if (!data) return html`<div class="pane-empty"><span class="spinner"></span></div>`
  const add = data.files.reduce((s, f) => s + f.additions, 0)
  const del = data.files.reduce((s, f) => s + f.deletions, 0)
  return html`<div class="changes">
    <div class="changes-head">
      <span><b>${data.files.length}</b> ${data.files.length === 1 ? "file" : "files"} · <b class="add">+${add}</b> <b class="del">−${del}</b></span>
      <span class="muted" title=${data.root}>${data.branch ? `${data.branch} against ${data.base}` : `against ${data.base}`}, with uncommitted changes</span>
      <span class="seg" role="group" aria-label="View">
        <button class=${view === "lines" ? "on" : ""} onClick=${() => setView("lines")} title="Line by line, with comments for the session">Lines</button>
        <button class=${view === "side" ? "on" : ""} onClick=${() => setView("side")} title="Side by side, in VS Code's diff view">Side by side</button>
      </span>
      <button class="btn subtle" onClick=${refresh}>Refresh</button>
    </div>
    ${view === "side" && data.files.length > 0 && html`<${SideBySide} key=${data.files.map(f => f.path).join("|")} id=${id} files=${data.files} />`}
    ${data.truncated && html`<p class="muted df-note">The diff is very large: only the start is shown.</p>`}
    ${data.files.length === 0 && html`<div class="pane-empty">No changes against ${data.base}.</div>`}
    <div class="changes-files" style=${view === "side" ? "display:none" : ""}>
      ${data.files.map(f => html`<${FileBlock} key=${f.path} file=${f} comments=${comments} editing=${editing}
        setEditing=${setEditing} setComment=${setComment} removeComment=${removeComment} />`)}
    </div>
    ${n > 0 && html`<div class="changes-bar">
      <span>${n} ${n === 1 ? "comment" : "comments"}</span>
      <button class="btn subtle" onClick=${() => setComments({})}>Discard</button>
      <button class="btn primary" disabled=${isSending} onClick=${send}><${Icon} name="send" size=${13} />Send to the session</button>
    </div>`}
  </div>`
}
