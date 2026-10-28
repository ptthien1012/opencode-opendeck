/** @jsxImportSource @opentui/solid */
// Full-screen diff view (plugin route "opendeck-diff"): files changed in a
// session on the left (status glyph, +adds -dels), the selected file's patch
// with coloured +/- lines on the right. Reached with `f` from the Opendeck
// full view or deck.openDiff(file?); esc/q returns to the full view.
// No animations — this file creates no timers and never touches the ticker.

import type { FileDiffInfo } from "@opencode/client"
import { usePlugin } from "@opencode/plugin/tui"
import type { BoxRenderable, RGBA } from "@opentui/core"
import { createEffect, createMemo, createResource, createSignal, For, onMount, Show } from "solid-js"
import { maskSecrets, truncate } from "./format.js"
import { diffFromTools } from "./metrics.js"
import { collectToolParts } from "./shared.js"
import type { Deck } from "./state.js"

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
    initialisedFor = sid
    if (!props.file) return
    const index = list().findIndex((file) => file.file === props.file)
    if (index >= 0) props.deck.setDiffSel(index)
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
  const rightW = createMemo(() => Math.max(24, W() - listW() - 4))
  const maxLines = createMemo(() => Math.max(4, H() - 6))
  const visibleFiles = createMemo(() => list().slice(0, maxLines()))

  // Patch lines, secret-masked before they reach the screen. Row objects keep
  // For's referential keying happy when a patch repeats the same line text.
  const patchLines = createMemo(() => {
    const file = selected()
    if (!file) return [] as { id: number; text: string }[]
    return maskSecrets(file.patch)
      .split("\n")
      .map((text, id) => ({ id, text }))
  })
  const visiblePatch = createMemo(() => patchLines().slice(0, maxLines()))
  const hiddenPatch = createMemo(() => Math.max(0, patchLines().length - maxLines()))

  function lineColor(line: string): RGBA {
    const text = theme().text
    if (line.startsWith("+++") || line.startsWith("---")) return text.muted
    if (line.startsWith("+")) return text.feedback.success.base
    if (line.startsWith("-")) return text.feedback.error.base
    if (line.startsWith("@@")) return theme().hue.accent[200]
    return text.muted
  }

  function glyphColor(file: FileDiffInfo, active: boolean): RGBA {
    const text = theme().text
    if (active) return theme().hue.accent[200]
    if (file.status === "added") return text.feedback.success.base
    if (file.status === "deleted") return text.feedback.error.base
    return text.feedback.warning.base
  }

  const errorMessage = () => {
    const err = files.error as { message?: unknown }
    return truncate(maskSecrets(String(err?.message ?? files.error)), 80)
  }

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
              <box flexDirection="row" justifyContent="space-between" width="100%" marginBottom={1}>
                <box flexDirection="row" gap={1}>
                  <text wrapMode="none" fg={theme().text.base}>
                    {`Opendeck · files changed  ${list().length} files  +${totals().additions} -${totals().deletions}`}
                  </text>
                  <text wrapMode="none" fg={theme().text.faint}>{`· from ${useLocal() ? "edits" : "snapshot"}`}</text>
                </box>
                <text wrapMode="none" fg={theme().text.faint}>
                  [j/k] select [esc] back
                </text>
              </box>
              <box flexDirection="row" gap={2} width="100%">
                <box flexDirection="column" width={listW()} flexShrink={0} overflow="hidden">
                  <For each={visibleFiles()}>
                    {(file, index) => {
                      const active = () => index() === sel()
                      const stats = `+${file.additions} -${file.deletions}`
                      const pathW = () => Math.max(8, listW() - stats.length - 6)
                      return (
                        <box flexDirection="row" onMouseDown={() => props.deck.setDiffSel(index())}>
                          <text wrapMode="none" flexShrink={0} fg={glyphColor(file, active())}>
                            {`${active() ? "▶" : " "} ${STATUS_GLYPH[file.status]} `}
                          </text>
                          <text wrapMode="none" fg={active() ? theme().text.base : theme().text.muted}>
                            {`${truncate(file.file, pathW())} ${stats}`}
                          </text>
                        </box>
                      )
                    }}
                  </For>
                </box>
                <box flexDirection="column" flexGrow={1} overflow="hidden">
                  <For each={visiblePatch()}>
                    {(row) => (
                      <text wrapMode="none" fg={lineColor(row.text)}>
                        {truncate(row.text, rightW())}
                      </text>
                    )}
                  </For>
                  <Show when={hiddenPatch() > 0}>
                    <text wrapMode="none" fg={theme().text.faint}>{`… ${hiddenPatch()} more lines`}</text>
                  </Show>
                </box>
              </box>
            </Show>
          </Show>
        </Show>
      </Show>
    </box>
  )
}
