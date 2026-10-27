// Monaco, the editor of VS Code, for the "Code" tab. It is 25 MB, so it is not
// in this repository: the first time the tab opens, the board downloads the
// pinned release from npm, checks it against the hash below, and keeps its
// browser build in the state folder. The page then loads it from
// /vendor/monaco/vs/… (same origin, so its workers run).

import { mkdir, rename, rm, stat } from "node:fs/promises"
import { join, resolve, sep } from "node:path"
import { STATE_DIR } from "./config"
import { exec } from "./proc"

const VERSION = "0.57.0"
const TARBALL = `https://registry.npmjs.org/monaco-editor/-/monaco-editor-${VERSION}.tgz`
const INTEGRITY = "sha512-5BkI9KGoqrNvBGUe15/QlZq3OooZ8WLg1AxTpaqHRCP3HNpzPPZKE2EDz8M7c+VRmCeUw1Brp4cx/PWm3kI/5A=="
const DIR = join(STATE_DIR, "vendor", `monaco-${VERSION}`)
const VS = join(DIR, "vs")

export type MonacoState = { ready: boolean; progress?: number; error?: string }
let job: MonacoState | null = null

const isReady = () => stat(join(VS, "loader.js")).then(() => true, () => false)

async function download() {
  const res = await fetch(TARBALL)
  if (!res.ok || !res.body) throw new Error(`npm answered ${res.status}`)
  const total = Number(res.headers.get("content-length")) || 0
  const parts: Uint8Array[] = []
  let got = 0
  for await (const chunk of res.body) {
    parts.push(chunk)
    got += chunk.length
    if (total) job!.progress = got / total
  }
  const data = Buffer.concat(parts)
  const hash = `sha512-${new Bun.CryptoHasher("sha512").update(data).digest("base64")}`
  if (hash !== INTEGRITY) throw new Error("The download does not match the expected release")
  const tmp = `${DIR}.partial`
  await rm(tmp, { recursive: true, force: true })
  await mkdir(tmp, { recursive: true })
  await Bun.write(join(tmp, "monaco.tgz"), data)
  const out = await exec(["/usr/bin/tar", "-xzf", join(tmp, "monaco.tgz"), "-C", tmp, "--strip-components=2", "package/min/vs"], { timeoutMs: 120_000 })
  if (out.code !== 0) throw new Error(`Could not unpack it: ${out.stderr.trim()}`)
  await rm(join(tmp, "monaco.tgz"))
  await rm(DIR, { recursive: true, force: true })
  await rename(tmp, DIR)
}

// Where it stands; asked for, it starts the download (once).
export async function monacoState(): Promise<MonacoState> {
  if (await isReady()) return { ready: true }
  if (!job || job.error) {
    job = { ready: false, progress: 0 }
    download().then(() => (job = { ready: true }), err => (job = { ready: false, error: (err as Error).message }))
  }
  return job
}

// One of its files, for /vendor/monaco/<path>.
export async function monacoFile(path: string) {
  const file = resolve(DIR, `.${decodeURIComponent(path)}`)
  if (!file.startsWith(VS + sep)) return null
  const asset = Bun.file(file)
  return (await asset.exists()) ? asset : null
}
