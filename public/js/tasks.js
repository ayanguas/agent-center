// The "Tasks" tab: the tasks of the organizer created in this conversation,
// to tick off (with undo) or add to. They reload when the live data changes.
import { html, useContext, useEffect, useState } from "../vendor/preact-htm.js"
import { Ctx } from "./ctx.js"
import { Icon } from "./icons.js"
import { get, post } from "./util.js"

export function Tasks({ id }) {
  const ui = useContext(Ctx)
  const [tasks, setTasks] = useState(null)
  const [draft, setDraft] = useState("")
  const load = () => get(`/api/sessions/${id}/tasks`).then(res => setTasks(res?.tasks ?? []))
  useEffect(() => void load(), [id, ui.taskSignal])

  const close = async task => {
    setTasks(ts => ts.filter(t => t !== task))
    const res = await post("/api/tasks/close", task)
    if (!res.body.ok) return (ui.toast(res.body.error ?? "Could not close the task"), load())
    ui.toast(`Task done: ${task.text}`, async () => {
      await post("/api/tasks/reopen", task)
      load()
    })
  }
  const add = async e => {
    e.preventDefault()
    const text = draft.trim()
    if (!text) return
    setDraft("")
    const res = await post("/api/tasks/add", { text, session: id })
    if (!res.body.ok) ui.toast(res.body.error ?? "Could not add the task")
    load()
  }

  return html`<div class="tasks-pane">
    <p class="muted">Tasks from your organizer created in this conversation.</p>
    ${!tasks && html`<div class="skeleton-msgs"><i></i><i></i></div>`}
    ${tasks?.length === 0 && html`<p class="empty">This conversation has no open tasks.</p>`}
    <ul class="task-list">
      ${tasks?.map(
        t => html`<li key=${`${t.file}:${t.line}`}>
          <button class="check" title="Mark as done" onClick=${() => close(t)}><${Icon} name="check" size=${11} /></button>
          <span class=${t.priority === "high" ? "prio-high" : ""}>${t.text}</span>
          <span class="muted">${[t.project, t.due && `@${t.due}`].filter(Boolean).join(" · ")}</span>
        </li>`,
      )}
    </ul>
    <form onSubmit=${add}><input class="field" placeholder="New task, Enter to save" value=${draft}
      onInput=${e => setDraft(e.target.value)} /></form>
  </div>`
}
