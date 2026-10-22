// The microphone button for Whisper dictation, in "Reply" and in "New
// session". While it records it opens into a pill with a live wave (the
// microphone's level, drawn as bars that scroll left) and the time. A click
// or Enter stops and writes the text; Esc drops the recording.
import { html, useEffect, useRef, useState } from "../vendor/preact-htm.js"
import { Icon } from "./icons.js"
import { canRecord, hasWhisper, recordVoice } from "./voice.js"

export function useWhisper() {
  const [isReady, setReady] = useState(false)
  useEffect(() => void hasWhisper().then(setReady), [])
  return isReady && canRecord
}

const BARS = 34
const STEP_MS = 60

// Bars of the recent level, newest on the right, in the button's colour.
function drawWave(canvas, levels) {
  const ctx = canvas.getContext("2d")
  const { width, height } = canvas
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = getComputedStyle(canvas).color
  const gap = width / BARS
  const bar = Math.max(1.5, gap * 0.55)
  levels.forEach((level, i) => {
    const h = Math.max(height * 0.12, Math.min(height, level * height))
    ctx.globalAlpha = 0.35 + 0.65 * (i / BARS)
    ctx.beginPath()
    ctx.roundRect(i * gap + (gap - bar) / 2, (height - h) / 2, bar, h, bar / 2)
    ctx.fill()
  })
}

export function MicButton({ onText, onError }) {
  const [rec, setRec] = useState(null) // { stop, cancel, stream, startedAt } | "transcribing"
  const recNow = useRef(null) // for the unmount, which only sees the first render
  recNow.current = rec
  const [, tick] = useState(0)
  const canvas = useRef()

  // The live wave: the microphone's loudness, sampled into scrolling bars.
  useEffect(() => {
    if (!rec?.stream) return
    const audio = new AudioContext()
    const analyser = audio.createAnalyser()
    analyser.fftSize = 512
    audio.createMediaStreamSource(rec.stream).connect(analyser)
    const samples = new Uint8Array(analyser.fftSize)
    const levels = Array(BARS).fill(0)
    let last = 0
    let raf = 0
    const frame = now => {
      raf = requestAnimationFrame(frame)
      if (now - last < STEP_MS) return
      last = now
      analyser.getByteTimeDomainData(samples)
      let sum = 0
      for (const v of samples) sum += ((v - 128) / 128) ** 2
      levels.push(Math.min(1, Math.sqrt(sum / samples.length) * 4.5))
      levels.shift()
      const el = canvas.current
      if (el) drawWave(el, levels)
      tick(n => n + 1)
    }
    raf = requestAnimationFrame(frame)
    return () => (cancelAnimationFrame(raf), audio.close())
  }, [rec])

  const stop = async session => {
    setRec("transcribing")
    try {
      const heard = await session.stop()
      if (heard) onText(heard)
    } catch (err) {
      onError?.(err.message)
    }
    setRec(null)
  }
  const cancel = session => (session.cancel(), setRec(null))

  // Enter stops and writes, Esc drops: caught before the field sees them, so
  // Enter does not send the message.
  useEffect(() => {
    if (!rec?.stop) return
    const onKey = e => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) (e.preventDefault(), e.stopImmediatePropagation(), stop(rec))
      else if (e.key === "Escape") (e.preventDefault(), e.stopImmediatePropagation(), cancel(rec))
    }
    window.addEventListener("keydown", onKey, true)
    return () => window.removeEventListener("keydown", onKey, true)
  }, [rec])
  // Gone mid-recording (the dialog or the chat closed): the microphone stops too.
  useEffect(() => () => recNow.current?.cancel?.(), [])

  const start = async () => {
    try {
      setRec(await recordVoice())
    } catch (err) {
      onError?.(err?.name === "NotAllowedError" ? "The browser has no permission to use the microphone" : "Could not start recording")
    }
  }

  if (rec === "transcribing")
    return html`<span class="mic-pill busy"><span class="spinner small"></span>Transcribing…</span>`
  if (rec) {
    const s = Math.floor((Date.now() - rec.startedAt) / 1000)
    return html`<button type="button" class="mic-pill rec" onClick=${() => stop(rec)} title="Stop and write (↵) · discard (Esc)">
      <i class="rec-dot"></i>
      <canvas ref=${canvas} class="wave" width="204" height="40"></canvas>
      <span class="rec-time">${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}</span>
      <${Icon} name="stop" size=${11} />
    </button>`
  }
  return html`<button type="button" class="icon-btn mic" onClick=${start} title="Dictate (Whisper on this Mac)">
    <${Icon} name="mic" size=${15} /></button>`
}
