// Reading aloud, with macOS `say`, what a session did when its turn ends:
// the recap it wrote for the desktop app's "next step" box (the wrap_up
// call), and its question if it asks one. Only this turn's recap counts: one
// from before the person's last prompt is old, and then it only says that
// the session finished (or asks, or needs approval). The page tells when a
// turn ends; each recap is read once, however many pages ask.

import { open, stat } from "node:fs/promises"
import { exec } from "./proc"
import { isInterrupted, isPersonPrompt, queuedPrompt, transcriptPath } from "./transcript"

const TAIL = 512 * 1024
const MAX_WAITING = 5 // more at once are skipped: nobody follows ten recaps in a row
const RATES = { min: 120, max: 300 }

export type Kind = "done" | "ask" | "permission"
export type Voice = { name: string; locale: string }

// This turn's wrap_up, if it has one: its id, recap and question.
export async function lastRecap(id: string) {
  const path = await transcriptPath(id)
  if (!path) return null
  const { size } = await stat(path)
  const handle = await open(path, "r")
  let text = ""
  try {
    const from = Math.max(0, size - TAIL)
    const buf = Buffer.alloc(size - from)
    await handle.read(buf, 0, buf.length, from)
    text = buf.toString("utf8")
  } finally {
    await handle.close()
  }
  for (const line of text.split("\n").reverse()) {
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"') && !line.includes('"queued_command"')) continue
    let row: any
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    if (row.isSidechain) continue
    if (isPersonPrompt(row) || queuedPrompt(row)) return { size, recap: null }
    if (row.type !== "assistant" || !Array.isArray(row.message?.content)) continue
    for (const b of row.message.content)
      if (b?.type === "tool_use" && String(b.name).endsWith("ccd_turn__wrap_up") && typeof b.input?.recap === "string")
        return { size, recap: { key: String(b.id), text: b.input.recap as string, ask: typeof b.input.ask === "string" ? (b.input.ask as string) : null } }
  }
  return { size, recap: null }
}

// A recap as it sounds right: no commit hashes, links, paths or code marks.
export function spokenForm(text: string) {
  return text
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g, "") // d1e92ba
    .replace(/(?<![\w.])(?:~|\.{0,2})?(?:\/[\w@-][\w.@-]*){2,}\/?/g, p => p.replace(/\/$/, "").split("/").pop()!) // ~/organizer/agent-center → agent-center
    .replace(/(\.\w{1,6}):\d+\b/g, "$1") // file.ts:42
    .replace(/\s*(?:→|->|⇒)\s*/g, ", ")
    .replace(/[`*_#>]/g, "")
    .replace(/\(\s*[^()\p{L}]*\)/gu, "") // what is left of "(d1e92ba → 9abab26)"
    .replace(/\s+([.,;:!?])/g, "$1")
    .replace(/([.,;:!?])[,\s]*,/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
}

let voices: Voice[] | null = null

// The voices of this Mac, from `say -v ?`.
export async function listVoices() {
  if (voices) return voices
  const out = await exec(["/usr/bin/say", "-v", "?"], { timeoutMs: 5000 })
  voices = out.stdout.split("\n").flatMap(line => {
    const m = line.match(/^(.+?)\s+([a-z]{2,3}_[A-Za-z0-9]{2,4})\s+#/)
    return m ? [{ name: m[1]!.trim(), locale: m[2]! }] : []
  })
  return voices
}

// "system", the default: the voice chosen in System Settings → Accessibility
// → Read & Speak (System voice, after System speech language), which `say`
// uses when it is given none. Siri's voices are only reachable this way
// (`say -v ?` does not list them).
export const SYSTEM = "system"
const SPANISH = /[áéíóúñ¿¡]|\b(el|la|los|las|que|de|del|y|en|por|para|con|una?|es)\b/i
let systemSpeaksSpanish: boolean | null = null

// The language of the system voice is not written anywhere `say` reads:
// the words to be said tell it, else the Mac's preferred languages.
async function languageOf(voice: Voice, text: string) {
  if (voice.name !== SYSTEM) return voice.locale.startsWith("es") ? "es" : "en"
  if (SPANISH.test(text)) return "es"
  systemSpeaksSpanish ??= /"?es[-_"]/.test((await exec(["/usr/bin/defaults", "read", "-g", "AppleLanguages"], { timeoutMs: 3000 })).stdout)
  return systemSpeaksSpanish ? "es" : "en"
}

// The voice asked for, if this Mac has it; else the system's.
async function voiceOf(name: unknown): Promise<Voice> {
  return (await listVoices()).find(v => v.name === name) ?? { name: SYSTEM, locale: "" }
}

export const defaultVoice = () => SYSTEM

// What it says when the turn has no recap of its own.
const PLAIN = {
  es: { done: "ha terminado.", ask: "te pregunta algo.", permission: "necesita tu permiso." },
  en: { done: "has finished.", ask: "is asking you something.", permission: "needs your approval." },
}
const SAMPLE = {
  es: "Agent Center. Así te contaré lo que ha hecho una sesión cuando termine.",
  en: "Agent Center. This is how I will tell you what a session did when it finishes.",
}

let queue = Promise.resolve()
let waiting = 0
const spoken = new Set<string>()

function say(text: string, voice: Voice, rate: unknown) {
  if (waiting >= MAX_WAITING) return false
  if (process.env.AGENT_CENTER_DRY_RUN) return true // the tests: silent
  const r = Number(rate)
  const args = [...(voice.name !== SYSTEM ? ["-v", voice.name] : []), ...(Number.isFinite(r) && r > 0 ? ["-r", String(Math.round(Math.min(RATES.max, Math.max(RATES.min, r))))] : [])]
  waiting++
  // The text goes in on stdin: one starting with "-" is never an option.
  queue = queue.then(() => exec(["/usr/bin/say", ...args, "-f", "-"], { input: text, timeoutMs: 120_000 })).then(() => void waiting--)
  return true
}

// A session's turn ended (or it asks): its recap, read once. Answers what
// it says, or null when there is nothing new to say.
export async function speakTurn(id: string, title: string, kind: Kind, options: { voice?: unknown; rate?: unknown }) {
  if (kind === "done" && (await isInterrupted(id))) return null // you stopped it yourself
  const last = await lastRecap(id)
  if (!last) return null
  const key = last.recap?.key ?? `${kind}:${id}:${last.size}`
  if (spoken.has(key)) return null
  spoken.add(key)
  if (spoken.size > 500) spoken.delete(spoken.values().next().value!)
  const voice = await voiceOf(options.voice)
  const name = spokenForm(title).replace(/[.!?]+$/, "")
  const lang = await languageOf(voice, `${name} ${last.recap?.text ?? ""}`)
  const text = last.recap ? `${name}. ${spokenForm(last.recap.text)}${last.recap.ask ? ` ${spokenForm(last.recap.ask)}` : ""}` : `${name} ${PLAIN[lang][kind]}`
  return say(text, voice, options.rate) ? text : null
}

// The setting's "Try it": a sample in the chosen voice.
export async function speakSample(options: { voice?: unknown; rate?: unknown }) {
  const voice = await voiceOf(options.voice)
  say(SAMPLE[await languageOf(voice, "")], voice, options.rate)
}
