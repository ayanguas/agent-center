// "Setup": what this Mac needs for the board, one step at a time. Each
// step says what it changes and is done only when pressed (lib/setup.ts does
// it on the server). Opens by itself while a required step is missing.
import { html, useContext, useEffect, useRef, useState } from "../vendor/preact-htm.js"
import { Ctx } from "./ctx.js"
import { Icon } from "./icons.js"
import { get, post } from "./util.js"

const LANGUAGES = [
  ["auto", "Detect the language"], ["es", "Spanish"], ["en", "English"], ["fr", "French"], ["de", "German"], ["it", "Italian"], ["pt", "Portuguese"],
]

// What each step is, why it matters and what pressing it changes.
const STEPS = {
  claude: {
    title: "Claude desktop",
    need: "Required",
    text: "The board shows, wakes and opens the sessions of the Claude desktop app.",
    unavailable: html`Install it from <a href="https://claude.ai/download">claude.ai/download</a> and come back here.`,
  },
  hook: {
    title: "Session tracking",
    need: "Required",
    text: "Copies a hook to ~/.claude/hooks and adds it to ~/.claude/settings.json (it saves a backup first). This way the board knows what each session does and whether it asks you something.",
    action: "Install",
  },
  bridge: {
    title: "Bridge mod",
    need: "Required",
    text: "A Claude Code mod that delivers your messages, answers questions and approvals, and stops turns from here. Each session loads it when it starts.",
    action: "Install",
    outdated: "Update",
  },
  uploads: {
    title: "Read sent files",
    need: "Recommended",
    text: "Lets Claude open the files you send from the board without asking (only their folder, ~/.claude/agent-center/uploads).",
    action: "Allow",
  },
  whisper: {
    title: "Dictation on this Mac",
    need: "Optional",
    text: "Installs whisper-cpp and ffmpeg with Homebrew and downloads the model (about 550 MB). Your voice never leaves the Mac. Without this, the microphone uses the browser's dictation if it has one.",
    action: "Install",
  },
  organizer: {
    title: "Tasks",
    need: "Optional",
    text: "A markdown task list per project (~/organizer). Claude writes down what is still pending and the board shows it in each session. Installs organizer.py and adds the note below to ~/.claude/CLAUDE.md (it saves a backup first). Without this, the Tasks tab does not show.",
    action: "Install",
  },
  github: {
    title: "GitHub PRs",
    need: "Optional",
    text: "With the gh CLI signed in, each card shows its PRs and the conversation lets you review and merge them.",
  },
}

function StepState({ step }) {
  if (step.state === "done") return html`<span class="setup-state done"><${Icon} name="check" size=${13} />Done</span>`
  if (step.state === "working") return html`<span class="setup-state working"><span class="spinner small"></span>${step.detail === "model" ? "Downloading the model" : "Installing"}</span>`
  if (step.state === "outdated") return html`<span class="setup-state todo">Version ${step.detail}</span>`
  return html`<span class="setup-state todo">Pending</span>`
}

export function Setup({ onClose, notify, sound }) {
  const ui = useContext(Ctx)
  const dialog = useRef()
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState(null) // the step being done now
  const [language, setLanguage] = useState("auto")
  const alive = useRef(true)

  const refresh = () => get("/api/setup").then(res => alive.current && res?.steps && (setStatus(res), setLanguage(l => l === "auto" ? res.voiceLanguage : l)))
  useEffect(() => {
    dialog.current.showModal()
    void refresh()
    return () => (alive.current = false)
  }, [])
  // While something installs in the background (Whisper), its progress.
  const isWorking = status?.steps.some(s => s.state === "working")
  useEffect(() => {
    if (!isWorking) return
    const timer = setInterval(refresh, 1500)
    return () => clearInterval(timer)
  }, [isWorking])

  const run = async (id, options = {}) => {
    setBusy(id)
    const res = await post(`/api/setup/${id}`, { options })
    if (!alive.current) return
    setBusy(null)
    if (!res.body.ok) return ui.toast(res.body.error ?? "Could not complete this step")
    setStatus(res.body)
  }

  const steps = status?.steps ?? []
  return html`<dialog class="dialog setup" ref=${dialog} onClose=${onClose} onCancel=${onClose}>
    <h2>Setup</h2>
    <p class="muted setup-intro">Each step changes something on this Mac and runs only when you press it. Sessions that were already open load the mod when they restart.</p>
    ${!status && html`<p class="muted">Checking…</p>`}
    <ol class="setup-steps">
      ${steps.map(step => {
        const meta = STEPS[step.id]
        if (!meta) return null
        // Installed dictation keeps the language picker: a new choice applies at once.
        const changesLanguage = step.id === "whisper" && step.state === "done" && language !== status.voiceLanguage
        const label = step.state === "outdated" ? meta.outdated : changesLanguage ? "Save language" : step.state === "done" ? null : meta.action
        return html`<li key=${step.id} class=${`setup-step ${step.state}`}>
          <div class="setup-head">
            <b>${meta.title}</b><span class=${`setup-need need-${meta.need.toLowerCase()}`}>${meta.need}</span>
            <${StepState} step=${step} />
          </div>
          <p class="setup-text">${step.state === "unavailable" && meta.unavailable ? meta.unavailable : meta.text}</p>
          ${step.id === "whisper" && html`<label class="setup-field">Dictation language
            <select class="field" value=${language} onChange=${e => setLanguage(e.target.value)}>
              ${LANGUAGES.map(([value, name]) => html`<option key=${value} value=${value}>${name}</option>`)}
            </select></label>`}
          ${step.id === "whisper" && step.state === "working" && step.progress != null && html`<div class="setup-progress"><i style=${`width:${Math.round(step.progress * 100)}%`}></i></div>`}
          ${step.id === "whisper" && step.detail && step.state === "missing" && html`<p class="setup-error">${step.detail}</p>`}
          ${step.id === "organizer" && step.state !== "done" && html`<details class="setup-note"><summary>The note for CLAUDE.md</summary><pre>${status.organizerNote}</pre></details>`}
          ${step.id === "github" && step.state !== "done" && html`<p class="setup-text">In the terminal:
            <code>${step.detail === "not-installed" ? "brew install gh && gh auth login" : "gh auth login"}</code></p>`}
          <div class="setup-actions">
            ${label && html`<button class="btn primary" disabled=${busy !== null || step.state === "working"}
              onClick=${() => run(step.id, step.id === "whisper" ? { voiceLanguage: language } : {})}>${busy === step.id ? "One moment…" : label}</button>`}
            ${step.id === "organizer" && step.state === "done" && html`<button class="btn" disabled=${busy !== null}
              onClick=${() => run("organizer", { off: true })}>Turn off</button>`}
          </div>
        </li>`
      })}
      ${status && html`<li class=${`setup-step ${notify === "on" ? "done" : "missing"}`}>
        <div class="setup-head"><b>Notifications</b><span class="setup-need need-optional">Optional</span>
          ${notify === "on" ? html`<span class="setup-state done"><${Icon} name="check" size=${13} />Done</span>` : html`<span class="setup-state todo">Pending</span>`}</div>
        <p class="setup-text">A system notification when a session asks you something and you are in another window.</p>
        <div class="setup-actions">${notify !== "on" && html`<button class="btn primary" onClick=${() => ui.toggleNotify()}>Turn on</button>`}</div>
      </li>`}
      ${status && html`<li class=${`setup-step ${sound === "on" ? "done" : "missing"}`}>
        <div class="setup-head"><b>Sound</b><span class="setup-need need-optional">Optional</span>
          ${sound === "on" ? html`<span class="setup-state done"><${Icon} name="check" size=${13} />On</span>` : html`<span class="setup-state todo">Off</span>`}</div>
        <p class="setup-text">A short chime when a session finishes its turn or asks you something, also while you look at the board (notifications only reach you in another window). The speaker in the sidebar turns it on and off.</p>
        <div class="setup-actions"><button class=${`btn ${sound === "on" ? "" : "primary"}`} onClick=${() => ui.toggleSound()}>${sound === "on" ? "Turn off" : "Turn on"}</button></div>
      </li>`}
    </ol>
    <div class="dialog-actions">
      <span class="muted">${status && !status.isReady ? "Required steps are missing: without them the board cannot see or answer the sessions." : ""}</span>
      <button class="btn primary" onClick=${onClose}>Done</button>
    </div>
  </dialog>`
}
