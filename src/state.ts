import type { usePlugin } from "@opencode/plugin/tui"
import { createEffect, createRoot, createSignal, onCleanup } from "solid-js"
import { FLASH_MS, LAUNCH_MS, TICK_MS, TWEEN_MS, easeOut, launchFrame } from "./anim.js"

type Context = ReturnType<typeof usePlugin>

export type Run = { start: number; end?: number }

export type DiffJumpTarget = "next-hunk" | "prev-hunk" | "top" | "bottom"

/** Diff page source: session tool-call edits, or the git working tree. */
export type DiffSource = "edits" | "git"

/** Which diff pane owns the movement keys. */
export type DiffFocus = "tree" | "patch"

/**
 * Focus-aware diff keys, routed by the deck's diffKey(): in "tree" focus
 * movement drives the cursor and open/close-parent work the tree; in "patch"
 * focus they scroll the patch (open/close-parent are no-ops there).
 */
export type DiffKey =
  | "up"
  | "down"
  | "open"
  | "space"
  | "close-parent"
  | "page-up"
  | "page-down"
  | "half-up"
  | "half-down"
  | "next-hunk"
  | "prev-hunk"
  | "top"
  | "bottom"

/** One flattened file-tree row, published by the diff view so diffKey can
 * resolve the row under the cursor without knowing the tree itself. */
export type DiffRowInfo = { path: string; dir: boolean; fileIndex: number }

export type PermRecord = {
  id: string
  sessionID: string
  action: string
  resources: string[]
  message?: string
  time: number
  reply?: "once" | "always" | "reject"
  pending: boolean
}

const PERM_HISTORY_LIMIT = 50

export function createDeck(context: Context) {
  return createRoot((dispose) => {
    // Ephemeral UI prefs: survive hot reloads, gone when the TUI exits.
    // (storage.store would persist to disk — this widget is read-only and stateless by design.)
    // lanes: undefined = auto (cards while they fit, lanes past that).
    const [ui, setUi] = context.storage.memory("opendeck", {
      initial: { collapsed: false, lanes: undefined as boolean | undefined, doneOpen: false },
    })
    const [tick, setTick] = createSignal(0)
    const [now, setNow] = createSignal(Date.now())
    const [runs, setRuns] = createSignal<Record<string, Run>>({})
    const [expandedMap, setExpandedMap] = createSignal<Record<string, boolean>>({})
    const [perms, setPerms] = createSignal<PermRecord[]>([])
    // Full-screen view (plugin route "opendeck"): open state + the root
    // session it was opened from, so close lands back where the user was.
    const [full, setFull] = createSignal(false)
    const [lastRoot, setLastRoot] = createSignal<string | undefined>(undefined)
    // Diff page (plugin route "opendeck-diff"): open flag + raw selected file
    // index (the view clamps it to the loaded list). No animations there, so
    // the diff page never needs the ticker.
    const [diffOpen, setDiffOpen] = createSignal(false)
    const [diffSel, setDiffSel] = createSignal(0)
    // Diff page view state, all raw — the view knows the row/list counts and
    // clamps the upper bounds (and snaps out-of-range values back). Scroll
    // resets on open and on every selection change (diffMove/diffSelect).
    const [diffView, setDiffView] = createSignal<"split" | "unified">("split")
    const [diffScroll, setDiffScrollRaw] = createSignal(0)
    const [diffListTop, setDiffListTopRaw] = createSignal(0)
    // Diff page file tree: source switch, collapsed dir paths, focus (tree ⇄
    // patch) and the cursor row in the flattened tree (raw — the view clamps
    // it to the rows). diffSel stays the selected file index in the list.
    const [diffSource, setDiffSourceRaw] = createSignal<DiffSource>("edits")
    const [diffCollapsed, setDiffCollapsed] = createSignal<ReadonlySet<string>>(new Set())
    const [diffFocus, setDiffFocus] = createSignal<DiffFocus>("tree")
    const [diffCursor, setDiffCursorRaw] = createSignal(0)
    // Bump to refetch the git working tree (the view keys its resource on it).
    const [diffGitTick, setDiffGitTick] = createSignal(0)
    // Flattened tree rows published by the diff view so diffKey can resolve
    // the row under the cursor without owning the tree.
    const [diffRows, setDiffRowsRaw] = createSignal<readonly DiffRowInfo[]>([])
    // Visible patch row count, published by the view so the keymap can scroll
    // by pages without knowing the layout.
    const [diffPage, setDiffPageRaw] = createSignal(1)
    // Jump requests: the keymap bumps seq, the view (which owns hunk row
    // indexes) consumes it and sets diffScroll.
    const [diffJumpReq, setDiffJumpReq] = createSignal<{ target: DiffJumpTarget; seq: number }>({
      target: "top",
      seq: 0,
    })
    // Bounce-back: root session to re-open the full view on, set when the
    // user dives into a subagent straight from the full view. The sidebar
    // shows a "back to Opendeck" link while this is armed.
    const [returnTo, setReturnTo] = createSignal<string | undefined>(undefined)

    const hydratedMessages = new Set<string>()
    const hydratedPerms = new Set<string>()

    // ONE shared frame clock for every animation in the widget (spinners,
    // clocks, lane flow, tween, flashes, pulses). It runs only while something
    // on screen is actually animating and stops fully when idle — no timers
    // anywhere else, and no per-component setInterval.
    let timer: ReturnType<typeof setInterval> | undefined
    const deadlines = new Map<string, number>() // short-lived animations: key -> expiry ms
    const flashes = new Map<string, number>() // row id -> highlight start ms
    const launches = new Map<string, number>() // subagent session id -> spawn ms

    /** Whether the host currently shows this plugin's full-view route. */
    function isFullRoute(): boolean {
      try {
        const route = context.ui.router.current()
        return route.type === "plugin" && route.name === "opendeck"
      } catch {
        return false
      }
    }

    /** Root session to show in the full view: the open session's root, else the freshest root. */
    function rootSessionID(): string | undefined {
      try {
        const route = context.ui.router.current()
        if (route.type === "session") {
          // A just-created session may not be in the data store yet; the
          // route's own id is always a valid destination regardless.
          let root = ""
          try {
            root = context.data.session.root(route.sessionID)
          } catch {
            // unknown session id — use it as-is
          }
          return root || route.sessionID
        }
      } catch {
        // fall through to the session list
      }
      try {
        const roots = (context.data.session.list() ?? []).filter((session) => !session.parentID)
        roots.sort((a, b) => b.time.updated - a.time.updated)
        return roots[0]?.id
      } catch {
        return undefined
      }
    }

    function keepAlive(): boolean {
      try {
        if (full()) return true
        if (ui.collapsed && !full()) return false
        if (deadlines.size > 0) return true
        if (perms().some((record) => record.pending)) return true
        const at = Date.now()
        for (const session of context.data.session.list() ?? []) {
          if (context.data.session.status(session.id) === "running") return true
          const run = runs()[session.id]
          // A child still inside the 30s settle window (no run end recorded yet)
          // needs the clock to advance so it can cross into "done".
          if (session.parentID && run?.end === undefined && at - session.time.created < 30_000) {
            return true
          }
          // A child that just ended stays in the sidebar's Active section for
          // ~30s; the ticker must keep running so it ages out on time.
          if (session.parentID && run?.end !== undefined && at - run.end < 30_000) {
            return true
          }
        }
        return false
      } catch {
        // host store hiccup → stop ticking rather than spin an error loop
        return false
      }
    }

    function stopTicker() {
      if (timer !== undefined) {
        clearInterval(timer)
        timer = undefined
      }
    }

    function onTick() {
      try {
        const at = Date.now()
        setNow(at)
        setTick((value) => value + 1)
        for (const [key, until] of deadlines) if (until <= at) deadlines.delete(key)
        for (const [id, start] of flashes) if (at - start > FLASH_MS) flashes.delete(id)
        for (const [id, start] of launches) if (at - start > LAUNCH_MS) launches.delete(id)
        // router.current() is not documented as reactive; resync while ticking so
        // navigating away from the full view by other UI still settles the flag.
        if (full() !== isFullRoute()) setFull(isFullRoute())
        if (!keepAlive()) stopTicker()
      } catch {
        // a failing tick must never throw into the host's interval callback
      }
    }

    function ensureTicker() {
      if (timer !== undefined) return
      setNow(Date.now())
      timer = setInterval(onTick, TICK_MS)
    }

    function addDeadline(key: string, ttlMs: number) {
      deadlines.set(key, Date.now() + ttlMs)
      ensureTicker()
    }

    /** Briefly highlight a row (new activity / new permission request). */
    function flash(id: string) {
      if (flashes.has(id)) return
      flashes.set(id, Date.now())
      addDeadline(`flash:${id}`, FLASH_MS)
    }

    // Context-bar tween: the bar glides toward the latest ratio instead of
    // jumping. One tween at a time — the sidebar shows one session.
    const [ctxTween, setCtxTween] = createSignal<{ from: number; to: number; start: number } | undefined>(
      undefined,
    )

    function tweenValue(tween: { from: number; to: number; start: number }, at: number): number {
      return tween.from + (tween.to - tween.from) * easeOut((at - tween.start) / TWEEN_MS)
    }

    // Permission gate: observe asked/replied events only. Never reply, never mutate.
    const offAsked = context.data.on("permission.asked", (event) => {
      const d = event.data
      const record: PermRecord = {
        id: d.id,
        sessionID: d.sessionID,
        action: d.action,
        resources: [...(d.resources ?? [])],
        time: event.created,
        pending: true,
      }
      if (d.message !== undefined) record.message = d.message
      setPerms((current) => [...current.slice(-(PERM_HISTORY_LIMIT - 1)), record])
      flash(record.id)
    })
    const offReplied = context.data.on("permission.replied", (event) => {
      const d = event.data
      setPerms((current) =>
        current.map((record) =>
          record.id === d.requestID ? { ...record, reply: d.reply, pending: false } : record,
        ),
      )
    })
    onCleanup(() => {
      cancelled = true
      popMode?.()
      popMode = undefined
      popDiffMode?.()
      popDiffMode = undefined
      stopTicker()
      offAsked()
      offReplied()
    })

    // While the full view is the current route, a dedicated keymap mode scopes
    // the esc/q/t layer to it; dialogs pushing their own mode on top win.
    let popMode: (() => void) | undefined
    createEffect(() => {
      if (full()) {
        if (!popMode) popMode = context.keymap.mode.push("opendeck")
      } else {
        popMode?.()
        popMode = undefined
      }
    })

    // Same scoping for the diff page: its esc/q/j/k layer only lives while the
    // diff route is current.
    let popDiffMode: (() => void) | undefined
    createEffect(() => {
      if (diffOpen()) {
        if (!popDiffMode) popDiffMode = context.keymap.mode.push("opendeck-diff")
      } else {
        popDiffMode?.()
        popDiffMode = undefined
      }
    })

    // Seed subagents that predate this TUI: they stay absent from the client
    // data store until something syncs them by id. Cancellable: a disposed
    // deck must not touch the data store after the plugin unloads.
    let cancelled = false
    void context.client.session
      .list({})
      .then((response) => {
        if (cancelled) return
        for (const session of response.data ?? []) {
          if (cancelled) return
          if (!session.parentID) continue
          if (context.data.session.get(session.id)) continue
          void context.data.session.sync(session.id).catch(() => {})
        }
      })
      .catch(() => {})

    // Follow the host route: keep the full-view flag honest (instant when the
    // router is reactive; the ticker's per-tick resync is the fallback) and
    // remember the last open root session so closeFullview() lands back there.
    // Bounce-back: opening a subagent straight from the full view arms
    // returnTo with its root session; once the user lands back on that root,
    // the full view re-opens itself (deck.returnPending feeds the sidebar).
    let prevRoute: ReturnType<typeof context.ui.router.current> | undefined
    // Set by deck.diveInto() just before the full view opens a subagent, so
    // host-initiated navigations (deep links, permission focus) never arm it.
    let diving = false
    createEffect(() => {
      let route: ReturnType<typeof context.ui.router.current> | undefined
      try {
        route = context.ui.router.current()
      } catch {
        return
      }
      const fromFullview =
        diving && prevRoute !== undefined && prevRoute.type === "plugin" && prevRoute.name === "opendeck"
      if (route.type !== "plugin") diving = false
      setFull(route.type === "plugin" && route.name === "opendeck")
      setDiffOpen(route.type === "plugin" && route.name === "opendeck-diff")
      if (route.type === "session") {
        let root = ""
        try {
          root = context.data.session.root(route.sessionID)
        } catch {
          // unknown session id — the route's own id is the fallback below
        }
        setLastRoot(root || route.sessionID)
        if (fromFullview && context.data.session.get(route.sessionID)?.parentID !== undefined) {
          // Dived into a subagent from the full view: arm the trip back to
          // the root (lastRoot already holds it), never to the child itself.
          const target = lastRoot() ?? root
          if (target && target !== route.sessionID) setReturnTo(target)
        }
        const pending = returnTo()
        if (pending !== undefined) {
          if (route.sessionID === pending) {
            // Back on the root: clear the trip FIRST so the re-open below
            // can never re-arm it (this is the loop guard), then navigate
            // out of band — never synchronously inside the effect.
            setReturnTo(undefined)
            queueMicrotask(() => {
              if (!cancelled) deck.openFullview()
            })
          } else {
            let belongs = false
            try {
              belongs = context.data.session.root(route.sessionID) === pending
            } catch {
              belongs = false
            }
            // Waiting only makes sense inside the pending root's family.
            if (!belongs) setReturnTo(undefined)
          }
        }
      } else if (route.type === "home") {
        if (returnTo() !== undefined) setReturnTo(undefined)
      }
      prevRoute = route
    })

    // Track run start/end per session so agent rows can show live elapsed time.
    // Also detects freshly spawned subagents for the fan-out launch animation.
    const seenSessions = new Set<string>()
    let sessionsPrimed = false
    createEffect(() => {
      const sessions = context.data.session.list() ?? []
      setNow(Date.now())
      for (const session of sessions) {
        const busy = context.data.session.status(session.id) === "running"
        if (busy) ensureTicker()
        if (!seenSessions.has(session.id)) {
          seenSessions.add(session.id)
          if (sessionsPrimed && session.parentID) {
            launches.set(session.id, Date.now())
            addDeadline(`launch:${session.id}`, LAUNCH_MS)
          }
        }
        setRuns((current) => {
          const run = current[session.id]
          if (busy && (!run || run.end !== undefined)) return { ...current, [session.id]: { start: Date.now() } }
          if (!busy && run && run.end === undefined) return { ...current, [session.id]: { ...run, end: Date.now() } }
          return current
        })
      }
      sessionsPrimed = true
    })

    function hydrateMessages(sessionID: string) {
      if (hydratedMessages.has(sessionID)) return
      hydratedMessages.add(sessionID)
      void context.data.session.message.sync(sessionID).catch(() => {})
    }

    function hydratePermissions(sessionID: string) {
      if (hydratedPerms.has(sessionID)) return
      hydratedPerms.add(sessionID)
      void context.data.session.permission.sync(sessionID).catch(() => {})
    }

    /** Current session plus every descendant (subagent) session id. */
    function familyIds(sessionID: string): string[] {
      try {
        return [...new Set([sessionID, ...context.data.session.family(sessionID)])]
      } catch {
        return [sessionID]
      }
    }

    const deck = {
      now,
      tick,
      run(sessionID: string) {
        return runs()[sessionID]
      },
      collapsed() {
        return ui.collapsed
      },
      toggleCollapsed() {
        setUi((draft) => {
          draft.collapsed = !draft.collapsed
        })
        // Expanding may reveal still-running work; collapsing freezes the clock.
        ensureTicker()
      },
      /**
       * Cards ⇄ swimlanes preference for the full view's Agents area.
       * undefined = auto (cards while they fit the width, lanes past that).
       */
      lanesPref() {
        return ui.lanes
      },
      setLanes(value: boolean | undefined) {
        setUi((draft) => {
          draft.lanes = value
        })
        ensureTicker()
      },
      /** Inactive-agents section: collapsed to one header line by default. */
      doneOpen() {
        return ui.doneOpen ?? false
      },
      toggleDone() {
        setUi((draft) => {
          draft.doneOpen = !(ui.doneOpen ?? false)
        })
      },
      /** Whether the full-screen Opendeck route is currently shown. */
      fullOpen: full,
      isFullRoute,
      /** Open a session from the full view; returning to its root re-opens the full view. */
      diveInto(sessionID: string) {
        diving = true
        try {
          context.ui.router.navigate({ type: "session", sessionID })
        } catch {
          diving = false
        }
      },
      /** True while a bounce-back to the full view is armed. */
      returnPending(): boolean {
        return returnTo() !== undefined
      },
      /** Session the full view renders: the one it was opened from, else current. */
      fullSessionID(): string | undefined {
        return lastRoot() ?? rootSessionID()
      },
      openFullview() {
        // From another plugin page (e.g. the diff view) keep the root being
        // viewed; from a session route follow that session's root.
        let onPlugin = false
        try {
          onPlugin = context.ui.router.current().type === "plugin"
        } catch {
          onPlugin = false
        }
        const id = (onPlugin ? lastRoot() : undefined) ?? rootSessionID()
        if (id) setLastRoot(id)
        // Any explicit open satisfies (or replaces) a pending bounce-back.
        setReturnTo(undefined)
        setFull(true)
        ensureTicker()
        try {
          context.ui.router.navigate({
            type: "plugin",
            name: "opendeck",
            ...(id ? { data: { sessionID: id } } : {}),
          })
        } catch {
          // host without plugin routes: stay put, sidebar keeps working
        }
      },
      closeFullview() {
        setFull(false)
        try {
          const id = lastRoot() ?? rootSessionID()
          if (id) context.ui.router.navigate({ type: "session", sessionID: id })
          else context.ui.router.navigate({ type: "home" })
        } catch {
          // nothing to navigate to
        }
      },
      /** Whether the diff route is currently shown. */
      diffOpen,
      /** Raw selected file index on the diff page; the view clamps to the list. */
      diffSel,
      setDiffSel,
      /** Move the diff file selection by delta; clamping happens in the view. */
      diffMove(delta: number) {
        setDiffSel((current) => current + delta)
        setDiffScrollRaw(0)
      },
      /** Select a diff file by absolute index (row click); resets patch scroll. */
      diffSelect(index: number) {
        setDiffSel(index)
        setDiffScrollRaw(0)
      },
      /** Diff page view mode: side-by-side (default) or unified. */
      diffView,
      setDiffView,
      /** Toggle the diff page between split and unified. */
      diffToggleView() {
        setDiffView((current) => (current === "split" ? "unified" : "split"))
      },
      /** Patch scroll offset in display rows; raw, the view clamps the max. */
      diffScroll,
      setDiffScroll(value: number) {
        setDiffScrollRaw(Math.max(0, Math.floor(value)))
      },
      /** Scroll the patch by delta rows (clamped at 0 here, at max in the view). */
      diffScrollBy(delta: number) {
        setDiffScrollRaw((current) => Math.max(0, current + delta))
      },
      /** First visible row index in the diff file tree; view clamps the max. */
      diffListTop,
      setDiffListTop(value: number) {
        setDiffListTopRaw(Math.max(0, Math.floor(value)))
      },
      /** Diff page source: session edits (default) or the git working tree. */
      diffSource,
      setDiffSource(source: DiffSource) {
        if (source === diffSource()) return
        setDiffSourceRaw(source)
        // The file list changes wholesale: reset selection/cursor/scrolls.
        // Collapsed dirs survive — paths mostly overlap between sources.
        setDiffSel(0)
        setDiffCursorRaw(0)
        setDiffScrollRaw(0)
        setDiffListTopRaw(0)
      },
      /** Collapsed directory paths on the diff page's file tree. */
      diffCollapsed,
      /** Toggle one directory's collapsed state by path. */
      diffToggleDir(path: string) {
        setDiffCollapsed((current) => {
          const next = new Set(current)
          if (next.has(path)) next.delete(path)
          else next.add(path)
          return next
        })
      },
      /** Which diff pane owns the movement keys (default: tree). */
      diffFocus,
      diffToggleFocus() {
        setDiffFocus((current) => (current === "tree" ? "patch" : "tree"))
      },
      /** Cursor row in the flattened file tree; raw, the view clamps the max. */
      diffCursor,
      setDiffCursor(value: number) {
        setDiffCursorRaw(Math.max(0, Math.floor(value)))
      },
      diffGitTick,
      /** Refetch the git working tree diff (no visible effect on "edits"). */
      diffRefreshGit() {
        setDiffGitTick((value) => value + 1)
      },
      /** The diff view publishes its flattened tree rows here for diffKey. */
      setDiffRows(rows: readonly DiffRowInfo[]) {
        setDiffRowsRaw(rows)
      },
      /**
       * Focus-aware key routing for the diff page: in "tree" focus movement
       * keys drive the cursor and open/close-parent work the tree; in "patch"
       * focus they scroll the patch. One entry point so the keymap binds a
       * single helper per key.
       */
      diffKey(key: DiffKey) {
        if (diffFocus() === "tree") {
          const rows = diffRows()
          if (rows.length === 0) return
          const cursor = Math.max(0, Math.min(rows.length - 1, diffCursor()))
          if (key === "down") {
            setDiffCursorRaw(cursor + 1) // raw; the view snaps overflow back
          } else if (key === "up") {
            setDiffCursorRaw(Math.max(0, cursor - 1))
          } else if (key === "open" || key === "space") {
            const row = rows[cursor]
            if (row === undefined) return
            if (row.dir) {
              deck.diffToggleDir(row.path)
            } else if (row.fileIndex >= 0) {
              deck.diffSelect(row.fileIndex)
              setDiffFocus("patch")
            }
          } else if (key === "close-parent") {
            const row = rows[cursor]
            if (row === undefined) return
            const slash = row.path.lastIndexOf("/")
            if (slash <= 0) return
            const parent = row.path.slice(0, slash)
            setDiffCollapsed((current) => new Set(current).add(parent))
          }
          return
        }
        // patch focus
        if (key === "down") deck.diffScrollBy(1)
        else if (key === "up") deck.diffScrollBy(-1)
        else if (key === "space" || key === "page-down") deck.diffScrollBy(deck.diffPage())
        else if (key === "page-up") deck.diffScrollBy(-deck.diffPage())
        else if (key === "half-down") deck.diffScrollBy(Math.max(1, Math.floor(deck.diffPage() / 2)))
        else if (key === "half-up") deck.diffScrollBy(-Math.max(1, Math.floor(deck.diffPage() / 2)))
        else if (key === "next-hunk") deck.diffJump("next-hunk")
        else if (key === "prev-hunk") deck.diffJump("prev-hunk")
        else if (key === "top") deck.diffJump("top")
        else if (key === "bottom") deck.diffJump("bottom")
      },
      /** Visible patch row count, published by the view for page scrolling. */
      diffPage,
      setDiffPage(value: number) {
        setDiffPageRaw(Math.max(1, Math.floor(value)))
      },
      /** Latest hunk/top/bottom jump request; consumed by the diff view. */
      diffJumpReq,
      /** Ask the diff view to scroll to a hunk/page boundary (it owns row indexes). */
      diffJump(target: DiffJumpTarget) {
        setDiffJumpReq((req) => ({ target, seq: req.seq + 1 }))
      },
      /** Open the files-changed diff page (given root session, else the last open root). */
      openDiff(file?: string, sessionID?: string) {
        const id = sessionID ?? lastRoot() ?? rootSessionID()
        if (id) setLastRoot(id)
        setDiffSel(0)
        setDiffScrollRaw(0)
        setDiffListTopRaw(0)
        setDiffCursorRaw(0)
        setDiffFocus("tree")
        setDiffSourceRaw("edits")
        setDiffCollapsed(new Set<string>())
        // diffOpen (and its keymap mode) follows the route effect, so the
        // "opendeck" and "opendeck-diff" modes are never pushed together.
        try {
          context.ui.router.navigate({
            type: "plugin",
            name: "opendeck-diff",
            data: { sessionID: id, file },
          })
        } catch {
          // host without plugin routes: stay put
        }
      },
      /** Back from the diff page to the Opendeck full view. */
      closeDiff() {
        setDiffOpen(false)
        deck.openFullview()
      },
      flash,
      /** 0 = not flashing; otherwise 1→0 fade progress (reactive via now()). */
      flashLevel(id: string): number {
        const start = flashes.get(id)
        if (start === undefined) return 0
        const progress = (now() - start) / FLASH_MS
        return progress >= 1 ? 0 : 1 - progress
      },
      /** Fan-out launch frame for a freshly spawned subagent, if still launching. */
      launchGlyph(sessionID: string): string | undefined {
        const start = launches.get(sessionID)
        if (start === undefined) return undefined
        const elapsed = now() - start
        if (elapsed >= LAUNCH_MS) return undefined
        return launchFrame(elapsed)
      },
      /** Target the context bar's tween at the latest measured ratio. */
      setCtxTarget(target: number | undefined) {
        const current = ctxTween()
        if (target === undefined) {
          if (current !== undefined) setCtxTween(undefined)
          return
        }
        if (current && Math.abs(current.to - target) < 0.0005) return
        const from = current ? tweenValue(current, Date.now()) : target
        setCtxTween({ from, to: target, start: Date.now() })
        if (Math.abs(from - target) > 0.0005) addDeadline("ctx-tween", TWEEN_MS)
      },
      /** The context bar's displayed (eased) ratio — reactive via now(). */
      ctxRatio(): number | undefined {
        const tween = ctxTween()
        return tween ? tweenValue(tween, now()) : undefined
      },
      expanded(sessionID: string) {
        return expandedMap()[sessionID] ?? false
      },
      toggleExpanded(sessionID: string) {
        const next = !(expandedMap()[sessionID] ?? false)
        setExpandedMap((current) => ({ ...current, [sessionID]: next }))
      },
      /** Subagent (child) sessions of the given session, oldest first. */
      children(sessionID: string) {
        return (context.data.session.list() ?? [])
          .filter((session) => session.parentID === sessionID)
          .sort((a, b) => a.time.created - b.time.created)
      },
      /** Total USD cost of the session family (current session + subagents). */
      totalCost(sessionID: string) {
        let total = 0
        for (const id of familyIds(sessionID)) {
          total += context.data.session.get(id)?.cost ?? 0
        }
        return total
      },
      familyIds,
      hydrateMessages,
      hydratePermissions,
      /** Permission history observed by this TUI instance for the session family. */
      permissionHistory(sessionID: string) {
        const family = new Set(familyIds(sessionID))
        return perms().filter((record) => family.has(record.sessionID))
      },
      /** Live pending requests from the host store for the session family. */
      pendingPermissions(sessionID: string) {
        const out: { id: string; sessionID: string; action: string; resources: string[] }[] = []
        for (const id of familyIds(sessionID)) {
          for (const request of context.data.session.permission.list(id) ?? []) {
            out.push({
              id: request.id,
              sessionID: request.sessionID,
              action: request.action,
              resources: [...request.resources],
            })
          }
        }
        return out
      },
      /** Model context-window limit in tokens, when the host knows the model. */
      modelLimit(model: { id: string; providerID?: string } | undefined): number | undefined {
        if (!model) return undefined
        let models
        try {
          models =
            context.data.location.model.list() ??
            (context.location ? context.data.location.model.list(context.location) : undefined) ??
            context.data.location.model.list(context.data.location.default())
        } catch {
          return undefined
        }
        const hit = (models ?? []).find(
          (info) =>
            (info.modelID === model.id || info.id === model.id) &&
            (!model.providerID || info.providerID === model.providerID),
        )
        return hit?.limit?.context
      },
    }

    return { deck, dispose }
  })
}

export type Deck = ReturnType<typeof createDeck>["deck"]
