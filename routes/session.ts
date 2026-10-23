// What the page does to one session (POST /api/sessions/<id>/<action>):
// messages through the bridge mod, answers, stop, settings, waking and
// opening it in the client, forks, runs, and the board's own actions (pin,
// park, done, archive, seen, move, rename).

import { applyAction, isBoardAction } from "../lib/board"
import { answer as answerQuestion, isBusy, permit, requestSettings, send as sendMessage, status as bridgeStatus, stop as stopTurn, unsend } from "../lib/bridge"
import { activate, openInClient } from "../lib/client"
import { EFFORTS, MODES } from "../lib/config"
import { forkPoint } from "../lib/fork"
import { errorMessage, json } from "../lib/http"
import { launch } from "../lib/launch"
import { refreshSoon } from "../lib/live"
import { commandStatus, runCommand, stopCommand } from "../lib/commands"
import { saveCommand, start as startRun, status as runStatus, stop as stopRun } from "../lib/runner"
import { groupOf } from "../lib/snapshot"
import { wokeNow } from "../lib/wake"

async function send(id: string, body: Record<string, unknown>) {
  try {
    const messageId = await sendMessage(id, String(body.text ?? ""))
    refreshSoon()
    const bridge = await bridgeStatus(id)
    // A closed session is woken up so the message does not wait for you;
    // one in a long tool run (no heartbeat meanwhile) is only busy.
    const woke = !bridge.isOpen && !isBusy(bridge) ? await activate(id) : null
    if (woke?.ok) wokeNow(id)
    return json({ ok: true, messageId, ...bridge, activated: !!woke?.ok })
  } catch (err) {
    return json({ error: errorMessage(err) }, 400)
  }
}

// "Fork": a new session with the conversation up to before one message.
async function fork(id: string, body: Record<string, unknown>) {
  const prompt = String(body.prompt ?? "").trim()
  const group = groupOf(id)
  if (!prompt || !group) return json({ error: "missing message or session" }, 400)
  const point = await forkPoint([id, ...group.ids.filter(x => x !== id)], String(body.messageId ?? ""))
  if (!point) return json({ error: "Cannot find that message in the conversation" }, 404)
  const resume = point.answerId ? ["--resume", point.sessionId, "--fork-session", "--resume-session-at", point.answerId] : []
  try {
    const forked = await launch(group.lead.cwd, prompt, done => void activate(done), resume)
    refreshSoon()
    return json({ ok: true, id: forked })
  } catch (err) {
    return json({ error: errorMessage(err) }, 500)
  }
}

// Permission mode, model and effort, changed through the session's mod (v4).
async function settings(id: string, body: Record<string, unknown>) {
  const bridge = await bridgeStatus(id)
  if (bridge.version < 4)
    return json({ error: "This session started with an older bridge mod: close it and open it again to change this from here" }, 409)
  const pick = (key: string, allowed: string[]) => (allowed.includes(String(body[key])) ? String(body[key]) : undefined)
  const changes = {
    mode: pick("mode", MODES),
    model: typeof body.model === "string" && /^[\w.\[\]-]{2,60}$/.test(body.model) ? body.model : undefined,
    effort: pick("effort", EFFORTS),
  }
  if (!changes.mode && !changes.model && !changes.effort) return json({ error: "nothing to change" }, 400)
  return json({ ok: true, requestId: await requestSettings(id, changes), isOpen: bridge.isOpen })
}

export async function handleSession(id: string, action: string, body: Record<string, unknown>): Promise<Response> {
  switch (action) {
    case "send":
      return send(id, body)
    case "fork":
      return fork(id, body)
    case "settings":
      return settings(id, body)
    case "run": {
      const group = groupOf(id)
      const command = String(body.command ?? "").trim()
      if (!group || !command) return json({ error: "missing command" }, 400)
      await saveCommand(group.root, command)
      await startRun(id, group.lead.cwd, command)
      refreshSoon()
      return json({ ok: true, run: await runStatus(id) })
    }
    case "stoprun":
      await stopRun(id)
      setTimeout(refreshSoon, 1500)
      return json({ ok: true })
    // "▶" on a shell block: the command runs in the session's folder.
    case "exec": {
      const group = groupOf(id)
      const command = String(body.command ?? "").trim()
      if (!group || !command) return json({ error: "missing command or session" }, 400)
      try {
        return json({ ok: true, command: runCommand(id, group.lead.cwd, command) })
      } catch (err) {
        return json({ error: errorMessage(err) }, 403)
      }
    }
    case "execstatus": {
      const command = commandStatus(id, String(body.commandId ?? ""))
      return command ? json({ ok: true, command }) : json({ error: "unknown command" }, 404)
    }
    case "execstop":
      return json({ ok: await stopCommand(id, String(body.commandId ?? "")) })
    // The answer to the question the session asks, given on the board.
    case "answer":
      try {
        await answerQuestion(id, String(body.id ?? ""), (body.answers ?? {}) as Record<string, string>)
        refreshSoon()
        return json({ ok: true })
      } catch (err) {
        return json({ error: errorMessage(err) }, 409)
      }
    // Allow or deny, on the board, the tool approval the client asks for.
    case "permit":
      try {
        await permit(id, String(body.id ?? ""), String(body.decision ?? ""))
        refreshSoon()
        return json({ ok: true })
      } catch (err) {
        return json({ error: errorMessage(err) }, 409)
      }
    case "unsend": {
      const ok = await unsend(id, String(body.messageId ?? ""))
      refreshSoon()
      return ok ? json({ ok }) : json({ error: "Already delivered: it cannot be undone" }, 409)
    }
    case "stop": {
      const bridge = await bridgeStatus(id)
      if (bridge.version < 2)
        return json({ error: "This session started with an older bridge mod: close it and open it again to stop it from here" }, 409)
      await stopTurn(id)
      refreshSoon()
      return json({ ok: true })
    }
    case "activate": {
      const res = await activate(id)
      if (res.ok) wokeNow(id)
      return json(res, res.ok ? 200 : 409)
    }
    case "open": {
      const res = await openInClient(id)
      return json(res, res.ok || !res.error ? 200 : 409)
    }
  }
  if (!isBoardAction(action)) return json({ error: `unknown action: ${action}` }, 400)
  const group = groupOf(id)
  const error = await applyAction(group?.key ?? id, group?.ids ?? [], action, body)
  if (error) return json({ error }, 400)
  refreshSoon()
  return json({ ok: true })
}
