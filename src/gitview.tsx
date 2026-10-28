/** @jsxImportSource @opentui/solid */
// Git log page (plugin route "opendeck-git"): `git log --graph --all` of the
// session's working directory as an aligned, scrollable list. j/k (or click)
// selects a commit, enter opens its files in the diff page (commit source),
// r reloads, esc/q returns to the Opendeck full view. Borderless Grok-CLI
// style; no timers.

import { usePlugin } from "@opencode/plugin/tui"
import type { BoxRenderable, RGBA } from "@opentui/core"
import { createEffect, createMemo, createResource, createSignal, onMount, Show, untrack } from "solid-js"
import { maskSecrets, truncate } from "./format.js"
import { loadGraph, type GraphCommit } from "./git.js"
import type { Deck } from "./state.js"
import { KeyHints, Marker, Rule, ScrollList, glyph } from "./ui.js"

const HASH_W = 8
const AUTHOR_W = 12
const TIME_W = 14
const GRAPH_MAX = 16

/** Fit `text` into exactly `width` cells: truncate, then pad (left or right). */
function fit(text: string, width: number, alignRight = false): string {
  const w = Math.max(0, Math.floor(width))
  const cut = truncate(text, w)
  const pad = " ".repeat(Math.max(0, w - cut.length))
  return alignRight ? pad + cut : cut + pad
}

export function GitView(props: { deck: Deck; sessionID?: string }) {
  const context = usePlugin()
  const theme = () => context.theme
  const deck = props.deck

  let rootRef: BoxRenderable | undefined
  const [measured, setMeasured] = createSignal(0)
  onMount(() => setMeasured(rootRef?.width ?? context.renderer.terminalWidth ?? 120))
  const W = createMemo(() => Math.max(48, measured() || context.renderer.terminalWidth || 120))
  const H = createMemo(() => context.renderer.terminalHeight ?? 40)

  const cwd = createMemo((): string | undefined => {
    const id = props.sessionID
    if (id) {
      try {
        const dir = context.data.session.get(id)?.location?.directory
        if (typeof dir === "string" && dir !== "") return dir
      } catch {
        // fall through to the host's location
      }
    }
    try {
      const dir = context.location?.directory
      if (typeof dir === "string" && dir !== "") return dir
    } catch {
      // no directory
    }
    return undefined
  })

  const [log] = createResource(
    () => ({ cwd: cwd(), tick: deck.gitTick() }),
    async (key): Promise<{ rows?: GraphCommit[]; error?: string }> => {
      if (!key.cwd) return { error: "no working directory" }
      const result = await loadGraph(key.cwd, 300)
      return typeof result === "string" ? { error: result } : { rows: result }
    },
  )
  const rows = createMemo(() => log()?.rows ?? [])
  // Row indexes of real commits (connector-only graph lines are skipped by j/k).
  const commitRows = createMemo(() => {
    const out: number[] = []
    rows().forEach((row, index) => {
      if (row.hash) out.push(index)
    })
    return out
  })
  const sel = createMemo(() => Math.max(0, Math.min(commitRows().length - 1, deck.gitSel())))
  const selRow = createMemo(() => commitRows()[sel()] ?? -1)
  const selected = createMemo(() => rows()[selRow()])
  // Snap the raw selection back into range; publish the selected hash.
  createEffect(() => {
    const clamped = sel()
    if (commitRows().length > 0 && clamped !== untrack(() => deck.gitSel())) deck.gitSelect(clamped)
  })
  createEffect(() => deck.setGitHash(selected()?.hash))

  const branch = createMemo(() => {
    for (const row of rows()) {
      for (const ref of row.refs) if (ref.startsWith("HEAD -> ")) return ref.slice(8)
    }
    return undefined
  })

  // Layout: header (2 rows) + gap + list + footer + hints.
  const listH = createMemo(() => Math.max(1, H() - 6))
  createEffect(() => deck.setGitPage(listH()))
  const graphW = createMemo(() => {
    let max = 1
    for (const row of rows()) max = Math.max(max, row.graph.length)
    return Math.min(GRAPH_MAX, max)
  })
  const barW = 1
  // marker(1) + space(1) + graph + space + hash + space + [subject] + space + author + space + time
  const subjectW = createMemo(() =>
    Math.max(8, W() - barW - 2 - graphW() - 1 - HASH_W - 1 - 1 - AUTHOR_W - 1 - TIME_W),
  )

  // Keep the selected commit row inside the window (only when selection moves).
  const maxTop = createMemo(() => Math.max(0, rows().length - listH()))
  const top = createMemo(() => Math.max(0, Math.min(maxTop(), deck.gitTop())))
  createEffect(() => {
    const row = selRow()
    if (row < 0) return
    const span = listH()
    let next = untrack(() => top())
    if (row < next) next = row
    else if (row >= next + span) next = row - span + 1
    next = Math.max(0, Math.min(maxTop(), next))
    if (next !== untrack(() => deck.gitTop())) deck.setGitTop(next)
  })

  function graphColor(ch: string): RGBA {
    if (ch === "*") return theme().hue.accent[200]
    return theme().text.faint
  }

  function refColor(ref: string): RGBA {
    if (ref.startsWith("HEAD")) return theme().hue.accent[200]
    if (ref.startsWith("tag: ")) return theme().text.feedback.warning.base
    if (ref.startsWith("origin/") || ref.includes("/")) return theme().text.muted
    return theme().hue.accent[200]
  }

  function renderRow(row: GraphCommit, index: number) {
    const active = index === selRow()
    const graph = fit(row.graph, graphW())
    if (!row.hash) {
      return (
        <box flexDirection="row" width={W() - barW}>
          <text wrapMode="none">{"  "}</text>
          <text wrapMode="none" fg={theme().text.faint}>{graph}</text>
        </box>
      )
    }
    // refs as compact [chips] ahead of the subject, sharing the subject slot
    const chips = row.refs.map((ref) => `[${ref.replace(/^HEAD -> /, "HEAD→")}]`)
    const chipText = chips.join(" ")
    const chipW = Math.min(chipText.length, Math.floor(subjectW() / 2))
    const subject = maskSecrets(row.subject ?? "")
    const restW = Math.max(0, subjectW() - (chipW > 0 ? chipW + 1 : 0))
    return (
      <box flexDirection="row" width={W() - barW} onMouseDown={() => deck.gitSelect(commitRows().indexOf(index))}>
        <Show when={active} fallback={<text wrapMode="none">{" "}</text>}>
          <Marker color={theme().hue.accent[200]} />
        </Show>
        <text wrapMode="none">{" "}</text>
        <box flexDirection="row" width={graphW()} flexShrink={0}>
          {graph.split("").map((ch) => (
            <text wrapMode="none" fg={graphColor(ch)}>
              {ch}
            </text>
          ))}
        </box>
        <text wrapMode="none" fg={theme().text.faint}>{` ${fit(row.short ?? "", HASH_W)} `}</text>
        <Show when={chipW > 0}>
          <text wrapMode="none" fg={refColor(row.refs[0] ?? "")}>{`${fit(chipText, chipW)} `}</text>
        </Show>
        <text wrapMode="none" fg={active ? theme().text.base : theme().text.muted}>{fit(subject, restW)}</text>
        <text wrapMode="none" fg={theme().text.muted}>{` ${fit(row.author ?? "", AUTHOR_W)}`}</text>
        <text wrapMode="none" fg={theme().text.faint}>{` ${fit(row.relTime ?? "", TIME_W, true)}`}</text>
      </box>
    )
  }

  const footer = createMemo(() => {
    const total = commitRows().length
    if (total === 0) return ""
    const c = selected()
    return `commit ${sel() + 1}/${total}${c?.parents && c.parents.length > 1 ? " · merge" : ""}`
  })

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
      <box flexDirection="column" width="100%" marginBottom={1}>
        <box flexDirection="row" gap={1} width="100%">
          <text wrapMode="none" fg={theme().hue.accent[200]}>
            <b>{`${glyph.main} opendeck · git log`}</b>
          </text>
          <Show when={branch()}>
            <text wrapMode="none" fg={theme().hue.accent[200]}>{`⎇ ${branch()}`}</text>
          </Show>
          <text wrapMode="none" fg={theme().text.muted}>{`${commitRows().length} commits`}</text>
          <text wrapMode="none" fg={theme().text.faint}>{truncate(cwd() ?? "", 60)}</text>
        </box>
        <Rule w={W()} />
      </box>
      <Show
        when={log()?.error === undefined}
        fallback={<text wrapMode="none" fg={theme().text.muted}>{`git: ${truncate(maskSecrets(log()?.error ?? ""), 100)}`}</text>}
      >
        <Show when={rows().length > 0} fallback={<text wrapMode="none" fg={theme().text.muted}>loading git log…</text>}>
          <ScrollList
            items={rows()}
            top={top()}
            height={listH()}
            width={W()}
            scrollbar
            onScroll={(next) => deck.setGitTop(next)}
            render={(row, index) => renderRow(row, index)}
          />
          <text wrapMode="none" fg={theme().text.faint}>{footer()}</text>
        </Show>
      </Show>
      <KeyHints
        items={[
          ["j/k", "move"],
          ["enter", "files"],
          ["space/b", "page"],
          ["r", "reload"],
          ["esc", "back"],
        ]}
        w={W()}
      />
    </box>
  )
}
