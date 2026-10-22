// "Run": start the session's project in its own folder with the command
// saved for its repository, see where it listens, read its output, stop it.
import { html, useContext, useEffect, useRef, useState } from "../vendor/preact-htm.js"
import { Ctx, Kbd } from "./ctx.js"
import { Icon } from "./icons.js"
import { clock, get, post } from "./util.js"

export function RunDialog({ card, onClose }) {
  const ui = useContext(Ctx)
  const dialog = useRef()
  const input = useRef()
  const logBox = useRef()
  const [info, setInfo] = useState(null)
  const [isBusy, setBusy] = useState(false)
  // Answers can come after the window closed: they are dropped then.
  const alive = useRef(true)
  const refresh = () => get(`/api/sessions/${card.id}/run`).then(res => alive.current && res && setInfo(res))
  useEffect(() => {
    dialog.current.showModal()
    void refresh()
    const timer = setInterval(refresh, 2000)
    return () => (clearInterval(timer), (alive.current = false))
  }, [])
  useEffect(() => {
    const el = logBox.current
    if (el) el.scrollTop = el.scrollHeight
  }, [info?.run?.lines?.length])

  const run = info?.run
  const isRunning = !!run?.isRunning
  const start = async () => {
    const command = input.current.value.trim()
    if (!command) return input.current.focus()
    setBusy(true)
    const res = await post(`/api/sessions/${card.id}/run`, { command })
    if (!alive.current) return
    setBusy(false)
    if (!res.body.ok) return ui.toast(res.body.error ?? "Could not start")
    void refresh()
  }
  const stop = async () => {
    await post(`/api/sessions/${card.id}/stoprun`)
    setTimeout(refresh, 800)
  }

  return html`<dialog class="dialog run" ref=${dialog} onClose=${onClose} onCancel=${onClose}
    onClick=${e => e.target === dialog.current && onClose()}>
    <h2><${Icon} name="play" size=${16} />Run <span class="muted">${card.title}</span></h2>
    ${!info
      ? html`<div class="pane-empty"><span class="spinner"></span></div>`
      : html`
        <label class="run-label">Command to start <b>${info.repo}</b></label>
        <input ref=${input} class="field mono" defaultValue=${run?.command ?? info.command ?? info.suggestion ?? ""}
          placeholder="npm run dev" spellcheck="false" onKeyDown=${e => e.key === "Enter" && start()} />
        <p class="muted run-hint">Saved for every session of ${info.repo}. It runs in this session's folder
          (<span class="mono" title=${info.cwd}>${info.cwd.replace(/^\/Users\/[^/]+/, "~")}</span>). <code>$PORT</code> holds a free port.</p>
        <div class="run-state">
          ${isRunning
            ? html`<span class="live on"><i></i>Running since ${clock(run.startedAt)}</span>
                ${run.ports.length
                  ? run.ports.map(p => html`<a class="btn" href=${`http://localhost:${p}`} target="_blank" rel="noreferrer">localhost:${p} <${Icon} name="external" size=${12} /></a>`)
                  : html`<span class="muted">Waiting for it to open a port…</span>`}`
            : run
              ? run.wasStopped
                ? html`<span class="live"><i></i>Stopped</span>`
                : html`<span class=${`live ${run.exitCode ? "bad" : ""}`}><i></i>Exited${run.exitCode ? ` with an error (code ${run.exitCode})` : ""}</span>`
              : html`<span class="muted">Not running.</span>`}
          <span class="spacer"></span>
          ${isRunning && html`<button class="btn danger-text" onClick=${stop}><${Icon} name="stop" size=${12} />Stop</button>`}
          <button class="btn primary" disabled=${isBusy} onClick=${start}>
            <${Icon} name="play" size=${12} />${isRunning ? "Restart" : "Start"}</button>
        </div>
        ${run?.lines?.length > 0 && html`<pre class="run-log" ref=${logBox}>${run.lines.join("\n")}</pre>`}`}
    <div class="dialog-actions"><span class="muted">It keeps running after you close this window. <${Kbd}>Esc<//> close</span></div>
  </dialog>`
}

// On a card: what it runs, one click to its window.
export function RunChip({ card }) {
  const ui = useContext(Ctx)
  if (!card.run) return null
  const port = card.run.ports[0]
  return html`<button class="tag tone-work run-chip" title="This session's project is running"
    onClick=${e => (e.stopPropagation(), ui.openRun(card))}><${Icon} name="play" size=${11} />${port ? `:${port}` : "starting"}</button>`
}
