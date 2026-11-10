/** @jsxImportSource @opentui/solid */
// Full-screen diff view (plugin route "opendeck-diff"): a collapsible file
// tree on the left (▾/▸ dirs, status glyph, +adds -dels), the selected
// file's patch on the right — side-by-side before/after by default, `s`
// toggles unified. Source switch: session "edits" (tool-call patches, or the
// server snapshot as fallback) vs the "git" working tree (loadWorking).
// Focus model: tab swaps tree ⇄ patch; j/k/up/down move the tree cursor or
// scroll the patch, enter/l opens, h collapses the parent dir, pgup/pgdn and
// ctrl+d/u scroll, n/p jump between hunks (click a hunk header to jump to it),
// g/G top/bottom, 1/2/3 switch source (edits / git / log — the log is only
// reachable from here), r refreshes git, ? help, q/esc back to the full view.
// Borderless Grok-CLI style (ui.tsx).
// All view state lives on the deck so the keymap can drive it. No animations
// — this file creates no timers and never touches the ticker.

import type { FileDiffInfo } from "@opencode/client"
import { usePlugin } from "@opencode/plugin/tui"
import type { BoxRenderable, RGBA } from "@opentui/core"
import { createEffect, createMemo, createResource, createSignal, For, onMount, Show, untrack } from "solid-js"
import type { JSX } from "solid-js"
import { formatTokens, maskSecrets, truncate } from "./format.js"
import { buildTree, flattenTree, loadCommitFiles, loadWorking, type GitFileDiff, type TreeNode } from "./git.js"
import { diffFromTools, splitPatch, type SplitCell, type SplitRow } from "./metrics.js"
import { collectToolParts } from "./shared.js"
import type { Deck } from "./state.js"
import { KeyHints, Marker, Rule, ScrollList, TabBar, glyph } from "./ui.js"

/** One file entry regardless of source (session edits or git working tree). */
type DiffFile = {
  file: string
  patch: string
  additions: number
  deletions: number
  status: "added" | "deleted" | "modified"
  staged?: boolean
  untracked?: boolean
}

const STATUS_GLYPH: Record<DiffFile["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
}

function statusGlyph(status: string | undefined): string {
  if (status === "added" || status === "modified" || status === "deleted") return STATUS_GLYPH[status]
  return "?"
}

export function DiffView(props: { deck: Deck; sessionID?: string; file?: string }) {
  const context = usePlugin()
  const theme = () => context.theme
  const deck = props.deck

  // Same self-measure as the full view: plugin routes publish no width, so
  // fill the page area and measure our own root box (never force width from
  // terminalWidth — that clips narrow terms).
  let rootRef: BoxRenderable | undefined
  const [measured, setMeasured] = createSignal(0)
  onMount(() => setMeasured(rootRef?.width ?? context.renderer.terminalWidth ?? 120))
  const W = createMemo(() => Math.max(48, measured() || context.renderer.terminalWidth || 120))
  const H = createMemo(() => context.renderer.terminalHeight ?? 40)

  // --- source "edits": session tool patches, server snapshot as fallback ---
  // Local-first: the server-side session.diff snapshot can be empty even for
  // sessions that edited files, while completed edit/write tool parts carry
  // per-file patches in state.metadata.files. Derived across the whole session
  // family (main + subagents), reactive as messages stream in.
  createEffect(() => {
    const id = props.sessionID
    if (!id) return
    for (const fid of deck.familyIds(id)) deck.hydrateMessages(fid)
  })
  const local = createMemo((): FileDiffInfo[] => {
    const id = props.sessionID
    if (!id) return []
    return diffFromTools(collectToolParts(context, deck.familyIds(id)))
  })
  const useLocal = createMemo(() => local().length > 0)
  const [files] = createResource(
    () => props.sessionID,
    async (sessionID): Promise<FileDiffInfo[]> => {
      if (!sessionID) return []
      return await context.client.session.diff({ sessionID })
    },
  )
  const editsList = createMemo((): DiffFile[] => (useLocal() ? local() : (files() ?? [])))
  const editsReady = createMemo(() => useLocal() || (!files.loading && files() !== undefined))

  // --- source "git": the working tree via git.ts ---------------------------
  // Working directory: the session's own location, else the host's current.
  const cwd = createMemo((): string | undefined => {
    const id = props.sessionID
    if (id) {
      try {
        const dir = context.data.session.get(id)?.location?.directory
        if (typeof dir === "string" && dir !== "") return dir
      } catch {
        // host store hiccup — fall through to the ambient location
      }
    }
    try {
      const dir = context.location?.directory
      if (typeof dir === "string" && dir !== "") return dir
    } catch {
      // no directory at all
    }
    return undefined
  })
  // Refetches on (session, source toggle, manual refresh tick); inert while
  // the "edits" source is active.
  const [gitRes] = createResource(
    () => ({ cwd: cwd(), active: deck.diffSource() === "git", tick: deck.diffGitTick() }),
    async (key): Promise<{ files?: GitFileDiff[]; error?: string }> => {
      if (!key.active) return {}
      if (!key.cwd) return { error: "no working directory" }
      const result = await loadWorking(key.cwd)
      return typeof result === "string" ? { error: result } : { files: result }
    },
  )
  // Source "commit": one commit's files (opened from the git log page).
  const [commitRes] = createResource(
    () => ({ cwd: cwd(), hash: deck.diffSource() === "commit" ? deck.diffCommit() : undefined }),
    async (key): Promise<{ files?: GitFileDiff[]; error?: string }> => {
      if (!key.hash) return {}
      if (!key.cwd) return { error: "no working directory" }
      const result = await loadCommitFiles(key.cwd, key.hash)
      return typeof result === "string" ? { error: result } : { files: result }
    },
  )
  const gitFiles = createMemo(() => (deck.diffSource() === "commit" ? commitRes()?.files : gitRes()?.files))
  const gitError = createMemo(() => (deck.diffSource() === "commit" ? commitRes()?.error : gitRes()?.error))
  // Loading only when no usable result yet — a refetch (r) keeps showing the
  // previous file list instead of flashing a loading line.
  const gitLoading = createMemo(() => {
    if (deck.diffSource() === "edits") return false
    const commit = deck.diffSource() === "commit"
    const res = commit ? commitRes() : gitRes()
    if (res !== undefined && (res.files !== undefined || res.error !== undefined)) return false
    return commit ? commitRes.loading : gitRes.loading
  })

  const source = () => deck.diffSource()
  const list = createMemo((): DiffFile[] => (source() === "edits" ? editsList() : (gitFiles() ?? [])))

  const errorMessage = () => {
    const err = files.error as { message?: unknown }
    return truncate(maskSecrets(String(err?.message ?? files.error)), 80)
  }

  // One-line body status replacing the panes (loading / error / empty), or
  // undefined when the panes should render.
  const statusLine = createMemo((): { text: string; color: RGBA } | undefined => {
    const text = theme().text
    if (source() !== "edits") {
      if (gitLoading()) return { text: "git: loading…", color: text.muted }
      const error = gitError()
      if (error !== undefined) return { text: `git: ${truncate(maskSecrets(error), 80)}`, color: text.muted }
      if (list().length === 0) {
        return { text: source() === "commit" ? "no files in this commit" : "working tree clean", color: text.muted }
      }
      return undefined
    }
    if (!useLocal() && files.error) {
      return { text: `diff unavailable: ${errorMessage()}`, color: text.feedback.error.base }
    }
    if (!editsReady()) return { text: "loading diff…", color: text.muted }
    if (list().length === 0) return { text: "no file changes in this session", color: text.muted }
    return undefined
  })
  const countsShown = createMemo(() => {
    if (source() !== "edits") return !gitLoading() && gitError() === undefined
    return editsReady() && (useLocal() || !files.error)
  })

  // Selection lives on the deck (keymap + row clicks write the raw index);
  // it is clamped to the loaded list here.
  const sel = createMemo(() => Math.max(0, Math.min(list().length - 1, deck.diffSel())))
  const selected = createMemo(() => list()[sel()])

  const fileIndexByPath = createMemo(() => {
    const map = new Map<string, number>()
    list().forEach((file, index) => map.set(file.file, index))
    return map
  })

  // Directory tree of the active list; the deck's collapsed set hides
  // children. The flattened rows are published back to the deck so diffKey
  // can resolve the row under the cursor.
  // untracked files (git source) get their own "?" glyph instead of "A"
  const tree = createMemo(() =>
    buildTree(list().map((file) => (file.untracked ? { ...file, status: "untracked" } : file))),
  )
  const flat = createMemo(() => flattenTree(tree(), deck.diffCollapsed()))
  createEffect(() => {
    const indexByPath = fileIndexByPath()
    deck.setDiffRows(
      flat().map((node) => ({
        path: node.path,
        dir: node.dir,
        fileIndex: node.dir ? -1 : (indexByPath.get(node.path) ?? -1),
      })),
    )
  })

  // Tree cursor: raw on the deck, clamped to the flattened rows here.
  const cursor = createMemo(() => Math.max(0, Math.min(flat().length - 1, deck.diffCursor())))
  createEffect(() => {
    const clamped = cursor()
    if (clamped !== deck.diffCursor()) deck.setDiffCursor(clamped)
  })

  // First load per session: jump to the requested file when one was given.
  let initialisedFor: string | undefined
  createEffect(() => {
    if (statusLine() !== undefined) return
    const sid = `${props.sessionID ?? ""}:${source()}`
    if (initialisedFor === sid) return
    if (!props.file) {
      initialisedFor = sid
      return
    }
    // keep trying while the family's edit parts are still hydrating
    const index = list().findIndex((file) => file.file === props.file)
    if (index >= 0) {
      deck.diffSelect(index)
      const rowIndex = flat().findIndex((node) => !node.dir && node.path === props.file)
      if (rowIndex >= 0) deck.setDiffCursor(rowIndex)
      initialisedFor = sid
    }
  })

  const totals = createMemo(() => {
    let additions = 0
    let deletions = 0
    for (const file of list()) {
      additions += file.additions
      deletions += file.deletions
    }
    return { additions, deletions }
  })

  // Layout: both panes are exactly paneH tall so they bottom-align, and the
  // │ separator spans the same height. Header (2) + margin (1) + panes +
  // key hints (1) + slack (1).
  const paneH = createMemo(() => Math.max(1, H() - 5))
  const listW = createMemo(() => Math.min(48, Math.max(28, Math.floor((W() * 32) / 100))))
  // tree column + 1-char │ separator column + two 1-char gaps.
  const rightW = createMemo(() => Math.max(8, W() - listW() - 3))
  const listH = createMemo(() => Math.max(1, paneH() - 1)) // minus the "files" title row

  // Split rows for the selected file. The patch is secret-masked once per
  // file (this memo recomputes only when the selected file object changes),
  // never per render.
  const split = createMemo((): { rows: SplitRow[]; hunks: number[] } => {
    const file = selected()
    if (!file) return { rows: [], hunks: [] }
    return splitPatch(maskSecrets(file.patch))
  })

  // Display rows per view mode. Split mode drops "Index:"/"===" noise and
  // folds each `--- a/x` + `+++ b/y` header pair into one faint `a/x → b/y`
  // row. Unified mode re-expands paired del/add rows into separate -/+ lines.
  // Hunk row indexes are rebuilt for the display array so jump targets stay
  // correct after filtering/expansion.
  const display = createMemo((): { rows: SplitRow[]; hunks: number[] } => {
    const { rows } = split()
    const mode = deck.diffView()
    const out: SplitRow[] = []
    const hunks: number[] = []
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!
      if (row.type === "hunk") {
        hunks.push(out.length)
        out.push(row)
        continue
      }
      if (row.type === "file") {
        if (mode === "split") {
          const next = rows[i + 1]
          if (row.text.startsWith("--- ") && next?.type === "file" && next.text.startsWith("+++ ")) {
            out.push({ type: "file", text: `${row.text.slice(4)} → ${next.text.slice(4)}` })
            i++
          }
          continue
        }
        out.push(row)
        continue
      }
      // line row: a del/add pair is one split row but two unified lines
      if (mode === "unified" && !(row.left?.kind === "ctx" && row.right?.kind === "ctx")) {
        if (row.left) out.push({ type: "line", left: row.left, right: undefined })
        if (row.right) out.push({ type: "line", left: undefined, right: row.right })
        continue
      }
      // fresh object per mode: For keys rows by reference, so a reused row
      // would keep the previous mode's layout after `s`
      out.push(mode === "unified" ? { ...row } : row)
    }
    return { rows: out, hunks }
  })

  // Patch pane height: paneH minus the footer row when there is one.
  const patchH = createMemo(() => Math.max(1, paneH() - (display().rows.length > 0 ? 1 : 0)))
  // ScrollList shows its bar exactly when the items overflow; mirror that to
  // know the content width for row truncation.
  const patchBar = createMemo(() => display().rows.length > patchH())
  const patchW = createMemo(() => rightW() - (patchBar() ? 1 : 0))

  // Publish the visible page size so the keymap scrolls by real pages.
  createEffect(() => {
    deck.setDiffPage(patchH())
  })

  // Scroll offset: the deck stores it raw (clamped ≥ 0 there), the view
  // clamps the upper bound and snaps the stored value back when the content
  // or terminal shrinks — guarded writes only, so this can never loop.
  const maxScroll = createMemo(() => Math.max(0, display().rows.length - patchH()))
  const scroll = createMemo(() => Math.min(Math.max(0, deck.diffScroll()), maxScroll()))
  createEffect(() => {
    const clamped = scroll()
    if (clamped !== deck.diffScroll()) deck.setDiffScroll(clamped)
  })

  // Hunk/top/bottom jump requests from the keymap (or future callers): seq
  // is the only trigger; display()/scroll() changes alone never re-jump.
  let lastJumpSeq = untrack(() => deck.diffJumpReq().seq)
  createEffect(() => {
    const req = deck.diffJumpReq()
    if (req.seq === lastJumpSeq) return
    lastJumpSeq = req.seq
    const hunks = display().hunks
    const max = maxScroll()
    const at = scroll()
    let target: number | undefined
    if (req.target === "top") target = 0
    else if (req.target === "bottom") target = max
    else if (req.target === "next-hunk") target = hunks.find((h) => h > at)
    else target = hunks.filter((h) => h < at).pop()
    if (target !== undefined) deck.setDiffScroll(Math.min(target, max))
  })

  // Tree window: first visible row lives on the deck (ScrollList's wheel
  // writes it), clamped here. The cursor is kept visible by nudging the
  // window only when it moves outside — never otherwise, so the effect can't
  // fight manual wheel scrolling.
  const maxListTop = createMemo(() => Math.max(0, flat().length - listH()))
  const listTop = createMemo(() => Math.min(Math.max(0, deck.diffListTop()), maxListTop()))
  createEffect(() => {
    const count = flat().length
    if (count === 0) {
      if (untrack(() => deck.diffListTop()) !== 0) deck.setDiffListTop(0)
      return
    }
    const c = cursor()
    const span = listH()
    let next = untrack(() => listTop())
    if (c < next) next = c
    else if (c >= next + span) next = c - span + 1
    next = Math.max(0, Math.min(maxListTop(), next))
    if (next !== untrack(() => deck.diffListTop())) deck.setDiffListTop(next)
  })

  // Untracked working-tree files have no patch yet.
  const untrackedEmpty = createMemo(() => {
    const file = selected()
    return file !== undefined && file.untracked === true && display().rows.length === 0
  })

  // Footer under the patch: visible range + which hunk the window starts in.
  const footer = createMemo(() => {
    const total = display().rows.length
    if (total === 0) return ""
    const from = scroll() + 1
    const to = Math.min(total, scroll() + patchH())
    const hunks = display().hunks
    if (hunks.length === 0) return `rows ${from}–${to} of ${total}`
    const current = hunks.filter((h) => h <= scroll()).length
    const label = current === 0 ? "–" : String(Math.min(current, hunks.length))
    return `rows ${from}–${to} of ${total} · hunk ${label}/${hunks.length}`
  })

  // The │ separator spans the pane height exactly.
  const separatorRows = createMemo(() => Array.from({ length: paneH() }, (_, index) => index))

  // Split halves: equal width with a faint │ between. Gutter is 4-wide
  // right-aligned plus one space inside each half.
  const halfW = createMemo(() => Math.max(12, Math.floor((patchW() - 1) / 2)))
  const halfTextW = createMemo(() => Math.max(1, halfW() - 5))

  function gutter(cell: SplitCell): string {
    return cell === undefined ? "    " : String(cell.no).padStart(4)
  }

  function cellColor(cell: SplitCell): RGBA {
    const text = theme().text
    if (cell === undefined) return text.faint
    if (cell.kind === "del") return text.feedback.error.base
    if (cell.kind === "add") return text.feedback.success.base
    return text.muted
  }

  // Unified line rows: ` ` context, `-` old-only, `+` new-only.
  function unifiedPrefix(row: Extract<SplitRow, { type: "line" }>): string {
    if (row.left && row.right) return " "
    return row.left ? "-" : "+"
  }

  function unifiedColor(row: Extract<SplitRow, { type: "line" }>): RGBA {
    const text = theme().text
    if (row.left && row.right) return text.muted
    if (row.left) return text.feedback.error.base
    return text.feedback.success.base
  }

  function glyphColor(status: string | undefined): RGBA {
    const text = theme().text
    if (status === "added") return text.feedback.success.base
    if (status === "deleted") return text.feedback.error.base
    if (status === "modified") return text.feedback.warning.base
    return text.muted
  }

  /** `+a -d` split into pad/adds/dels so the pair fills a fixed 9-char slot. */
  function countParts(additions: number, deletions: number): { pad: string; adds: string; dels: string } {
    let adds = `+${additions}`
    let dels = ` -${deletions}`
    if (adds.length + dels.length > 9) {
      adds = `+${formatTokens(additions)}`
      dels = ` -${formatTokens(deletions)}`
    }
    const total = adds.length + dels.length
    if (total > 9) return { pad: "", adds: truncate(adds, Math.max(1, 9 - dels.length)), dels }
    return { pad: " ".repeat(Math.max(0, 9 - total)), adds, dels }
  }

  // One flattened tree row at exactly the pane width: ▌cursor | indent +
  // ▾/▸ dir or status-glyph file (● when staged) + name | right-aligned
  // +a -d in a fixed 9-char slot so the numbers line up vertically.
  function renderTreeRow(node: TreeNode, index: number): JSX.Element {
    const w = listW()
    const mainW = Math.max(1, w - 10) // marker col + 9-char counts slot
    const onCursor = index === cursor()
    const marker = onCursor ? (
      <Marker color={deck.diffFocus() === "tree" ? theme().hue.accent[200] : theme().text.faint} />
    ) : (
      <text wrapMode="none" fg={theme().text.faint}>
        {" "}
      </text>
    )
    const parts = countParts(node.additions, node.deletions)
    const indent = "  ".repeat(Math.min(Math.max(0, node.depth), 10))
    if (node.dir) {
      const open = !deck.diffCollapsed().has(node.path)
      const label = truncate(`${indent}${open ? "▾" : "▸"} ${node.name}/`, mainW)
      const pad = " ".repeat(Math.max(0, mainW - label.length))
      return (
        <box
          flexDirection="row"
          width={w}
          onMouseDown={() => {
            deck.setDiffCursor(index)
            deck.diffToggleDir(node.path)
          }}
        >
          {marker}
          <text wrapMode="none" fg={theme().text.faint}>{`${label}${pad}`}</text>
          <text wrapMode="none" fg={theme().text.faint}>{`${parts.pad}${parts.adds}${parts.dels}`}</text>
        </box>
      )
    }
    const fileIndex = fileIndexByPath().get(node.path) ?? -1
    const staged = fileIndex >= 0 && list()[fileIndex]?.staged === true
    const isSel = fileIndex >= 0 && fileIndex === sel()
    const head = `${indent}${statusGlyph(node.status)}`
    const nameW = Math.max(1, mainW - head.length - (staged ? 1 : 0) - 1)
    const name = truncate(node.name, nameW)
    const pad = " ".repeat(Math.max(0, mainW - head.length - (staged ? 1 : 0) - 1 - name.length))
    return (
      <box
        flexDirection="row"
        width={w}
        onMouseDown={() => {
          deck.setDiffCursor(index)
          if (fileIndex >= 0) deck.diffSelect(fileIndex)
        }}
      >
        {marker}
        <text wrapMode="none" fg={glyphColor(node.status)}>{head}</text>
        <Show when={staged}>
          <text wrapMode="none" fg={theme().text.faint}>
            ●
          </text>
        </Show>
        <text wrapMode="none" fg={isSel ? theme().text.base : theme().text.muted}>{` ${name}${pad}`}</text>
        <text wrapMode="none" fg={theme().text.faint}>
          {parts.pad}
        </text>
        <text wrapMode="none" fg={theme().text.feedback.success.base}>
          {parts.adds}
        </text>
        <text wrapMode="none" fg={theme().text.feedback.error.base}>
          {parts.dels}
        </text>
      </box>
    )
  }

  function renderPatchRow(row: SplitRow, index: number): JSX.Element {
    if (row.type === "hunk") {
      return (
        <box flexDirection="row" onMouseDown={() => deck.setDiffScroll(index)}>
          <text wrapMode="none" fg={theme().hue.accent[200]}>
            {truncate(row.text, patchW())}
          </text>
        </box>
      )
    }
    if (row.type === "file") {
      return (
        <text wrapMode="none" fg={theme().text.faint}>
          {truncate(row.text, patchW())}
        </text>
      )
    }
    if (deck.diffView() === "unified") {
      const cell = row.left ?? row.right
      return (
        <box flexDirection="row" width={patchW()}>
          <text wrapMode="none" flexShrink={0} fg={theme().text.faint}>
            {`${gutter(row.left)} ${gutter(row.right)} `}
          </text>
          <text wrapMode="none" fg={unifiedColor(row)}>
            {truncate(`${unifiedPrefix(row)}${cell?.text ?? ""}`, Math.max(8, patchW() - 11))}
          </text>
        </box>
      )
    }
    return (
      <box flexDirection="row" width={patchW()}>
        <box flexDirection="row" width={halfW()} flexShrink={0} overflow="hidden">
          <text wrapMode="none" fg={theme().text.faint}>
            {`${gutter(row.left)} `}
          </text>
          <text wrapMode="none" fg={cellColor(row.left)}>
            {truncate(row.left?.text ?? "", halfTextW())}
          </text>
        </box>
        <text wrapMode="none" flexShrink={0} fg={theme().text.faint}>
          │
        </text>
        <box flexDirection="row" width={halfW()} flexShrink={0} overflow="hidden">
          <text wrapMode="none" fg={theme().text.faint}>
            {`${gutter(row.right)} `}
          </text>
          <text wrapMode="none" fg={cellColor(row.right)}>
            {truncate(row.right?.text ?? "", halfTextW())}
          </text>
        </box>
      </box>
    )
  }

  const hints = createMemo((): [string, string][] =>
    deck.diffFocus() === "tree"
      ? [
          ["j/k", "move"],
          ["enter", "open"],
          ["tab", "patch"],
          ["1/2/3", "edits/git/log"],
          ["s", "split"],
          ["esc", "back"],
        ]
      : [
          ["j/k", "line"],
          ["n/p", "hunk"],
          ["tab", "files"],
          ["esc", "back"],
        ],
  )

  return (
    <box
      flexDirection="column"
      width="100%"
      ref={(r: BoxRenderable) => {
        rootRef = r
      }}
      onSizeChange={() => {
        const next = rootRef?.width ?? 0
        if (next > 0 && next !== measured()) setMeasured(next)
      }}
    >
      <Show when={props.sessionID} fallback={<text wrapMode="none" fg={theme().text.muted}>opendeck: no session</text>}>
        <box flexDirection="column" width="100%" marginBottom={1}>
          <box flexDirection="row" gap={1} width="100%">
            <text wrapMode="none" fg={theme().hue.accent[200]}>
              <b>{`${glyph.main} opendeck · files changed`}</b>
            </text>
            <TabBar
              items={[
                { key: "edits", label: "edits" },
                { key: "git", label: "git" },
                { key: "log", label: "log" },
              ]}
              active={source() === "edits" ? "edits" : "git"}
              w={Math.max(21, Math.min(25, W() - 30))}
              onSelect={(key) => {
                // 3/log is the git log page, not a diff source (same as key 3).
                if (key === "log") deck.openGit()
                else deck.setDiffSource(key as "edits" | "git")
              }}
            />
            <Show when={source() === "commit"}>
              <text wrapMode="none" fg={theme().hue.accent[200]}>{`[commit ${(deck.diffCommit() ?? "").slice(0, 8)}]`}</text>
            </Show>
            <Show when={countsShown()}>
              <text wrapMode="none" fg={theme().text.muted}>{`${list().length} files`}</text>
              <text wrapMode="none" fg={theme().text.feedback.success.base}>{`+${totals().additions}`}</text>
              <text wrapMode="none" fg={theme().text.feedback.error.base}>{`-${totals().deletions}`}</text>
            </Show>
            <box flexGrow={1} />
            <text wrapMode="none" fg={theme().text.faint}>
              {deck.diffView()}
            </text>
          </box>
          <Rule w={W()} />
        </box>
        <Show
          when={statusLine()}
          keyed
          fallback={
            <box flexDirection="row" gap={1} width="100%">
              <box flexDirection="column" width={listW()} flexShrink={0} height={paneH()} overflow="hidden">
                <text wrapMode="none" fg={theme().text.muted}>
                  <b>files</b>
                </text>
                <ScrollList
                  items={flat()}
                  top={deck.diffListTop()}
                  height={listH()}
                  width={listW()}
                  onScroll={(next) => deck.setDiffListTop(next)}
                  render={renderTreeRow}
                />
              </box>
              <box flexDirection="column" width={1} flexShrink={0} height={paneH()} overflow="hidden">
                <For each={separatorRows()}>
                  {() => (
                    <text wrapMode="none" fg={theme().text.faint}>
                      │
                    </text>
                  )}
                </For>
              </box>
              <box flexDirection="column" flexGrow={1} height={paneH()} overflow="hidden">
                <Show
                  when={!untrackedEmpty()}
                  fallback={
                    <text wrapMode="none" fg={theme().text.muted}>
                      untracked file (not in git yet)
                    </text>
                  }
                >
                  <ScrollList
                    items={display().rows}
                    top={deck.diffScroll()}
                    height={patchH()}
                    width={rightW()}
                    scrollbar={true}
                    onScroll={(next) => deck.setDiffScroll(next)}
                    render={renderPatchRow}
                  />
                </Show>
                <Show when={footer()}>
                  <text wrapMode="none" fg={theme().text.faint}>
                    {footer()}
                  </text>
                </Show>
              </box>
            </box>
          }
        >
          {(line: { text: string; color: RGBA }) => (
            <text wrapMode="none" fg={line.color}>
              {line.text}
            </text>
          )}
        </Show>
        <KeyHints items={hints()} w={W()} />
      </Show>
    </box>
  )
}
