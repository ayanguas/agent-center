// The "Code" tab: the session's repository as in VS Code. The file tree on
// the left (git's status marked: M changed, A added, U new), the open files
// as tabs, and Monaco, VS Code's own editor (lib/monaco.ts downloads it the
// first time). ⌘S saves. If the file changed on disk since it opened (Claude
// edited it), you choose: reload it, compare, or keep yours. An unchanged
// open file follows the disk by itself. ⌘P opens a file by its name.
import { html, useContext, useEffect, useMemo, useRef, useState } from "../vendor/preact-htm.js"
import { Ctx } from "./ctx.js"
import { Icon } from "./icons.js"
import { get, post } from "./util.js"

const WATCH_MS = 3000 // how often the open file is checked on disk
const TREE_MS = 10_000 // and the tree's git status (a folder without git is read once)
const nameOf = path => path.split("/").pop()
const dirOf = path => path.split("/").slice(0, -1).join("/")

// ---------- Monaco ----------

let loading = null
function loadMonaco() {
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement("script")
    script.src = "/vendor/monaco/vs/loader.js"
    script.onload = () => {
      window.require.config({ paths: { vs: "/vendor/monaco/vs" } })
      window.require(["vs/editor/editor.main"], () => resolve(window.monaco), reject)
    }
    script.onerror = () => ((loading = null), reject(new Error("The editor did not load")))
    document.head.append(script)
  })
  return loading
}

const dark = matchMedia("(prefers-color-scheme: dark)")
const themeNow = () => (dark.matches ? "vs-dark" : "vs")

// The editor ready to use: downloaded first if it is not yet (its progress
// shown), then loaded.
function useMonaco() {
  const [state, setState] = useState({ ready: !!window.monaco?.editor })
  useEffect(() => {
    if (state.ready) return
    let alive = true
    const step = async () => {
      const res = await get("/api/monaco")
      if (!alive) return
      if (res?.error) return setState({ error: res.error })
      if (!res?.ready) return (setState({ progress: res?.progress ?? 0 }), setTimeout(step, 700))
      try {
        await loadMonaco()
        if (alive) setState({ ready: true })
      } catch (err) {
        if (alive) setState({ error: err.message })
      }
    }
    step()
    return () => (alive = false)
  }, [])
  return state
}

// ---------- file icons ----------

// A file's type as a small coloured label, as VS Code's icon themes do: by
// its whole name first (package.json, Dockerfile…), then its extension.
const BY_NAME = [
  [/^package(-lock)?\.json$/, "npm", "#cb3837"],
  [/^tsconfig.*\.json$/, "TS", "#3178c6"],
  [/^(dockerfile|containerfile)$|\.dockerfile$|^docker-compose.*\.ya?ml$/i, "DK", "#2496ed"],
  [/^\.git(ignore|attributes|modules)$/, "GIT", "#f14e32"],
  [/^\.env(\..*)?$/, "ENV", "#c9a400"],
  [/^readme(\..*)?$/i, "i", "#519aba"],
  [/^(license|licence|copying)(\..*)?$/i, "©", "#c9a400"],
  [/^makefile$/i, "MK", "#6d8086"],
  [/\.lock$|^(bun\.lockb?|yarn\.lock|pnpm-lock\.yaml|uv\.lock|poetry\.lock|cargo\.lock)$/i, "lock", "#8a8a8a", "lock"],
]
const BY_EXT = {
  ts: ["TS", "#3178c6"], tsx: ["TSX", "#3178c6"], mts: ["TS", "#3178c6"], cts: ["TS", "#3178c6"],
  js: ["JS", "#c9a400"], jsx: ["JSX", "#c9a400"], mjs: ["JS", "#c9a400"], cjs: ["JS", "#c9a400"],
  py: ["PY", "#3572a5"], ipynb: ["NB", "#da5b0b"], rb: ["RB", "#cc342d"], php: ["PHP", "#777bb4"],
  go: ["GO", "#00add8"], rs: ["RS", "#c4772b"], java: ["J", "#b07219"], kt: ["KT", "#a97bff"], swift: ["SW", "#f05138"],
  c: ["C", "#6d8086"], h: ["H", "#6d8086"], cpp: ["C++", "#f34b7d"], hpp: ["H++", "#f34b7d"], cs: ["C#", "#178600"],
  json: ["{}", "#c9a400"], jsonc: ["{}", "#c9a400"], jsonl: ["{}", "#c9a400"],
  yml: ["YML", "#cb171e"], yaml: ["YML", "#cb171e"], toml: ["TML", "#9c4221"], ini: ["INI", "#6d8086"], xml: ["XML", "#e37933"],
  md: ["MD", "#519aba"], mdx: ["MDX", "#519aba"], txt: ["TXT", "#8a8a8a"], log: ["LOG", "#8a8a8a"], csv: ["CSV", "#21a366"], tsv: ["TSV", "#21a366"],
  html: ["<>", "#e34c26"], htm: ["<>", "#e34c26"], css: ["#", "#563d7c"], scss: ["#", "#c6538c"], less: ["#", "#1d365d"],
  vue: ["V", "#41b883"], svelte: ["S", "#ff3e00"], astro: ["A", "#ff5d01"], graphql: ["GQL", "#e10098"], gql: ["GQL", "#e10098"],
  sh: ["$", "#4eaa25"], zsh: ["$", "#4eaa25"], bash: ["$", "#4eaa25"], fish: ["$", "#4eaa25"], ps1: ["PS", "#012456"],
  sql: ["SQL", "#e38c00"], prisma: ["PR", "#5a67d8"], proto: ["PB", "#6d8086"], tf: ["TF", "#7b42bc"],
  svg: ["SVG", "#ffb13b"], pdf: ["PDF", "#d93831"],
}
const IMAGES = /^(png|jpe?g|gif|webp|avif|ico|bmp|icns)$/
const typeOf = path => {
  const name = nameOf(path)
  const hit = BY_NAME.find(([re]) => re.test(name))
  if (hit) return { label: hit[1], color: hit[2], icon: hit[3] }
  const ext = (name.match(/\.([^.]+)$/)?.[1] ?? "").toLowerCase()
  if (IMAGES.test(ext)) return { color: "#a074c4", icon: "image" }
  const [label, color] = BY_EXT[ext] ?? []
  return label ? { label, color } : { color: "var(--faint)", icon: "file" }
}

function FileIcon({ path }) {
  const t = typeOf(path)
  return t.icon ? html`<span class="ficon glyph" style=${`--c:${t.color}`}><${Icon} name=${t.icon} size=${13} /></span>`
    : html`<span class="ficon" style=${`--c:${t.color}`}>${t.label}</span>`
}

// ---------- the tree ----------

// Paths → folders and files, folders first.
function treeOf(files) {
  const root = { dirs: new Map(), files: [] }
  for (const path of files) {
    let node = root
    const parts = path.split("/")
    parts.slice(0, -1).forEach((part, i) => {
      if (!node.dirs.has(part)) node.dirs.set(part, { path: parts.slice(0, i + 1).join("/"), dirs: new Map(), files: [] })
      node = node.dirs.get(part)
    })
    node.files.push(path)
  }
  return root
}

const STATUS_TITLE = { M: "Modified", A: "Added", U: "New, not in git yet", R: "Renamed" }

function Folder({ node, depth, open, onToggle, status, changedDirs, active, onOpen }) {
  const dirs = [...node.dirs.entries()].sort(([a], [b]) => a.localeCompare(b))
  return html`${dirs.map(([name, dir]) => {
    const isOpen = open.has(dir.path)
    return html`<div key=${dir.path}>
      <button class="code-row dir" style=${`--depth:${depth}`} onClick=${() => onToggle(dir.path)} aria-expanded=${isOpen}>
        <${Icon} name="chevron" size=${12} class=${`code-chev ${isOpen ? "open" : ""}`} />
        <span class=${`ficon folder ${isOpen ? "open" : ""}`}><${Icon} name="folder" size=${14} /></span>
        <span class="code-name">${name}</span>${changedDirs.has(dir.path) && html`<i class="code-dot" title="Has changes"></i>`}
      </button>
      ${isOpen && html`<${Folder} node=${dir} depth=${depth + 1} open=${open} onToggle=${onToggle} status=${status} changedDirs=${changedDirs} active=${active} onOpen=${onOpen} />`}
    </div>`
  })}
  ${node.files.map(path => {
    const s = status[path]
    return html`<button key=${path} class=${`code-row file ${path === active ? "on" : ""} ${s ? `st-${s}` : ""}`} style=${`--depth:${depth}`}
      onClick=${() => onOpen(path)} title=${path}>
      <${FileIcon} path=${path} /><span class="code-name">${nameOf(path)}</span>${s && html`<span class="code-st" title=${STATUS_TITLE[s] ?? s}>${s}</span>`}
    </button>`
  })}`
}

// ---------- ⌘P ----------

// The files whose path holds the query's letters in order, the name first.
function ranked(files, query) {
  const q = query.toLowerCase().replace(/\s+/g, "")
  if (!q) return files.slice(0, 50)
  const out = []
  for (const path of files) {
    const p = path.toLowerCase()
    let i = 0
    for (const ch of p) if (ch === q[i]) i++
    if (i < q.length) continue
    const name = nameOf(p)
    out.push([path, (name.includes(q) ? 0 : p.includes(q) ? 1 : 2) * 1000 + path.length])
  }
  return out.sort((a, b) => a[1] - b[1]).slice(0, 50).map(([path]) => path)
}

function QuickOpen({ files, onPick, onClose }) {
  const [query, setQuery] = useState("")
  const [index, setIndex] = useState(0)
  const field = useRef()
  useEffect(() => field.current?.focus(), [])
  const list = useMemo(() => ranked(files, query), [files, query])
  const onKey = e => {
    if (e.key === "ArrowDown") (e.preventDefault(), setIndex(i => Math.min(i + 1, list.length - 1)))
    else if (e.key === "ArrowUp") (e.preventDefault(), setIndex(i => Math.max(i - 1, 0)))
    else if (e.key === "Enter") (e.preventDefault(), list[index] && onPick(list[index]))
    else if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), onClose())
  }
  return html`<div class="code-quick" onKeyDown=${onKey}>
    <input ref=${field} class="field" value=${query} placeholder="Go to file…" spellcheck="false"
      onInput=${e => (setQuery(e.target.value), setIndex(0))} onBlur=${() => setTimeout(onClose, 150)} />
    <div class="code-quick-list">
      ${list.map((path, i) => html`<button key=${path} class=${i === index ? "on" : ""} onPointerDown=${e => (e.preventDefault(), onPick(path))}>
        <${FileIcon} path=${path} /><span class="code-name">${nameOf(path)}</span><span class="code-dir">${dirOf(path)}</span></button>`)}
      ${list.length === 0 && html`<p class="muted">No file matches.</p>`}
    </div>
  </div>`
}

// ---------- the tab ----------

export function Code({ id }) {
  const ui = useContext(Ctx)
  const monaco = useMonaco()
  const [tree, setTree] = useState(null)
  const [openDirs, setOpenDirs] = useState(() => new Set())
  const [tabs, setTabs] = useState([]) // [{ path, dirty }]
  const [active, setActive] = useState(null)
  const [notice, setNotice] = useState(null) // { path, kind: "conflict" | "changed", mtime }
  const [isComparing, setComparing] = useState(false)
  const [isQuick, setQuick] = useState(false)
  const host = useRef()
  const editor = useRef(null)
  const diff = useRef(null)
  const docs = useRef(new Map()) // path → { model, mtime, saved (version id) }
  const latest = useRef({})
  latest.current = { active, tabs }

  const isGit = useRef(false)
  const loadTree = () => get(`/api/sessions/${id}/codetree`).then(res => res && ((isGit.current = !!res.isGit), setTree(res)))
  useEffect(() => {
    loadTree()
    const timer = setInterval(() => isGit.current && loadTree(), TREE_MS)
    return () => clearInterval(timer)
  }, [id])

  // The editor, once Monaco is here; the models go with the tab.
  useEffect(() => {
    if (!monaco.ready || !host.current) return
    const m = window.monaco
    editor.current = m.editor.create(host.current, {
      theme: themeNow(), automaticLayout: true, fontSize: 13, minimap: { enabled: true }, scrollBeyondLastLine: false, model: null,
    })
    editor.current.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyS, () => save())
    editor.current.addCommand(m.KeyMod.CtrlCmd | m.KeyCode.KeyP, () => setQuick(true))
    const onTheme = () => m.editor.setTheme(themeNow())
    dark.addEventListener("change", onTheme)
    return () => {
      dark.removeEventListener("change", onTheme)
      diff.current?.dispose()
      editor.current?.dispose()
      for (const doc of docs.current.values()) doc.model.dispose()
      docs.current.clear()
    }
  }, [monaco.ready])

  const isDirty = path => {
    const doc = docs.current.get(path)
    return !!doc && doc.model.getAlternativeVersionId() !== doc.saved
  }
  const markDirty = path => setTabs(ts => ts.map(t => (t.path === path ? { ...t, dirty: isDirty(path) } : t)))

  const open = async path => {
    setQuick(false)
    const m = window.monaco
    if (!m || !editor.current) return
    if (!docs.current.has(path)) {
      const res = await get(`/api/sessions/${id}/codefile?path=${encodeURIComponent(path)}`)
      if (!res || res.error) return ui.toast(res?.error ?? "Could not open it")
      if (res.binary || res.tooBig) return ui.toast(res.binary ? "A binary file: it does not open as text" : "Too big to open here")
      const uri = m.Uri.parse(`file:///${id}/${path}`)
      m.editor.getModel(uri)?.dispose() // left by a tab closed mid-load
      const model = m.editor.createModel(res.text, undefined, uri)
      docs.current.set(path, { model, mtime: res.mtime, saved: model.getAlternativeVersionId() })
      model.onDidChangeContent(() => markDirty(path))
      setTabs(ts => [...ts, { path, dirty: false }])
    }
    // Its folders open in the tree, so it shows there.
    setOpenDirs(dirs => new Set([...dirs, ...path.split("/").slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join("/"))]))
    endCompare()
    editor.current.setModel(docs.current.get(path).model)
    editor.current.focus()
    setActive(path)
    setNotice(n => (n?.path === path ? n : null))
  }

  const close = (path, e) => {
    e?.stopPropagation()
    if (isDirty(path) && !confirm(`${nameOf(path)} has changes you did not save. Close it anyway?`)) return
    const doc = docs.current.get(path)
    const rest = latest.current.tabs.filter(t => t.path !== path)
    setTabs(rest)
    if (latest.current.active === path) {
      const next = rest[rest.length - 1]?.path ?? null
      if (next) editor.current.setModel(docs.current.get(next).model)
      else editor.current.setModel(null)
      setActive(next)
    }
    doc?.model.dispose()
    docs.current.delete(path)
    if (notice?.path === path) setNotice(null)
  }

  const reload = async path => {
    const doc = docs.current.get(path)
    const res = await get(`/api/sessions/${id}/codefile?path=${encodeURIComponent(path)}`)
    if (!doc || !res || res.text === undefined) return
    const view = editor.current.saveViewState()
    doc.model.setValue(res.text)
    doc.mtime = res.mtime
    doc.saved = doc.model.getAlternativeVersionId()
    if (latest.current.active === path) editor.current.restoreViewState(view)
    markDirty(path)
    setNotice(null)
    endCompare()
  }

  const save = async (force = false) => {
    const path = latest.current.active
    const doc = path && docs.current.get(path)
    if (!doc) return
    const version = doc.model.getAlternativeVersionId()
    const res = await post(`/api/sessions/${id}/codesave`, { path, text: doc.model.getValue(), mtime: doc.mtime, force })
    if (res.body.conflict) return setNotice({ path, kind: "conflict", mtime: res.body.mtime })
    if (!res.body.ok) return ui.toast(res.body.error ?? "Could not save")
    doc.mtime = res.body.mtime
    doc.saved = version
    markDirty(path)
    setNotice(null)
    endCompare()
    loadTree()
  }

  // The disk's version beside yours, in Monaco's diff view.
  const compare = async path => {
    const m = window.monaco
    const res = await get(`/api/sessions/${id}/codefile?path=${encodeURIComponent(path)}`)
    if (!res || res.text === undefined) return
    endCompare()
    const original = m.editor.createModel(res.text, docs.current.get(path).model.getLanguageId())
    host.current.style.display = "none"
    const box = host.current.nextElementSibling
    box.style.display = ""
    diff.current = m.editor.createDiffEditor(box, { theme: themeNow(), automaticLayout: true, fontSize: 13, originalEditable: false })
    diff.current.setModel({ original, modified: docs.current.get(path).model })
    diff.current.original = original
    setComparing(true)
  }
  function endCompare() {
    if (!diff.current) return
    diff.current.original?.dispose()
    diff.current.dispose()
    diff.current = null
    host.current.style.display = ""
    host.current.nextElementSibling.style.display = "none"
    setComparing(false)
  }

  // The open file on disk: followed when you have not changed it, else told.
  useEffect(() => {
    if (!active) return
    const timer = setInterval(async () => {
      const doc = docs.current.get(active)
      const res = doc && (await get(`/api/sessions/${id}/codefile?path=${encodeURIComponent(active)}&time`))
      if (!res || res.mtime === undefined || res.mtime === doc.mtime) return
      if (!isDirty(active)) await reload(active)
      else setNotice(n => n ?? { path: active, kind: "changed", mtime: res.mtime })
    }, WATCH_MS)
    return () => clearInterval(timer)
  }, [active])

  const onKey = e => {
    if (!(e.metaKey || e.ctrlKey)) return
    if (e.key === "p") (e.preventDefault(), setQuick(true))
    else if (e.key === "s") (e.preventDefault(), save())
  }

  const root = useMemo(() => (tree ? treeOf(tree.files) : null), [tree?.files])
  const changedDirs = useMemo(() => {
    const out = new Set()
    for (const path of Object.keys(tree?.status ?? {})) path.split("/").slice(0, -1).forEach((_, i, parts) => out.add(parts.slice(0, i + 1).join("/")))
    return out
  }, [tree?.status])
  const toggle = path => setOpenDirs(dirs => {
    const next = new Set(dirs)
    next.has(path) ? next.delete(path) : next.add(path)
    return next
  })

  if (tree?.error) return html`<p class="muted pad">${tree.error}</p>`
  return html`<div class="code" onKeyDown=${onKey}>
    <aside class="code-tree" aria-label="Files">
      <header><b title=${tree?.root}>${tree?.name ?? "…"}</b>
        <button class="icon-btn" title="Go to file (⌘P)" onClick=${() => setQuick(true)}><${Icon} name="search" size=${13} /></button></header>
      <div class="code-rows">
        ${root ? html`<${Folder} node=${root} depth=${0} open=${openDirs} onToggle=${toggle} status=${tree.status} changedDirs=${changedDirs} active=${active} onOpen=${open} />`
          : html`<p class="muted pad">Reading the folder…</p>`}
        ${tree?.truncated && html`<p class="muted pad">Only the first ${tree.files.length} files show.</p>`}
      </div>
    </aside>
    <section class="code-main">
      <nav class="code-tabs">
        ${tabs.map(t => html`<button key=${t.path} class=${t.path === active ? "on" : ""} onClick=${() => open(t.path)} title=${t.path}>
          <${FileIcon} path=${t.path} /><span>${nameOf(t.path)}</span>${tree?.status[t.path] && html`<span class=${`code-st st-${tree.status[t.path]}`}>${tree.status[t.path]}</span>`}
          <span class="code-close" role="button" title=${t.dirty ? "Not saved (⌘S saves)" : "Close"} onClick=${e => close(t.path, e)}>
            ${t.dirty ? html`<i class="code-dirty"></i>` : html`<${Icon} name="x" size=${12} />`}</span>
        </button>`)}
      </nav>
      ${notice && html`<div class="code-notice">
        <span>${notice.kind === "conflict" ? `${nameOf(notice.path)} changed on disk after you opened it (Claude may have edited it). Saving now would undo that change.`
          : `${nameOf(notice.path)} changed on disk, and you have changes of your own.`}</span>
        <button class="btn" onClick=${() => reload(notice.path)}>Reload theirs</button>
        <button class="btn" onClick=${() => (isComparing ? endCompare() : compare(notice.path))}>${isComparing ? "Close compare" : "Compare"}</button>
        <button class="btn primary" onClick=${() => save(true)}>Keep mine</button>
      </div>`}
      <div class="code-editor">
        ${!monaco.ready && html`<div class="code-wait">${monaco.error ? html`<p>The editor could not load: ${monaco.error}</p>`
          : html`<p>${monaco.progress != null ? `Downloading the editor (VS Code's Monaco, once)… ${Math.round(monaco.progress * 100)}%` : "Loading the editor…"}</p>`}</div>`}
        ${monaco.ready && !active && html`<div class="code-wait"><p>Open a file from the tree, or press <kbd>⌘P</kbd>.</p></div>`}
        <div class="code-host" ref=${host}></div>
        <div class="code-host" style="display:none"></div>
      </div>
      ${isQuick && tree && html`<${QuickOpen} files=${tree.files} onPick=${open} onClose=${() => setQuick(false)} />`}
    </section>
  </div>`
}
