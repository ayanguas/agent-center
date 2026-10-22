// The "PRs" tab: the pull requests of the session's branch and those named in
// the conversation. For an open one, whether it is ready to merge (checks,
// review, comments, local changes, conflicts) with a button to ask the session
// to fix what is not; and the actions: merge, close, reopen, draft or ready.
import { html, useContext, useEffect, useState } from "../vendor/preact-htm.js"
import { Ctx } from "./ctx.js"
import { Icon } from "./icons.js"
import { ago, get, keep, load, post } from "./util.js"

const PR_STATE = {
  OPEN: ["Open", "tone-work"],
  DRAFT: ["Draft", "tone-muted"],
  MERGED: ["Merged", "tone-merged"],
  CLOSED: ["Closed", "tone-bad"],
}

// What GitHub says about merging, in words, and whether to try.
function mergeState(pr) {
  if (pr.isDraft) return ["Draft: mark it as ready to be able to merge", "muted", false]
  if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") return ["Has conflicts with the base branch", "bad", false]
  switch (pr.mergeStateStatus) {
    case "CLEAN": return ["Ready to merge", "work", true]
    case "HAS_HOOKS": return ["Ready to merge", "work", true]
    case "UNSTABLE": return ["Can be merged, but some checks are failing", "ask", true]
    case "BEHIND": return ["Out of date with the base branch", "ask", true]
    case "BLOCKED": return ["Blocked by the repo's rules (required review or checks)", "ask", true]
    default: return ["GitHub is working out whether it can be merged", "muted", true]
  }
}

const METHODS = { squash: "Squash", merge: "Merge commit", rebase: "Rebase" }

// "Ready to merge?": every reason to wait, in one list. Red stops the
// merge (it asks again), amber is worth a look, green is fine.
function Readiness({ pr, sessionId, onSend, onBlockers }) {
  const [data, setData] = useState(null)
  useEffect(() => {
    get(`/api/sessions/${sessionId}/readiness?url=${encodeURIComponent(pr.url)}`).then(res => res && setData(res))
  }, [pr.url, pr.updatedAt])

  const rows = []
  const add = (tone, text, extra = null) => rows.push({ tone, text, extra })
  if (pr.checks === "fail") add("bad", `${pr.failing.length} failing ${pr.failing.length === 1 ? "check" : "checks"}: ${pr.failing.slice(0, 3).join(", ")}`, {
    label: "Ask it to fix them",
    text: `These checks fail on PR #${pr.number} (${pr.url}): ${pr.failing.join(", ")}.\n\nRead the logs with \`gh pr checks ${pr.number}\`, fix them, commit and push, and tell me what happened.`,
  })
  else if (pr.checks === "pending") add("ask", `${pr.pending.length} ${pr.pending.length === 1 ? "check" : "checks"} running`)
  else add(pr.checks === "pass" ? "ok" : "muted", pr.checks === "pass" ? "Checks passing" : "No checks")
  add(pr.reviewDecision === "APPROVED" ? "ok" : pr.reviewDecision === "CHANGES_REQUESTED" ? "bad" : pr.reviewDecision === "REVIEW_REQUIRED" ? "ask" : "muted",
    pr.reviewDecision === "APPROVED" ? "Approved" : pr.reviewDecision === "CHANGES_REQUESTED" ? "Changes requested" : pr.reviewDecision === "REVIEW_REQUIRED" ? "Review required" : "No review required")
  if (data?.threads) {
    const n = data.threads.length
    add(n ? "bad" : "ok", n ? `${n} unresolved review ${n === 1 ? "comment" : "comments"}` : "No unresolved review comments", n ? {
      label: "Send to the session",
      text: `${n === 1 ? "There is 1 unresolved comment" : `There are ${n} unresolved comments`} on PR #${pr.number} (${pr.url}):\n\n${data.threads
        .map((t, i) => `${i + 1}. ${t.path ? `\`${t.path}${t.line ? `:${t.line}` : ""}\`` : "General review"}${t.isOutdated ? " (code already changed)" : ""} — @${t.author ?? "?"}:\n   ${t.body.replace(/\n/g, "\n   ")}`)
        .join("\n\n")}\n\nResolve them, commit and push, and tell me what you changed for each one.`,
    } : null)
  }
  if (data?.local) {
    const { uncommitted, unpushed } = data.local
    const issues = [uncommitted && `${uncommitted} ${uncommitted === 1 ? "uncommitted file" : "uncommitted files"}`, unpushed && `${unpushed} ${unpushed === 1 ? "unpushed commit" : "unpushed commits"}`].filter(Boolean)
    add(issues.length ? "bad" : "ok", issues.length ? `In the session's folder: ${issues.join(" and ")}` : "Everything committed and pushed")
  }
  if (data?.tasks?.length) add("ask", `${data.tasks.length} ${data.tasks.length === 1 ? "open task" : "open tasks"}: ${data.tasks[0].slice(0, 80)}${data.tasks[0].length > 80 ? "…" : ""}`)
  if (pr.mergeable === "CONFLICTING") add("bad", `Conflicts with ${pr.baseRefName}`, {
    label: "Ask it to resolve them",
    text: `PR #${pr.number} (${pr.url}) has conflicts with ${pr.baseRefName}. Update the branch with ${pr.baseRefName}, resolve the conflicts, check that everything still works, and push.`,
  })
  else if (pr.mergeStateStatus === "BEHIND") add("ask", `The branch is behind ${pr.baseRefName}`)

  const blockers = rows.filter(r => r.tone === "bad").map(r => r.text)
  useEffect(() => onBlockers(blockers), [blockers.join("|")])
  return html`<div class="ready">
    <div class="ready-title">Ready to merge?${!data && html`<span class="spinner small"></span>`}</div>
    ${rows.map(r => html`<div class=${`ready-row tone-${r.tone}`}>
      <span class="ready-mark">${{ ok: "✓", bad: "✗", ask: "•", muted: "–" }[r.tone]}</span><span class="ready-text">${r.text}</span>
      ${r.extra && html`<button class="btn subtle" onClick=${() => onSend(r.extra.text)}>${r.extra.label}</button>`}
    </div>`)}
  </div>`
}

function PrItem({ pr, sessionId, onSend, onDone }) {
  const ui = useContext(Ctx)
  const [confirm, setConfirm] = useState(null) // "merge" | "close"
  const [busy, setBusy] = useState(null)
  const [method, setMethod] = useState(load("mergeMethod", "squash"))
  const [deleteBranch, setDeleteBranch] = useState(load("deleteBranch", true))
  const [label, tone] = PR_STATE[pr.state === "OPEN" && pr.isDraft ? "DRAFT" : pr.state]
  const [mergeText, mergeTone, canMerge] = mergeState(pr)
  const [blockers, setBlockers] = useState([])

  const run = async (action, extra = {}) => {
    setConfirm(null)
    setBusy(action)
    const res = await post("/api/prs/action", { url: pr.url, action, ...extra })
    setBusy(null)
    const done = { merge: "merged", close: "closed", reopen: "reopened", ready: "marked as ready", draft: "converted to draft" }
    ui.toast(res.body.ok ? `#${pr.number} ${done[action]}` : `Could not do it: ${res.body.error ?? "gh error"}`)
    onDone()
  }

  const checks = pr.checks === "pass" ? html`<span class="tone-work">✓ Checks passing</span>`
    : pr.checks === "fail" ? html`<span class="tone-bad" title=${pr.failing.join("\n")}>✗ ${pr.failing.length} failing: ${pr.failing.slice(0, 2).join(", ")}${pr.failing.length > 2 ? "…" : ""}</span>`
    : pr.checks === "pending" ? html`<span class="tone-ask">• ${pr.pending.length} ${pr.pending.length === 1 ? "check" : "checks"} running</span>` : html`<span class="muted">No checks</span>`
  const review = pr.reviewDecision === "APPROVED" ? html`<span class="tone-work">Approved</span>`
    : pr.reviewDecision === "CHANGES_REQUESTED" ? html`<span class="tone-bad">Changes requested</span>`
    : pr.reviewDecision === "REVIEW_REQUIRED" ? html`<span class="tone-ask">Review required</span>` : null

  return html`<article class=${`pr-item ${pr.state !== "OPEN" ? "closed" : ""}`}>
    <header>
      <span class=${`chip ${tone}`}>${label}</span>
      <a class="pr-ref" href=${pr.url} target="_blank" rel="noreferrer" title="Open on GitHub">
        ${pr.repo}#${pr.number}<${Icon} name="external" size=${12} /></a>
      <span class="age">${ago(Date.parse(pr.updatedAt), ui.now)}</span>
    </header>
    <h3>${pr.title}</h3>
    <div class="pr-facts">
      <span class="mono">${pr.baseRefName} ← ${pr.headRefName}</span>
      <span><b class="tone-work">+${pr.additions}</b> <b class="tone-bad">−${pr.deletions}</b> · ${pr.changedFiles} ${pr.changedFiles === 1 ? "file" : "files"}</span>
    </div>
    ${pr.state === "OPEN" && (sessionId
      ? html`<${Readiness} pr=${pr} sessionId=${sessionId} onSend=${onSend} onBlockers=${setBlockers} />`
      : html`<div class="pr-facts">${checks}${review}</div>`)}
    ${pr.state === "OPEN" && html`<p class=${`merge-state tone-${mergeTone}`}>${mergeText}</p>`}
    ${confirm
      ? html`<div class="confirm">
          <span>${confirm === "merge"
            ? html`${blockers.length > 0 && html`<b class="tone-bad">Still pending: ${blockers.join(" · ")}.</b> `}Merge <b>#${pr.number}</b> into <b>${pr.baseRefName}</b> with ${METHODS[method].toLowerCase()}${deleteBranch ? " and delete the branch" : ""}${blockers.length ? " anyway" : ""}?`
            : html`Close <b>#${pr.number}</b> without merging?`}</span>
          <button class="btn" onClick=${() => setConfirm(null)}>Cancel</button>
          <button class=${`btn ${confirm === "merge" ? "primary" : "danger"}`} autofocus
            onClick=${() => run(confirm, confirm === "merge" ? { method, deleteBranch } : {})}>
            ${confirm === "merge" ? (blockers.length ? "Merge anyway" : "Merge") : "Close PR"}</button>
        </div>`
      : html`<div class="pr-actions">
          ${pr.state === "OPEN" && !pr.isDraft && html`
            <button class="btn primary" disabled=${!canMerge || !!busy} onClick=${() => setConfirm("merge")}>
              ${busy === "merge" ? "Merging…" : "Merge"}</button>
            <select class="field select" value=${method} onChange=${e => (setMethod(e.target.value), keep("mergeMethod", e.target.value))}
              title="Merge method">
              ${Object.entries(METHODS).map(([k, v]) => html`<option value=${k}>${v}</option>`)}
            </select>
            <label class="check-label"><input type="checkbox" checked=${deleteBranch}
              onChange=${e => (setDeleteBranch(e.target.checked), keep("deleteBranch", e.target.checked))} />Delete branch</label>`}
          ${pr.state === "OPEN" && pr.isDraft && html`<button class="btn primary" disabled=${!!busy} onClick=${() => run("ready")}>
            ${busy === "ready" ? "Marking…" : "Mark as ready"}</button>`}
          <span class="spacer"></span>
          ${pr.state === "OPEN" && !pr.isDraft && html`<button class="btn subtle" disabled=${!!busy} onClick=${() => run("draft")}>Convert to draft</button>`}
          ${pr.state === "OPEN" && html`<button class="btn subtle danger-text" disabled=${!!busy} onClick=${() => setConfirm("close")}>
            ${busy === "close" ? "Closing…" : "Close"}</button>`}
          ${pr.state === "CLOSED" && html`<button class="btn" disabled=${!!busy} onClick=${() => run("reopen")}>
            ${busy === "reopen" ? "Reopening…" : "Reopen"}</button>`}
        </div>`}
  </article>`
}

export function Prs({ id, onSend }) {
  const [prs, setPrs] = useState(null)
  const [showOld, setShowOld] = useState(false)
  const load = () => get(`/api/sessions/${id}/prs`).then(res => setPrs(res?.prs ?? []))
  useEffect(() => {
    void load()
    const timer = setInterval(load, 30_000)
    return () => clearInterval(timer)
  }, [id])
  if (!prs) return html`<div class="tasks-pane"><div class="skeleton-msgs"><i></i><i></i></div></div>`
  const open = prs.filter(p => p.state === "OPEN")
  const old = prs.filter(p => p.state !== "OPEN")
  return html`<div class="tasks-pane prs-pane">
    <p class="muted">PRs from this session's branch and PRs named in the conversation.</p>
    ${open.length === 0 && html`<p class="empty">No open PRs.</p>`}
    ${open.map(pr => html`<${PrItem} key=${pr.url} pr=${pr} sessionId=${id} onSend=${onSend} onDone=${load} />`)}
    ${old.length > 0 && html`<button class="group-head" onClick=${() => setShowOld(v => !v)} aria-expanded=${showOld}>
      <${Icon} name=${showOld ? "down" : "chevron"} size=${14} />Merged and closed<span class="count">${old.length}</span></button>`}
    ${showOld && old.map(pr => html`<${PrItem} key=${pr.url} pr=${pr} onDone=${load} />`)}
  </div>`
}
