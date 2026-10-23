// A short chime when a session ends its turn or asks you something, played
// by the page itself (Web Audio, no file): unlike a notification, it also
// reaches you while you look at the board. Chrome keeps the audio of a page
// silent until you click or type in it once; the first click wakes it.
let audio = null

function context() {
  audio ??= new AudioContext()
  if (audio.state === "suspended") audio.resume().catch(() => {})
  return audio
}

for (const type of ["pointerdown", "keydown"]) window.addEventListener(type, () => audio?.state === "suspended" && audio.resume().catch(() => {}), { capture: true })

// Two soft notes going up when a turn ends; the same two, higher, when a
// session asks you something.
const NOTES = { done: [659.25, 987.77], ask: [880, 1318.51] }

export function chime(kind = "done") {
  const ctx = context()
  const start = ctx.currentTime + 0.02
  NOTES[kind].forEach((freq, i) => {
    const at = start + i * 0.12
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = "sine"
    osc.frequency.value = freq
    gain.gain.setValueAtTime(0, at)
    gain.gain.linearRampToValueAtTime(0.12, at + 0.015)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.45)
    osc.connect(gain).connect(ctx.destination)
    osc.start(at)
    osc.stop(at + 0.5)
  })
}
