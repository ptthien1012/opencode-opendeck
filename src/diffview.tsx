/** @jsxImportSource @opentui/solid */
// Full-screen diff view (plugin route "opendeck-diff"): files changed in a
// session on the left (status glyph, +adds -dels), the selected file's patch
// on the right — side-by-side before/after by default, `s` toggles unified.
// Scroll: space/b (page), ctrl+d/u (half page), mouse wheel; n/p jump between
// hunks (click a hunk header to jump to it), g/G top/bottom; j/k moves the
// file selection, esc/q returns to the full view. Borderless Grok-CLI style
// (see ui.tsx). All view state lives on the deck so the keymap can drive it.
// No animations — this file creates no timers and never touches the ticker.

import type { FileDiffInfo } from "@opencode/client"
import { usePlugin } from "@opencode/plugin/tui"
import type { BoxRenderable, RGBA } from "@opentui/core"
import { createEffect, createMemo, createResource, createSignal, For, onMount, Show, untrack } from "solid-js"
import { maskSecrets, truncate } from "./format.js"
import { diffFromTools, splitPatch, type SplitCell, type SplitRow } from "./metrics.js"
import { collectToolParts } from "./shared.js"
import type { Deck } from "./state.js"
import { KeyHints, Marker, Rule, glyph } from "./ui.js"

const STATUS_GLYPH: Record<FileDiffInfo["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
}

export function DiffView(props: { deck: Deck; sessionID?: string; file?: string }) {
  const context = usePlugin()
  const theme = () => context.theme

  // Same self-measure as the full view: plugin routes publish no width, so
  // fill the page area and measure our own root box (never force width from
  // terminalWidth — that clips narrow terms).
  let rootRef: BoxRenderable | undefined
  const [measured, setMeasured] = createSignal(0)
  onMount(() => setMeasured(rootRef?.width ?? context.renderer.terminalWidth ?? 120))
  const W = createMemo(() => Math.max(48, measured() || context.renderer.terminalWidth || 120))
  const H = createMemo(() => context.renderer.terminalHeight ?? 40)

  // Local-first: the server-side session.diff snapshot can be empty even for
  // sessions that edited files, while completed edit/write tool parts carry
  // per-file patches in state.metadata.files. Derived across the whole session
  // family (main + subagents), reactive as messages stream in.
  createEffect(() => {
    const id = props.sessionID
    if (!id) return
    for (const fid of props.deck.familyIds(id)) props.deck.hydrateMessages(fid)
  })
  const local = createMemo(() => {
    const id = props.sessionID
    if (!id) return [] as FileDiffInfo[]
    return diffFromTools(collectToolParts(context, props.deck.familyIds(id)))
  })
  const useLocal = createMemo(() => local().length > 0)

  // Fallback path: the server snapshot, fetched once on mount and whenever
  // the session changes. Loading/error states apply only to this path.
  const [files] = createResource(
    () => props.sessionID,
    async (sessionID): Promise<FileDiffInfo[]> => {
      if (!sessionID) return []
      return await context.client.session.diff({ sessionID })
    },
  )
  const ready = createMemo(() => useLocal() || (!files.loading && files() !== undefined))
  const list = createMemo(() => (useLocal() ? local() : (files() ?? [])))

  // Selection lives on the deck (keymap + row clicks write the raw index);
  // it is clamped to the loaded list here.
  const sel = createMemo(() => Math.max(0, Math.min(list().length - 1, props.deck.diffSel())))
  const selected = createMemo(() => list()[sel()])

  // First load per session: jump to the requested file when one was given.
  let initialisedFor: string | undefined
  createEffect(() => {
    if (!ready()) return
    const sid = props.sessionID ?? ""
    if (initialisedFor === sid) return
    if (!props.file) {
      initialisedFor = sid
      return
    }
    // keep trying while the family's edit parts are still hydrating
    const index = list().findIndex((file) => file.file === props.file)
    if (index >= 0) {
      props.deck.diffSelect(index)
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

  const listW = createMemo(() => Math.min(40, Math.floor((W() * 35) / 100)))
  // list column + 1-char `│` separator column + two 1-char gaps.
  const rightW = createMemo(() => Math.max(24, W() - listW() - 3))
  // Page = header (2) + blank margin (1) + key hints (2) + slack (1).
  const page = createMemo(() => Math.max(4, H() - 6))

  // Publish the visible page size so the keymap scrolls by real pages.
  createEffect(() => {
    props.deck.setDiffPage(page())
  })

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
    const mode = props.deck.diffView()
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

  // Scroll offset: the deck stores it raw (clamped ≥ 0 there), the view
  // clamps the upper bound and snaps the stored value back when the content
  // or terminal shrinks — guarded writes only, so this can never loop.
  const maxScroll = createMemo(() => Math.max(0, display().rows.length - page()))
  const scroll = createMemo(() => Math.min(Math.max(0, props.deck.diffScroll()), maxScroll()))
  createEffect(() => {
    const clamped = scroll()
    if (clamped !== props.deck.diffScroll()) props.deck.setDiffScroll(clamped)
  })
  const visibleRows = createMemo(() => display().rows.slice(scroll(), scroll() + page()))

  // Hunk/top/bottom jump requests from the keymap (or future callers): seq
  // is the only trigger; display()/scroll() changes alone never re-jump.
  let lastJumpSeq = untrack(() => props.deck.diffJumpReq().seq)
  createEffect(() => {
    const req = props.deck.diffJumpReq()
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
    if (target !== undefined) props.deck.setDiffScroll(Math.min(target, max))
  })

  // File list window: first visible index lives on the deck (mouse wheel
  // moves it), clamped here. The selection is kept visible by nudging the
  // window only when j/k (or a click) moves it outside — never otherwise,
  // so the effect can't fight manual wheel scrolling.
  const maxListTop = createMemo(() => Math.max(0, list().length - page()))
  const listTop = createMemo(() => Math.min(Math.max(0, props.deck.diffListTop()), maxListTop()))
  createEffect(() => {
    const count = list().length
    if (count === 0) {
      if (untrack(() => props.deck.diffListTop()) !== 0) props.deck.setDiffListTop(0)
      return
    }
    const s = sel()
    const span = page()
    let next = untrack(() => listTop())
    if (s < next) next = s
    else if (s >= next + span) next = s - span + 1
    next = Math.max(0, Math.min(maxListTop(), next))
    if (next !== untrack(() => props.deck.diffListTop())) props.deck.setDiffListTop(next)
  })
  const visibleFiles = createMemo(() => list().slice(listTop(), listTop() + page()))

  // Footer under the patch: visible range + which hunk the window starts in.
  const footer = createMemo(() => {
    const total = display().rows.length
    if (total === 0) return ""
    const from = scroll() + 1
    const to = Math.min(total, scroll() + page())
    const hunks = display().hunks
    if (hunks.length === 0) return `rows ${from}–${to} of ${total}`
    const current = hunks.filter((h) => h <= scroll()).length
    const label = current === 0 ? "–" : String(Math.min(current, hunks.length))
    return `rows ${from}–${to} of ${total} · hunk ${label}/${hunks.length}`
  })

  // Rows the faint `│` separator column needs to cover both columns.
  const separatorRows = createMemo(() => {
    const right = visibleRows().length + (footer() ? 1 : 0)
    return Array.from({ length: Math.max(visibleFiles().length, right) }, (_, index) => index)
  })

  // Split halves: equal width with a faint `│` between. Gutter is 4-wide
  // right-aligned plus one space inside each half.
  const halfW = createMemo(() => Math.max(12, Math.floor((rightW() - 1) / 2)))
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

  function glyphColor(file: FileDiffInfo): RGBA {
    const text = theme().text
    if (file.status === "added") return text.feedback.success.base
    if (file.status === "deleted") return text.feedback.error.base
    return text.feedback.warning.base
  }

  function onPatchScroll(event: { scroll?: { direction: string } }) {
    const direction = event.scroll?.direction
    if (direction === "down") props.deck.diffScrollBy(3)
    else if (direction === "up") props.deck.diffScrollBy(-3)
  }

  function onListScroll(event: { scroll?: { direction: string } }) {
    const direction = event.scroll?.direction
    if (direction !== "down" && direction !== "up") return
    const next = props.deck.diffListTop() + (direction === "down" ? 1 : -1)
    props.deck.setDiffListTop(Math.max(0, Math.min(maxListTop(), next)))
  }

  const errorMessage = () => {
    const err = files.error as { message?: unknown }
    return truncate(maskSecrets(String(err?.message ?? files.error)), 80)
  }

  const hints = createMemo(
    (): [string, string][] => [
      ["j/k", "file"],
      ["space/b", "scroll"],
      ["n/p", "hunk"],
      ["s", props.deck.diffView() === "split" ? "unified" : "split"],
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
        <Show
          when={useLocal() || !files.error}
          fallback={
            <text wrapMode="none" fg={theme().text.feedback.error.base}>{`diff unavailable: ${errorMessage()}`}</text>
          }
        >
          <Show when={ready()} fallback={<text wrapMode="none" fg={theme().text.muted}>loading diff…</text>}>
            <Show
              when={list().length > 0}
              fallback={
                <text wrapMode="none" fg={theme().text.muted}>no file changes in this session</text>
              }
            >
              <box flexDirection="column" width="100%" marginBottom={1}>
                <box flexDirection="row" gap={1} width="100%">
                  <text wrapMode="none" fg={theme().hue.accent[200]}>
                    <b>{`${glyph.main} opendeck · files changed`}</b>
                  </text>
                  <text wrapMode="none" fg={theme().text.muted}>{`${list().length} files`}</text>
                  <text wrapMode="none" fg={theme().text.feedback.success.base}>{`+${totals().additions}`}</text>
                  <text wrapMode="none" fg={theme().text.feedback.error.base}>{`-${totals().deletions}`}</text>
                  <text wrapMode="none" fg={theme().text.faint}>{`· from ${useLocal() ? "edits" : "snapshot"}`}</text>
                  <box flexGrow={1} />
                  <text wrapMode="none" fg={theme().text.faint}>
                    {props.deck.diffView()}
                  </text>
                </box>
                <Rule w={W()} />
              </box>
              <box flexDirection="row" gap={1} width="100%">
                <box
                  flexDirection="column"
                  width={listW()}
                  flexShrink={0}
                  overflow="hidden"
                  onMouseScroll={onListScroll}
                >
                  <For each={visibleFiles()}>
                    {(file, index) => {
                      const absolute = () => listTop() + index()
                      const active = () => absolute() === sel()
                      const stats = `+${file.additions} -${file.deletions}`
                      const pathW = () => Math.max(8, listW() - stats.length - 6)
                      return (
                        <box flexDirection="row" onMouseDown={() => props.deck.diffSelect(absolute())}>
                          <Show
                            when={active()}
                            fallback={<text wrapMode="none" flexShrink={0} fg={theme().text.faint}>{" "}</text>}
                          >
                            <Marker color={theme().hue.accent[200]} />
                          </Show>
                          <text wrapMode="none" flexShrink={0} fg={glyphColor(file)}>
                            {` ${STATUS_GLYPH[file.status]} `}
                          </text>
                          <text wrapMode="none" fg={active() ? theme().text.base : theme().text.muted}>
                            {`${truncate(file.file, pathW())} ${stats}`}
                          </text>
                        </box>
                      )
                    }}
                  </For>
                </box>
                <box flexDirection="column" width={1} flexShrink={0} overflow="hidden">
                  <For each={separatorRows()}>
                    {() => (
                      <text wrapMode="none" fg={theme().text.faint}>
                        │
                      </text>
                    )}
                  </For>
                </box>
                <box flexDirection="column" flexGrow={1} overflow="hidden" onMouseScroll={onPatchScroll}>
                  <For each={visibleRows()}>
                    {(row, index) => {
                      const absolute = () => scroll() + index()
                      if (row.type === "hunk") {
                        return (
                          <box flexDirection="row" onMouseDown={() => props.deck.setDiffScroll(absolute())}>
                            <text wrapMode="none" fg={theme().hue.accent[200]}>
                              {truncate(row.text, rightW())}
                            </text>
                          </box>
                        )
                      }
                      if (row.type === "file") {
                        return (
                          <text wrapMode="none" fg={theme().text.faint}>
                            {truncate(row.text, rightW())}
                          </text>
                        )
                      }
                      if (props.deck.diffView() === "unified") {
                        const cell = row.left ?? row.right
                        return (
                          <box flexDirection="row" width={rightW()}>
                            <text wrapMode="none" flexShrink={0} fg={theme().text.faint}>
                              {`${gutter(row.left)} ${gutter(row.right)} `}
                            </text>
                            <text wrapMode="none" fg={unifiedColor(row)}>
                              {truncate(`${unifiedPrefix(row)}${cell?.text ?? ""}`, Math.max(8, rightW() - 11))}
                            </text>
                          </box>
                        )
                      }
                      return (
                        <box flexDirection="row" width={rightW()}>
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
                    }}
                  </For>
                  <Show when={footer()}>
                    <text wrapMode="none" fg={theme().text.faint}>
                      {footer()}
                    </text>
                  </Show>
                </box>
              </box>
              <KeyHints items={hints()} w={W()} />
            </Show>
          </Show>
        </Show>
      </Show>
    </box>
  )
}
