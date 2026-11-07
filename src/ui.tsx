/** @jsxImportSource @opentui/solid */
// Shared Grok-CLI-style UI primitives: borderless sections headed by a title
// rule line, rounded agent cards, ▰▱ gauges, █░ bars, ▌ status markers and
// one-line key hints.
// Calm base — text.base/muted/faint — with a single accent and one stable
// categorical colour per agent (agentColor). Pure presentation over the host
// theme: no timers, no state, no writes.

import { usePlugin } from "@opencode/plugin/tui"
import type { RGBA } from "@opentui/core"
import { createMemo, For, Index, Show } from "solid-js"
import type { JSX } from "solid-js"
import { treeRail } from "./anim.js"
import { fitHints, truncate } from "./format.js"

/**
 * Stable per-agent colour: sum of the id's char codes modulo the theme's
 * categorical palette, so one agent keeps one colour across every view.
 * Falls back to the accent scale when the theme ships no categorical hues;
 * `step` picks the brightness within the scale.
 */
export function agentColor(
  theme: ReturnType<typeof usePlugin>["theme"],
  id: string,
  step: "200" | "400" = "400",
): RGBA {
  const palette = theme.categorical
  if (palette.length === 0) return theme.hue.accent[step]
  let hash = 0
  for (let index = 0; index < id.length; index++) hash += id.charCodeAt(index)
  return palette[hash % palette.length]![step]
}

/**
 * A section = `── title ──────── right` rule line, then children indented by
 * 2 spaces. Title is bold text.base (accent when props.accent, or an explicit
 * titleColor), rule chars are faint, right label faint. Total header width is
 * exactly props.w; rule length = w - title - right - spacing (min 1).
 */
export function Section(props: {
  title: string
  right?: string
  w: number
  accent?: boolean
  titleColor?: RGBA
  /** Blank lines after the section (default 2 for airy pages; 1 in tight slots). */
  gap?: number
  children: JSX.Element
}) {
  const context = usePlugin()
  const theme = () => context.theme
  const rightText = createMemo(() => (props.right ? ` ${props.right}` : ""))
  const title = createMemo(() => truncate(props.title, Math.max(1, props.w - rightText().length - 5)))
  // right label sits flush against the last column so every rule ends at the
  // same x no matter how long the label is
  // <text> ignores flexShrink, so the rule must be sized exactly to the
  // space left after title + right label — that's what keeps every rule
  // ending at the same column and the label fully visible.
  const rule = createMemo(() => Math.max(1, props.w - 5 - title().length - rightText().length))
  const color = createMemo(() => props.titleColor ?? (props.accent ? theme().hue.accent[200] : theme().text.base))
  return (
    <box flexDirection="column" width={props.w} marginBottom={props.gap ?? 2}>
      <box flexDirection="row" width={props.w}>
        <text wrapMode="none" flexShrink={0} fg={theme().text.faint}>
          ──{" "}
        </text>
        <text wrapMode="none" flexShrink={0} fg={color()}>
          <b>{title()}</b>
        </text>
        <text wrapMode="none" flexShrink={0} fg={theme().text.faint}>{` ${"─".repeat(rule())}`}</text>
        <Show when={props.right}>
          <text wrapMode="none" flexShrink={0} fg={theme().text.faint}>
            {rightText()}
          </text>
        </Show>
      </box>
      <box flexDirection="column" paddingLeft={2} width={props.w}>
        {props.children}
      </box>
    </box>
  )
}

/** Full-width faint `─` rule. */
export function Rule(props: { w: number }) {
  const context = usePlugin()
  const theme = () => context.theme
  const line = createMemo(() => "─".repeat(Math.max(1, Math.floor(props.w))))
  return (
    <text wrapMode="none" fg={theme().text.faint}>
      {line()}
    </text>
  )
}

/** ▰▱ gauge of `cells` cells: filled in accent, empty in faint. */
export function Gauge(props: { ratio: number | undefined; cells: number }) {
  const context = usePlugin()
  const theme = () => context.theme
  const cells = createMemo(() => Math.max(0, Math.floor(props.cells)))
  const filled = createMemo(() => {
    if (props.ratio === undefined) return 0
    return Math.round(Math.max(0, Math.min(1, props.ratio)) * cells())
  })
  return (
    // fixed width: an empty "" text node can still take a layout cell, so
    // the box pins the gauge to exactly `cells` columns either way
    <box flexDirection="row" width={cells()} flexShrink={0}>
      <Show when={filled() > 0}>
        <text wrapMode="none" flexShrink={0} fg={theme().hue.accent[200]}>{"▰".repeat(filled())}</text>
      </Show>
      <Show when={cells() - filled() > 0}>
        <text wrapMode="none" flexShrink={0} fg={theme().text.faint}>{"▱".repeat(cells() - filled())}</text>
      </Show>
    </box>
  )
}

/**
 * `█…░…` bar of `width` cells (capped at `maxCells`, default 20) as a two-text
 * row: filled cells in `color`, the rest in `dim`. Any value > 0 fills at
 * least one cell. Called as a plain function (`{bar(...)}`), not a component.
 */
export function bar(
  value: number,
  max: number,
  width: number,
  color: RGBA,
  dim: RGBA,
  maxCells = 20,
): JSX.Element {
  const cells = Math.min(maxCells, Math.max(0, Math.floor(width)))
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0
  let filled = Math.round(ratio * cells)
  if (value > 0 && filled === 0 && cells > 0) filled = 1
  return (
    // fixed width: same reasoning as Gauge — the box pins the bar to exactly
    // `cells` columns so trailing columns line up either way
    <box flexDirection="row" width={cells} flexShrink={0}>
      <Show when={filled > 0}>
        <text wrapMode="none" flexShrink={0} fg={color}>
          {"█".repeat(filled)}
        </text>
      </Show>
      <Show when={cells - filled > 0}>
        <text wrapMode="none" flexShrink={0} fg={dim}>
          {"░".repeat(cells - filled)}
        </text>
      </Show>
    </box>
  )
}

/** `▌` status marker in the given colour. */
export function Marker(props: { color: RGBA }) {
  return (
    <text wrapMode="none" fg={props.color}>
      ▌
    </text>
  )
}

/**
 * Rounded bordered card for one agent. Caller passes the agent colour while
 * live, theme.text.faint when idle or done. `selected` = keyboard-selected:
 * the border turns heavy so the focused card stands out from its siblings.
 */
export function AgentCard(props: {
  w: number
  color: RGBA
  title?: string
  selected?: boolean
  onMouseDown?: () => void
  children: JSX.Element
}) {
  return (
    <box
      flexDirection="column"
      width={props.w}
      flexShrink={0}
      border
      borderStyle={props.selected ? "heavy" : "rounded"}
      borderColor={props.color}
      title={props.title}
      paddingLeft={1}
      paddingRight={1}
      onMouseDown={props.onMouseDown}
    >
      {props.children}
    </box>
  )
}

/** Content width inside an AgentCard: minus border (2) and padding (2). */
export const cardInner = (w: number) => Math.max(6, w - 4)

/** One line `key label · key label`; keys accent, labels faint, fit to w —
 *  on overflow the last two hints survive behind a faint `· …`. With `wrap`
 *  every hint renders whole and the row wraps between hints instead. */
export function KeyHints(props: { items: readonly [string, string][]; w: number; wrap?: boolean }) {
  const context = usePlugin()
  const theme = () => context.theme
  const fitted = createMemo(() => (props.wrap ? undefined : fitHints(props.items, props.w)))
  const hints = createMemo<readonly [string, string][]>(() => (props.wrap ? props.items : (fitted()?.items ?? [])))
  return (
    <box flexDirection="row" flexWrap={props.wrap ? "wrap" : undefined} width={props.w}>
      <For each={hints()}>
        {(part, index) => (
          <box flexDirection="row">
            <text wrapMode="none" fg={theme().text.faint}>
              {index() === 0 ? "" : " · "}
            </text>
            <text wrapMode="none" fg={theme().hue.accent[200]}>
              {part[0]}
            </text>
            <text wrapMode="none" fg={theme().text.faint}>{` ${part[1]}`}</text>
          </box>
        )}
      </For>
      <Show when={fitted()?.dropped}>
        <text wrapMode="none" fg={theme().text.faint}>
          {" · …"}
        </text>
      </Show>
    </box>
  )
}

/**
 * One-line tab strip: `${index + 1} ${label}` per tab, the `active` key in
 * accent brackets (`[1 files]`), the rest muted and space-padded so every tab
 * keeps the same width and the strip does not shift when the active tab
 * changes. Tabs are separated by one faint space and are clickable. When the
 * full strip exceeds `w`, inactive tabs fall back to `${index + 1} ${initial}`
 * while the active tab keeps its full label. With `wrap`, labels are never
 * shortened and the strip wraps onto extra rows instead.
 */
export function TabBar(props: {
  items: readonly { key: string; label: string }[]
  active: string
  w: number
  onSelect?: (key: string) => void
  wrap?: boolean
}) {
  const context = usePlugin()
  const theme = () => context.theme
  const parts = createMemo(() => {
    const full = props.items.map((item, index) => ({
      item,
      active: item.key === props.active,
      text: `${index + 1} ${item.label}`,
    }))
    if (props.wrap) return full
    const stripWidth = (list: { text: string }[]) =>
      list.reduce((sum, part) => sum + part.text.length + 2, 0) + Math.max(0, list.length - 1)
    if (stripWidth(full) <= props.w) return full
    return full.map((part, index) => ({
      ...part,
      text: part.active ? part.text : `${index + 1} ${part.item.label[0] ?? ""}`,
    }))
  })
  return (
    <box flexDirection="row" flexWrap={props.wrap ? "wrap" : undefined} width={props.w}>
      <For each={parts()}>
        {(part, index) => (
          <box flexDirection="row">
            <text wrapMode="none" fg={theme().text.faint}>
              {index() === 0 ? "" : " "}
            </text>
            <box flexDirection="row" onMouseDown={() => props.onSelect?.(part.item.key)}>
              <Show
                when={part.active}
                fallback={
                  <text wrapMode="none" fg={theme().text.muted}>{` ${part.text} `}</text>
                }
              >
                <text wrapMode="none" fg={theme().hue.accent[200]}>
                  <b>{`[${part.text}]`}</b>
                </text>
              </Show>
            </box>
          </box>
        )}
      </For>
    </box>
  )
}

/**
 * Vertical sibling rail: `treeRail` rows (`│` ancestors, `├──`/`└──` at the
 * join, lit packet while active) over a filler that stretches to the sibling
 * card height. `last` ends the branch with a blank column instead of a
 * continuation `│`.
 */
export function TreeRail(props: {
  last: boolean
  active: boolean
  phase: number
  color: RGBA
  w: number
  join?: number
}) {
  const context = usePlugin()
  const theme = () => context.theme
  const join = createMemo(() => props.join ?? 2)
  const rows = createMemo(() =>
    treeRail({ rows: join() + 1, join: join(), last: props.last, active: props.active, phase: props.phase, w: props.w }),
  )
  return (
    <box flexDirection="column" width={props.w} flexShrink={0} alignSelf="stretch">
      <Index each={rows()}>
        {(row) => (
          <text wrapMode="none" fg={row().lit ? props.color : theme().text.faint}>
            {row().text}
          </text>
        )}
      </Index>
      <Show when={!props.last} fallback={<box flexGrow={1} />}>
        <box flexGrow={1} border={["left"]} borderStyle="single" borderColor={theme().text.faint} />
      </Show>
    </box>
  )
}

/**
 * Ancestor continuation column: a faint `│` rail that stretches to the row
 * height, keeping one vertical line under every ancestor card above `open`.
 */
export function RailSpacer(props: { open: boolean; w: number }) {
  const context = usePlugin()
  const theme = () => context.theme
  return (
    <box flexDirection="column" width={props.w} flexShrink={0} alignSelf="stretch">
      <Show when={props.open}>
        <box flexGrow={1} border={["left"]} borderStyle="single" borderColor={theme().text.faint} />
      </Show>
    </box>
  )
}

/**
 * Fixed-window scrollable list: renders exactly `height` rows — the slice
 * items[top, top+height) plus blank pad rows — each boxed at the same width
 * so columns line up (no ragged edges). `top` is clamped to
 * [0, max(0, items.length - height)] for rendering only; the clamped value is
 * never written back. The wheel reports the desired next top via onScroll
 * (±3, clamped). With scrollbar + overflowing items a 1-col bar takes the
 * rightmost column: faint │ track, accent ┃ thumb sized height²/len (min 1).
 */
export function ScrollList<T>(props: {
  items: readonly T[]
  top: number
  height: number
  width: number
  onScroll: (nextTop: number) => void
  render: (item: T, index: number) => JSX.Element
  scrollbar?: boolean
}) {
  const context = usePlugin()
  const theme = () => context.theme
  const height = createMemo(() => Math.max(0, Math.floor(props.height)))
  const width = createMemo(() => Math.max(1, Math.floor(props.width)))
  const maxTop = createMemo(() => Math.max(0, props.items.length - height()))
  const top = createMemo(() => Math.max(0, Math.min(maxTop(), Math.floor(props.top))))
  const bar = createMemo(
    () => props.scrollbar === true && width() >= 2 && height() > 0 && props.items.length > height(),
  )
  const contentW = createMemo(() => width() - (bar() ? 1 : 0))
  // One slot per visible row; item is undefined past the end (pad rows).
  // Fresh wrapper objects per recompute — rows are few, re-render cost is nil.
  const rows = createMemo(() => {
    const out: { item: T | undefined; index: number }[] = []
    for (let i = 0; i < height(); i++) {
      const index = top() + i
      out.push({ item: props.items[index], index })
    }
    return out
  })
  const thumb = createMemo(() => {
    const size = Math.max(1, Math.floor((height() * height()) / Math.max(1, props.items.length)))
    const travel = Math.max(0, height() - size)
    const start = maxTop() === 0 ? 0 : Math.min(travel, Math.round((top() / maxTop()) * travel))
    return { size, start }
  })
  function onWheel(event: { scroll?: { direction?: string } }) {
    const direction = event.scroll?.direction
    if (direction === "up") props.onScroll(Math.max(0, top() - 3))
    else if (direction === "down") props.onScroll(Math.min(maxTop(), top() + 3))
  }
  return (
    <box
      flexDirection="row"
      width={width()}
      height={height()}
      flexShrink={0}
      overflow="hidden"
      onMouseScroll={onWheel}
    >
      <box flexDirection="column" width={contentW()} flexShrink={0} overflow="hidden">
        <For each={rows()}>
          {(row) => (
            <box flexDirection="row" width={contentW()} height={1} overflow="hidden">
              {row.item === undefined ? <text wrapMode="none">{" "}</text> : props.render(row.item, row.index)}
            </box>
          )}
        </For>
      </box>
      <Show when={bar()}>
        <box flexDirection="column" width={1} flexShrink={0} overflow="hidden">
          <For each={rows()}>
            {(row, index) => {
              const inThumb = () => index() >= thumb().start && index() < thumb().start + thumb().size
              return (
                <text wrapMode="none" fg={inThumb() ? theme().hue.accent[200] : theme().text.faint}>
                  {inThumb() ? "┃" : "│"}
                </text>
              )
            }}
          </For>
        </box>
      </Show>
    </box>
  )
}

export const glyph = {
  running: "●",
  done: "✓",
  error: "✗",
  idle: "○",
  interrupted: "⚠",
  main: "◆",
}
