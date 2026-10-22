// Dictation with the browser's speech recognition. Chrome can recognise on
// this Mac (processLocally) once its model for the language is installed; otherwise it
// sends the audio to Google's servers. `isLocal` says which one runs.
const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition

export const canDictate = !!Recognition

async function tryLocal(lang) {
  const options = { langs: [lang], processLocally: true }
  try {
    if (typeof Recognition.available === "function") {
      let status = await Recognition.available(options)
      if (status === "downloadable" && typeof Recognition.install === "function") status = (await Recognition.install(options)) ? "available" : status
      return status === "available"
    }
    if (typeof Recognition.availableOnDevice === "function") {
      let status = await Recognition.availableOnDevice(lang)
      if (status === "downloadable" && typeof Recognition.installOnDevice === "function") status = (await Recognition.installOnDevice(lang)) ? "available" : status
      return status === "available"
    }
  } catch {}
  return false
}

// `onText(final, interim)`: everything heard so far. `onEnd(error)`: it stopped.
// The language is the browser's own.
export async function dictate({ lang = navigator.language || "en-US", onText, onEnd }) {
  const rec = new Recognition()
  rec.lang = lang
  rec.continuous = true
  rec.interimResults = true
  const isLocal = await tryLocal(lang)
  if (isLocal) {
    if ("processLocally" in rec) rec.processLocally = true
    else if ("mode" in rec) rec.mode = "ondevice-only"
  }
  let heard = ""
  rec.onresult = e => {
    let interim = ""
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i]
      if (r.isFinal) heard += r[0].transcript
      else interim += r[0].transcript
    }
    onText(heard, interim)
  }
  let error = null
  rec.onerror = e => (error = e.error)
  rec.onend = () => onEnd(error)
  rec.start()
  return { stop: () => rec.stop(), isLocal }
}

// ---------- Whisper on this Mac (lib/transcribe.ts) ----------
// Works in any browser that can record: the audio goes to the local server,
// which writes the text. Asked once per page whether the server has it.

let whisperReady = null
export async function hasWhisper() {
  if (whisperReady === null)
    whisperReady = fetch("/api/transcribe").then(r => r.json()).then(r => !!r.ready).catch(() => false)
  return whisperReady
}

export const canRecord = !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder)

// Starts recording the microphone. `stop()` resolves the recording's text;
// `cancel()` drops it.
export async function recordVoice() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const type = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/webm", "audio/mp4"].find(t => MediaRecorder.isTypeSupported(t))
  const recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined)
  const chunks = []
  recorder.ondataavailable = e => e.data.size && chunks.push(e.data)
  const ended = new Promise(resolve => (recorder.onstop = resolve))
  recorder.start()
  const release = () => stream.getTracks().forEach(t => t.stop())
  return {
    stream,
    startedAt: Date.now(),
    async stop() {
      recorder.stop()
      await ended
      release()
      const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" })
      const res = await fetch("/api/transcribe", { method: "POST", headers: { "content-type": blob.type, "x-agent-center": "1" }, body: blob })
      const body = await res.json().catch(() => ({}))
      if (!body.ok) throw new Error(body.error || "Could not transcribe")
      return body.text
    },
    cancel() {
      recorder.onstop = null
      if (recorder.state !== "inactive") recorder.stop()
      release()
    },
  }
}
