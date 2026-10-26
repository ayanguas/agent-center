// Agent Center front end: state, live data, keyboard, and the layout.
import { html, render, useCallback, useEffect, useMemo, useRef, useState } from "../vendor/preact-htm.js"
import { Board, Inbox, SearchResults } from "./board.js"
import { Canvas } from "./canvas.js"
import { canvasOrder } from "./canvas-layout.js"
import { newNote } from "./canvas-notes.js"
import { Ctx, Kbd } from "./ctx.js"
import { Digest, Help, NewSession } from "./dialogs.js"
import { Setup } from "./setup.js"
import { Icon } from "./icons.js"
import { useFlip } from "./motion.js"
import { Reader } from "./reader.js"
import { RunDialog } from "./run.js"
import { Sidebar } from "./sidebar.js"
import { chime } from "./sound.js"
import { Toasts } from "./toasts.js"
import { COLUMNS, PARK_OPTIONS, clock, get, isTyping, keep, load, post } from "./util.js"

const OVERRIDE_MS = 6000

// Enter keeps its own job on these (press, pick, tick, unfold): it opens the
// selected conversation only from elsewhere.
const ENTER_KEEPS = "button, a[href], summary, [role=button], [role=option], [role=radio], [role=checkbox], [role=tab], [role=menuitem], [role=menuitemradio]"

// The order the keyboard walks: what the current view shows, top to bottom.
function walkOrder(view, cards, showDone, groupBy, repos) {
  if (view === "canvas") return canvasOrder(cards)
  const cols = COLUMNS.filter(c => c !== "done" || showDone)
  const pinnedFirst = list => [...list].sort((a, b) => Number(b.pinned) - Number(a.pinned))
  if (view === "board" && groupBy === "repo")
    return repos.flatMap(r => cols.flatMap(col => pinnedFirst(cards.filter(c => c.repoRoot === r.root && c.column === col))))
  if (view === "board") return cols.flatMap(col => pinnedFirst(cards.filter(c => c.column === col)))
  const pinned = cards.filter(c => c.pinned && c.column !== "done")
  return [
    ...pinned,
    ...COLUMNS.filter(c => c !== "done" || showDone).flatMap(col =>
      cards.filter(c => c.column === col && !(c.pinned && c.column !== "done")),
    ),
  ]
}

function App() {
  const [data, setData] = useState(null)
  const [connected, setConnected] = useState(false)
  const [lostAt, setLostAt] = useState(null) // when the live connection dropped
  // Notifications: "on", "off", or "blocked" (Chrome denied them).
  const permission = () => ("Notification" in window ? Notification.permission : "denied")
  const [notify, setNotifyRaw] = useState(() => (permission() === "denied" ? "blocked" : load("notify", "off")))
  // A chime when a session ends its turn or asks you something: "on" or "off".
  const [sound, setSoundRaw] = useState(() => load("sound", "off"))
  // First run, or a required step missing (the hook, the bridge mod): the
  // setup opens by itself, until closed once.
  useEffect(() => {
    get("/api/setup").then(res => res && !res.isReady && !load("setupSeen", false) && setDialog(d => d ?? "setup"))
  }, [])
  const [now, setNow] = useState(Date.now())
  const [chosenView, setViewRaw] = useState(load("view", "inbox"))
  const [repoFilter, setRepoFilterRaw] = useState(load("repoFilter", null))
  const [showDone, setShowDoneRaw] = useState(load("showDone", false))
  const [groupBy, setGroupByRaw] = useState(load("groupBy", "none"))
  const [selected, setSelected] = useState(null)
  const [reader, setReader] = useState(null) // { id, tab, file }
  // What the reader pane draws: the open reader, or the one closing, kept
  // until its slide-out ends.
  const [shown, setShown] = useState(null)
  const [parkMenu, setParkMenu] = useState(null)
  const [dragging, setDragging] = useState(null)
  const [query, setQuery] = useState("")
  const [results, setResults] = useState(null)
  const [toasts, setToasts] = useState([])
  const [dialog, setDialog] = useState(null) // "new" | "help" | "digest"
  const [runFor, setRunFor] = useState(null) // the card whose "Run" window is open
  const [isSideOpen, setSideOpen] = useState(false)
  const [isDrawingZone, setDrawingZone] = useState(false) // the next drag on the canvas draws a zone
  // The canvas needs room; on a phone the inbox stands in for it.
  const [isNarrow, setNarrow] = useState(() => matchMedia("(max-width: 860px)").matches)
  // The conversation panel's width: yours when you dragged its edge, wide
  // after the expand button, else the default. The same for every tab.
  const [readerW, setReaderWRaw] = useState(() => load("readerW", null))
  const [isWide, setWide] = useState(false)
  const [vw, setVw] = useState(window.innerWidth)
  useEffect(() => {
    const on = () => setVw(window.innerWidth)
    window.addEventListener("resize", on)
    return () => window.removeEventListener("resize", on)
  }, [])
  useEffect(() => {
    const mq = matchMedia("(max-width: 860px)")
    const on = () => setNarrow(mq.matches)
    mq.addEventListener("change", on)
    return () => mq.removeEventListener("change", on)
  }, [])
  // What the window shows: the canvas needs room, so a narrow one shows the
  // inbox instead (title, keyboard order and tools follow).
  const view = isNarrow && chosenView === "canvas" ? "inbox" : chosenView
  const [overrides, setOverrides] = useState({})
  const [taskSignal, setTaskSignal] = useState(0)
  const lastUndo = useRef(null)
  const settleTimer = useRef(null)
  const contentRef = useRef()
  const composerFocus = useRef(null)
  const searchBox = useRef()

  // Choosing a view (the sidebar, keys 1 2 3) also leaves a search.
  const setView = v => (setViewRaw(v), keep("view", v), setDrawingZone(false), setQuery(""))
  const setRepoFilter = r => (setRepoFilterRaw(r), keep("repoFilter", r), setSideOpen(false))
  const setShowDone = v => (setShowDoneRaw(v), keep("showDone", v))
  const setGroupBy = v => (setGroupByRaw(v), keep("groupBy", v))

  // ---------- live data ----------
  useEffect(() => {
    const source = new EventSource("/api/stream")
    source.onopen = () => (setConnected(true), setLostAt(null))
    source.onerror = () => (setConnected(false), setLostAt(t => t ?? Date.now()))
    source.onmessage = e => {
      setConnected(true)
      setLostAt(null)
      setData(JSON.parse(e.data))
      setTaskSignal(s => s + 1)
    }
    const tick = setInterval(() => setNow(Date.now()), 30_000)
    return () => (source.close(), clearInterval(tick))
  }, [])

  // The Dock icon counts the sessions that ask you something. A session that
  // starts asking while you look elsewhere raises a macOS notification; a
  // click on it opens that conversation (sw.js forwards the click here).
  // "Run" on the shell blocks shows only while Setup allows it.
  useEffect(() => void document.documentElement.classList.toggle("can-run", !!data?.canRunCommands), [data?.canRunCommands])

  const asked = useRef(null)
  const working = useRef(null)
  useEffect(() => {
    if (!data) return
    const asking = data.cards.filter(c => c.column === "asking")
    if (navigator.setAppBadge) (asking.length ? navigator.setAppBadge(asking.length) : navigator.clearAppBadge()).catch(() => {})
    const before = asked.current
    asked.current = new Set(asking.map(c => c.id))
    // The chime plays wherever you look, the board included: one per update,
    // the higher one when a session starts asking, else when a turn ends.
    const wasWorking = working.current
    working.current = new Set(data.cards.filter(c => c.column === "working").map(c => c.id))
    if (sound === "on" && before && wasWorking) {
      if (asking.some(c => !before.has(c.id))) chime("ask")
      else if ([...wasWorking].some(id => !working.current.has(id) && data.cards.some(c => c.id === id && c.column !== "archived"))) chime("done")
    }
    if (!before || notify !== "on" || permission() !== "granted" || document.hasFocus()) return
    for (const c of asking) {
      if (before.has(c.id)) continue
      showNotice(c.title, c.ask || (c.state === "permission" ? "Needs approval to continue" : "Asking you something"), c.id)
    }
  }, [data])

  // Through the service worker (its click opens the session); straight from
  // the page when there is none. Resolves to an error message, or null.
  const showNotice = async (title, body, id = "test") => {
    const options = { body, tag: id, data: { id: id === "test" ? null : id }, icon: "/icon-192.png", renotify: true }
    try {
      const reg = await Promise.race([navigator.serviceWorker?.ready, new Promise(r => setTimeout(r, 2000))])
      if (reg?.showNotification) await reg.showNotification(title, options)
      else new Notification(title, options)
      return null
    } catch (err) {
      console.warn("notification", err)
      return String(err?.message ?? err)
    }
  }

  useEffect(() => {
    const onMessage = e => e.data?.open && openReader(e.data.open)
    navigator.serviceWorker?.addEventListener("message", onMessage)
    // Opened from a notification while no window was open (?open=<session>),
    // or a link to a view or a dialog (?view=board, ?dialog=setup).
    const params = new URLSearchParams(location.search)
    const id = params.get("open")
    const linkedView = params.get("view")
    const linkedDialog = params.get("dialog")
    if (["inbox", "board", "canvas"].includes(linkedView)) setViewRaw(linkedView)
    if (["setup", "help", "new", "digest"].includes(linkedDialog)) setDialog(linkedDialog)
    if (id) openReader(id)
    if (id || linkedView || linkedDialog) history.replaceState(null, "", "/")
    return () => navigator.serviceWorker?.removeEventListener("message", onMessage)
  }, [])

  // Ends the running turn through the bridge mod, like Esc in the app.
  const stopSession = async card => {
    const res = await post(`/api/sessions/${card.id}/stop`)
    toast(res.body.ok ? `Stopping “${card.title}”…` : (res.body.error ?? "Could not stop"))
  }

  const toggleSound = () => {
    const next = sound === "on" ? "off" : "on"
    setSoundRaw(next)
    keep("sound", next)
    if (next === "on") chime("done") // what you will hear
    toast(next === "on" ? "Sound on: a chime when a session finishes or asks you something" : "Sound off")
  }

  const toggleNotify = async () => {
    if (notify === "on") return (setNotifyRaw("off"), keep("notify", "off"))
    if (!("Notification" in window)) return toast("This browser does not support notifications")
    const answer = permission() === "default" ? await Notification.requestPermission() : permission()
    if (answer !== "granted") return (setNotifyRaw("blocked"), toast("Chrome blocks notifications here: turn them on in the site settings"))
    setNotifyRaw("on")
    keep("notify", "on")
    // A first notice right away: proof that Chrome and macOS let it through.
    const error = await showNotice("Notifications on", "This is how a notification arrives when a session asks you something.")
    toast(error ? `Chrome could not show the notification: ${error}` : "Test notification sent. If you do not see it, check the macOS notification settings for this app")
  }

  // Optimistic changes stand until the server agrees, or a few seconds pass.
  useEffect(() => {
    if (!data) return
    setOverrides(o => {
      const left = {}
      for (const [id, ov] of Object.entries(o)) {
        const card = data.cards.find(c => c.id === id)
        const agrees = card && (ov.column === undefined || card.column === ov.column) && (ov.pinned === undefined || card.pinned === ov.pinned) &&
          (ov.isUnread === undefined || card.isUnread === ov.isUnread) && (ov.title === undefined || card.title === ov.title)
        if (!agrees && Date.now() - ov.at < OVERRIDE_MS) left[id] = ov
      }
      return left
    })
  }, [data])

  const cards = useMemo(() => {
    if (!data) return []
    return data.cards
      .map(c => (overrides[c.id] ? { ...c, ...overrides[c.id] } : c))
      .filter(c => !repoFilter || c.repoRoot === repoFilter)
  }, [data, overrides, repoFilter])

  useEffect(() => {
    if (data && repoFilter && !data.repos.some(r => r.root === repoFilter)) setRepoFilter(null)
  }, [data])

  const order = useMemo(
    () => (query ? (results ?? []).map(r => ({ id: r.id })) : walkOrder(view, cards, showDone, groupBy, data?.repos ?? [])),
    [query, results, view, cards, showDone, groupBy, data],
  )

  const wasOpen = useRef(false)
  useEffect(() => {
    if (reader) {
      setShown(reader)
      // Opening (not switching conversations): the content glides in with the pane.
      if (!wasOpen.current && !matchMedia("(prefers-reduced-motion: reduce)").matches)
        requestAnimationFrame(() =>
          document.querySelector(".reader-slot .reader")?.animate(
            [{ opacity: 0, transform: "translateX(28px)" }, { opacity: 1, transform: "none" }],
            { duration: 420, easing: "cubic-bezier(0.25, 1, 0.5, 1)" },
          ),
        )
      wasOpen.current = true
      return
    }
    wasOpen.current = false
    const timer = setTimeout(() => setShown(null), 440)
    return () => clearTimeout(timer)
  }, [reader])

  // Cards travel when they change place; one that leaves flies to where it
  // went: the "Done" button, a folded group, or fades if archived.
  useFlip(contentRef, `${view}|${isNarrow}|${groupBy}|${repoFilter}|${query}|${showDone}|${!!data}`, id => {
    // With what was just done here (archived, done…), ahead of the server.
    const card = cards.find(c => c.id === id) ?? data?.cards.find(c => c.id === id)
    return card ? card.column : null
  })

  // ---------- title and dock badge ----------
  useEffect(() => {
    const asking = (data?.cards ?? []).filter(c => c.column === "asking").length
    const unread = (data?.cards ?? []).filter(c => c.isUnread && c.column !== "done").length
    document.title = asking ? `(${asking}) Agent Center` : unread ? `• Agent Center` : "Agent Center"
    if (navigator.setAppBadge) (asking ? navigator.setAppBadge(asking) : navigator.clearAppBadge()).catch(() => {})
  }, [data])

  // ---------- search ----------
  useEffect(() => {
    if (!query.trim()) return setResults(null)
    setResults(null)
    let alive = true
    const timer = setTimeout(async () => {
      const res = await get(`/api/search?q=${encodeURIComponent(query.trim())}`)
      if (alive) setResults(res?.results ?? [])
    }, 220)
    return () => ((alive = false), clearTimeout(timer))
  }, [query])

  // ---------- actions ----------
  const dismissToast = id => setToasts(ts => ts.filter(t => t.id !== id))
  const toast = useCallback((text, undo) => {
    const id = Math.random().toString(36).slice(2)
    setToasts(ts => [...ts.slice(-2), { id, text, undo }])
    if (undo) lastUndo.current = () => (dismissToast(id), undo())
    setTimeout(() => dismissToast(id), undo ? 7000 : 3500)
  }, [])

  const OPTIMISTIC = {
    pin: () => ({ pinned: true }),
    unpin: () => ({ pinned: false }),
    park: p => ({ column: "parked", parkedUntil: p.until ?? null }),
    done: () => ({ column: "done", pinned: false }),
    archive: () => ({ column: "archived", pinned: false }),
    unseen: () => ({ column: "review", isUnread: true }),
  }
  const INVERSE = { pin: "unpin", unpin: "pin", park: "unpark", done: "undone", archive: "unarchive", unseen: "seen" }
  const MESSAGES = { done: "Marked as done", park: "Moved to Later", pin: "Pinned", unpin: "Unpinned", archive: "Archived", unseen: "Marked to review" }

  // Undo drops the optimistic change at once instead of waiting for it to expire.
  const forget = ids =>
    setOverrides(o => {
      const rest = { ...o }
      for (const id of ids) delete rest[id]
      return rest
    })

  // While an archived card falls (motion.js), the cards around it wait before
  // closing the gap: their move and their stacking change are held back.
  const holdForDrop = () => {
    const root = contentRef.current
    if (!root) return
    root.setAttribute("data-settling", "")
    clearTimeout(settleTimer.current)
    settleTimer.current = setTimeout(() => root.removeAttribute("data-settling"), 900)
  }

  const act = useCallback(async (card, action, payload = {}) => {
    // Keep the keyboard's place when the card leaves the list.
    if ((action === "done" && !showDone) || action === "park") {
      const i = order.findIndex(c => c.id === card.id)
      const next = order[i + 1] ?? order[i - 1]
      if (selected === card.id) setSelected(next?.id ?? null)
    }
    // Marked to review while open: what the open reader shows must not count as seen again.
    if (action === "unseen") keepUnread.current.add(card.id)
    const patch = OPTIMISTIC[action]?.(payload)
    if (action === "archive") holdForDrop()
    if (patch) setOverrides(o => ({ ...o, [card.id]: { ...patch, at: Date.now() } }))
    const res = await post(`/api/sessions/${card.id}/${action}`, payload)
    if (!res.body.ok) {
      forget([card.id])
      return toast(res.body.error ?? "Could not save")
    }
    const inverse = INVERSE[action]
    if (MESSAGES[action])
      toast(`${MESSAGES[action]}: ${card.title}`, inverse && (() => (forget([card.id]), post(`/api/sessions/${card.id}/${inverse}`))))
  }, [order, selected, showDone])

  const archiveAll = useCallback(async list => {
    const at = Date.now()
    holdForDrop()
    setOverrides(o => ({ ...o, ...Object.fromEntries(list.map(c => [c.id, { column: "archived", at }])) }))
    await Promise.all(list.map(c => post(`/api/sessions/${c.id}/archive`)))
    toast(`${list.length === 1 ? "1 session archived" : `${list.length} sessions archived`}`, () => {
      forget(list.map(c => c.id))
      return Promise.all(list.map(c => post(`/api/sessions/${c.id}/unarchive`)))
    })
  }, [])

  const launch = useCallback(async id => {
    const res = await post(`/api/sessions/${id}/open`)
    if (!res.body.ok) toast(res.body.error ?? "Could not open the session")
  }, [])

  const seenPosts = useRef({})
  const keepUnread = useRef(new Set()) // marked "to review" by hand: not seen until opened again
  const markSeen = id => {
    setOverrides(o => ({ ...o, [id]: { ...o[id], isUnread: false, at: Date.now() } }))
    if (Date.now() - (seenPosts.current[id] ?? 0) < 3000) return
    seenPosts.current[id] = Date.now()
    post(`/api/sessions/${id}/seen`)
  }

  // Every link opens in a new window (the links inside messages too), so the
  // board never navigates away from itself.
  useEffect(() => {
    const onClick = e => {
      const a = e.target.closest?.("a[href]")
      if (!a || e.defaultPrevented || a.getAttribute("href").startsWith("#") || a.hasAttribute("download")) return
      e.preventDefault()
      window.open(a.href, "_blank", "noopener,noreferrer")
    }
    document.addEventListener("click", onClick)
    return () => document.removeEventListener("click", onClick)
  }, [])
  // Opened with a click on a card: the cursor waits in the reply field, ready
  // to type. Not from the keyboard (the shortcuts would stop working) nor on a
  // phone (the keyboard would cover the conversation).
  const lastPointer = useRef(0)
  useEffect(() => {
    const onDown = () => (lastPointer.current = Date.now())
    addEventListener("pointerdown", onDown, true)
    return () => removeEventListener("pointerdown", onDown, true)
  }, [])
  const openReader = useCallback((id, tab = "chat") => {
    setSelected(id)
    setReader({ id, tab })
    setParkMenu(null)
    keepUnread.current.delete(id)
    markSeen(id)
    if (tab === "chat" && Date.now() - lastPointer.current < 1000 && !matchMedia("(max-width: 860px)").matches)
      setTimeout(() => composerFocus.current?.focus(), 120)
  }, [])

  // While a conversation is open, what arrives in it counts as seen.
  useEffect(() => {
    const card = reader && data?.cards.find(c => c.id === reader.id)
    if (card?.isUnread && !keepUnread.current.has(card.id)) markSeen(card.id)
  }, [reader?.id, data])

  // A reply Claude offered, or any text, delivered by the bridge mod. A reply
  // that ends asking for more ("…is: ") is a template: it goes to the reply
  // field to be completed, never sent as is.
  const reply = useCallback(async (card, text) => {
    if (/[:…]\s*$|\.\.\.\s*$/.test(text)) {
      setSelected(card.id)
      setReader({ id: card.id, tab: "chat" })
      setTimeout(() => composerFocus.current?.fill(text.trimEnd() + " "), 120)
      return
    }
    const res = await post(`/api/sessions/${card.id}/send`, { text })
    if (!res.body.ok) return toast(res.body.error ?? "Could not send")
    toast(res.body.isOpen ? `Replied: “${text.slice(0, 60)}”` : "Reply queued: it arrives when the session is free")
  }, [])

  const rename = useCallback(async (card, title) => {
    setOverrides(o => ({ ...o, [card.id]: { ...o[card.id], title: title || card.title, at: Date.now() } }))
    const res = await post(`/api/sessions/${card.id}/rename`, { title })
    if (!res.body.ok) toast(res.body.error ?? "Could not rename")
  }, [])

  // options: the first turn's mode, model and effort.
  const newSession = async (folder, prompt, send, options = {}) => {
    const res = await post("/api/new", { folder, prompt, send, ...options })
    if (!res.body.ok) {
      toast(res.body.error ?? "Could not create the session")
      return false
    }
    if (res.body.id) {
      toast("Session created: Claude is working")
      setTimeout(() => openReader(res.body.id), 600)
    } else toast("New session opened in Claude")
    return true
  }

  // A click on empty space closes the reader; a click on another session
  // switches it (the row's own handler), and controls keep working.
  useEffect(() => {
    if (!reader) return
    const KEEP = ".reader, .reader-resize, .card, .ccard, .note, .row, .menu, dialog, .toasts, button, a, input, textarea, select, label, .scrim"
    const onDown = e => {
      if (e.button !== 0 || e.target.closest(KEEP)) return
      setReader(null)
      setSelected(null) // closing the conversation lets go of its card too
    }
    document.addEventListener("pointerdown", onDown)
    return () => document.removeEventListener("pointerdown", onDown)
  }, [!!reader])

  // ---------- keyboard ----------
  // The handler is added once and reads the newest state from a ref, so two
  // keys pressed between renders both see what the first one did.
  const latest = useRef({})
  latest.current = { dialog, query, parkMenu, reader, selected, cards, order, act, launch, openReader }
  useEffect(() => {
    const onKey = e => {
      const { dialog, query, parkMenu, reader, selected, cards, order, act, launch, openReader } = latest.current
      if (dialog) return
      const typing = isTyping(e.target)
      const cmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k"
      // "?" arrives as Shift+/ on some layouts and drivers.
      if (!typing && (e.key === "?" || (e.code === "Slash" && e.shiftKey))) return (e.preventDefault(), setDialog("help"))
      if (cmdK || (e.key === "/" && !typing)) {
        e.preventDefault()
        searchBox.current?.focus()
        searchBox.current?.select()
        return
      }
      if (e.key === "Escape") {
        if (typing) {
          if (e.target === searchBox.current && query) setQuery("")
          e.target.blur()
        } else if (parkMenu) setParkMenu(latest.current.parkMenu = null)
        else if (query) setQuery((latest.current.query = ""))
        else if (reader) (setReader((latest.current.reader = null)), setSelected((latest.current.selected = null)))
        else setSelected((latest.current.selected = null))
        return
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return
      const card = cards.find(c => c.id === selected)
      if (parkMenu && card) {
        const option = PARK_OPTIONS.find(o => o.key === e.key)
        if (option) {
          e.preventDefault()
          setParkMenu(null)
          act(card, "park", { until: option.until() })
          return
        }
      }
      const move = step => {
        e.preventDefault()
        if (!order.length) return
        const i = order.findIndex(c => c.id === selected)
        const next = order[i === -1 ? (step > 0 ? 0 : order.length - 1) : Math.max(0, Math.min(order.length - 1, i + step))]
        setSelected((latest.current.selected = next.id))
        setParkMenu(null)
        if (reader) setReader(r => (latest.current.reader = { ...r, id: next.id }))
        // Focus on a card goes along, so Enter (or Space) there opens the selected one.
        const hasCardFocus = !!document.activeElement?.closest?.(".content [data-id]")
        requestAnimationFrame(() => {
          const el = document.querySelector(`[data-id="${next.id}"]`)
          if (hasCardFocus) el?.focus({ preventScroll: true })
          el?.scrollIntoView({ block: "nearest" })
        })
      }
      switch (e.key) {
        case "j": case "ArrowDown": return move(1)
        case "k": case "ArrowUp": return move(-1)
        case "Enter":
          if (selected && !e.defaultPrevented && !e.target.closest?.(ENTER_KEEPS)) (e.preventDefault(), openReader(selected))
          return
        case "o": if (selected) launch(selected); return
        case "t":
          if (!selected) return
          e.preventDefault()
          setReader(r => (r?.id === selected ? r : { id: selected, tab: "chat" }))
          setTimeout(() => window.dispatchEvent(new Event("agents:rename")), 50)
          return
        case "r":
          if (!selected) return
          e.preventDefault()
          setReader({ id: selected, tab: "chat" })
          setTimeout(() => composerFocus.current?.focus(), 50)
          return
        case "p": if (card) act(card, card.pinned ? "unpin" : "pin"); return
        case "a": if (card) card.column === "parked" ? act(card, "unpark") : card.column !== "done" && setParkMenu(m => (m ? null : card.id)); return
        case "e": if (card) act(card, card.column === "done" ? "undone" : "done"); return
        case "z": if (lastUndo.current) (lastUndo.current(), (lastUndo.current = null)); return
        case "g": return setGroupByRaw(g => (keep("groupBy", g === "repo" ? "none" : "repo"), g === "repo" ? "none" : "repo"))
        case "1": return setView("inbox")
        case "2": return setView("board")
        case "3": return setView("canvas")
        case "n": e.preventDefault(); return setDialog("new")
        case "d": e.preventDefault(); return setDialog("digest")
        case "s": if (card?.column === "working") stopSession(card); return
        case "u": if (card?.column === "pending") act(card, "unseen"); return
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  // ---------- the panel's width ----------
  const baseW = readerW ?? Math.min(760, Math.max(420, Math.round(vw * 0.42)))
  const wantsWide = isWide
  const readerWidth = Math.min(vw - 300, wantsWide ? Math.max(baseW, Math.round(vw * 0.75)) : baseW)
  const resizeReader = e => {
    e.preventDefault()
    const app = e.currentTarget.closest(".app")
    app.classList.add("resizing")
    const move = ev => {
      const w = Math.round(Math.min(window.innerWidth - 300, Math.max(380, window.innerWidth - ev.clientX)))
      app.style.setProperty("--reader-w", `${w}px`)
    }
    const up = ev => {
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      app.classList.remove("resizing")
      const w = Math.round(Math.min(window.innerWidth - 300, Math.max(380, window.innerWidth - ev.clientX)))
      setWide(false)
      setReaderWRaw(w)
      keep("readerW", w)
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
  }

  // ---------- layout ----------
  const ui = {
    now, selected, reader, parkMenu, dragging, taskSignal,
    setParkMenu, setDragging, setView, setRepoFilter, act, archiveAll, launch, openReader, toast, dismissToast, newSession,
    reply, rename,
    closeReader: () => (setReader(null), setSelected(null)),
    setReaderTab: tab => setReader(r => ({ ...r, tab })),
    // One of the open session's files, in its Files tab.
    showFile: file => setReader(r => r && { ...r, tab: "files", file }),
    openDialog: name => (setSideOpen(false), setDialog(name)),
    fillComposer: text => composerFocus.current?.fill(text),
    openRun: card => setRunFor(card),
    toggleWide: () => setWide(w => !w),
    stopSession,
    toggleNotify,
    toggleSound,
    registerComposer: fn => (composerFocus.current = fn),
  }
  const readerCard = shown && data?.cards.find(c => c.id === shown.id)
  const readerResult = shown && results?.find(r => r.id === shown.id)
  const repoName = repoFilter && data?.repos.find(r => r.root === repoFilter)?.name

  return html`<${Ctx.Provider} value=${ui}>
    <div class=${`app ${reader ? "with-reader" : ""} ${view === "canvas" && !query ? "on-canvas" : ""} ${isSideOpen ? "side-open" : ""} ${dragging ? "is-dragging" : ""}`}
      style=${`--reader-w:${readerWidth}px`}>
      ${data ? html`<${Sidebar} data=${data} repoFilter=${repoFilter} view=${view} connected=${connected} notify=${notify} sound=${sound} />`
        : html`<aside class="sidebar"><div class="brand"><span class="logo"><i></i><i></i><i></i></span>Agent Center</div></aside>`}
      <div class="scrim" onClick=${() => setSideOpen(false)}></div>
      <main class="main">
        <header class="topbar">
          <button class="icon-btn only-narrow" onClick=${() => setSideOpen(o => !o)} title="Menu"><${Icon} name="sidebar" /></button>
          <h1>${query ? "Search" : { board: "Board", canvas: "Canvas" }[view] ?? "Inbox"}${repoName && !query && html`<button class="crumb" onClick=${() => setRepoFilter(null)}
            title="You only see this repo. Click to see all">${repoName}<${Icon} name="x" size=${11} /></button>`}</h1>
          <label class="search">
            <${Icon} name="search" size=${15} />
            <input ref=${searchBox} type="search" placeholder="Search…" title="Search all conversations" value=${query}
              onInput=${e => setQuery(e.target.value)} />
            ${!query && html`<span class="search-keys"><${Kbd}>⌘K<//></span>`}
          </label>
          ${view === "board" && !query && html`<div class="segmented" role="group" aria-label="Group">
            <button class=${groupBy !== "repo" ? "on" : ""} onClick=${() => setGroupBy("none")} title="No grouping (G)">Columns</button>
            <button class=${groupBy === "repo" ? "on" : ""} onClick=${() => setGroupBy("repo")} title="Lanes per repo (G)">By repo</button>
          </div>`}
          ${view === "canvas" && !query && html`<button class=${`btn ${isDrawingZone ? "on" : ""}`} aria-pressed=${isDrawingZone}
            title="Draw a named zone on the canvas to group cards (Esc cancels)" onClick=${() => setDrawingZone(!isDrawingZone)}>
            <${Icon} name="plus" size=${14} /><span class="lbl">Zone</span></button>`}
          ${view === "canvas" && !query && html`<button class="btn" title="Add a note (or double-click the empty canvas)"
            onClick=${() => post("/api/canvas/notes", { notes: [...(data?.notes ?? []), newNote(data?.notes ?? [])] })}>
            <${Icon} name="plus" size=${14} /><span class="lbl">Note</span></button>`}
          ${view !== "canvas" && html`<button class=${`btn ${showDone ? "on" : ""}`} data-fly="done" onClick=${() => setShowDone(!showDone)} title="Show done sessions">Done</button>`}
          <button class="btn primary only-narrow" onClick=${() => setDialog("new")} title="New session (N)"><${Icon} name="plus" size=${15} /></button>
        </header>
        <${Offline} lostAt=${lostAt} hasData=${!!data} />
        <div class="content" ref=${contentRef}>
          ${!data
            ? html`<div class="skeleton-rows">${[1, 2, 3, 4, 5].map(i => html`<i key=${i}></i>`)}</div>`
            : query
              ? html`<${SearchResults} query=${query} results=${results} />`
              : view === "board"
                ? html`<${Board} cards=${cards} showDone=${showDone} groupBy=${groupBy} repos=${data.repos} />`
                : view === "canvas"
                  ? html`<${Canvas} cards=${cards} zones=${data.zones ?? []} notes=${data.notes ?? []}
                      isDrawingZone=${isDrawingZone} onZoneDrawn=${() => setDrawingZone(false)} />`
                  : html`<${Inbox} cards=${cards} showDone=${showDone} />`}
        </div>
      </main>
      <div class="reader-slot">
        ${shown && html`<div class="reader-resize" onPointerDown=${resizeReader} onDblClick=${() => (setReaderWRaw(null), keep("readerW", null))}
          title="Drag to change the width · double-click: default width"></div>`}
        ${shown && html`<${Reader} key=${shown.id} id=${shown.id} card=${readerCard} result=${readerResult} tab=${shown.tab} file=${shown.file} isWide=${wantsWide}
          hasTasks=${data?.features?.organizer !== false} />`}
      </div>
      <${Toasts} toasts=${toasts} />
      ${dialog === "new" && html`<${NewSession} initialRoot=${repoFilter} onClose=${() => setDialog(null)} />`}
      ${dialog === "help" && html`<${Help} onClose=${() => setDialog(null)} />`}
      ${dialog === "digest" && html`<${Digest} onClose=${() => setDialog(null)} />`}
      ${dialog === "setup" && html`<${Setup} notify=${notify} sound=${sound} onClose=${() => (keep("setupSeen", true), setDialog(null))} />`}
      ${runFor && html`<${RunDialog} card=${runFor} onClose=${() => setRunFor(null)} />`}
    </div>
  <//>`
}

// The server does not answer. A short drop (a restart) stays quiet; after a
// few seconds the page says so, and that what it shows may be old.
function Offline({ lostAt, hasData }) {
  const [, tick] = useState(0)
  useEffect(() => {
    if (!lostAt) return
    const timer = setInterval(() => tick(n => n + 1), 1000)
    return () => clearInterval(timer)
  }, [lostAt])
  if (!lostAt || Date.now() - lostAt < 4000) return null
  return html`<div class="banner offline" role="alert">
    <strong>The server is not responding${hasData ? ` since ${clock(lostAt)}` : ""}.</strong>
    ${hasData ? " What you see may be out of date." : ""} macOS restarts it on its own; the page retries every few seconds.
    If it stays down, check <code>~/organizer/agent-center/logs/server.log</code>.
  </div>`
}

render(html`<${App} />`, document.getElementById("app"))
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {})
