/** @jsxImportSource @opentui/solid */
// Shared Grok-CLI-style UI primitives: borderless sections headed by a title
// rule line, ▰▱ gauges, █░ bars, ▌ status markers and one-line key hints.
// Calm base — text.base/muted/faint — with a single accent and one stable
// categorical colour per agent (agentColor). Pure presentation over the host
// theme: no timers, no state, no writes.

import { usePlugin } from "@opencode/plugin/tui"
import type { RGBA } from "@opentui/core"
import { createMemo, For, Show } from "solid-js"
import type { JSX } from "solid-js"
import { truncate } from "./format.js"

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
  children: JSX.Element
}) {
  const context = usePlugin()
  const theme = () => context.theme
  const rightText = createMemo(() => (props.right ? ` ${props.right}` : ""))
  const title = createMemo(() => truncate(props.title, Math.max(1, props.w - rightText().length - 5)))
  const rule = createMemo(() => Math.max(1, props.w - 3 - title().length - 1 - rightText().length))
  const color = createMemo(() => props.titleColor ?? (props.accent ? theme().hue.accent[200] : theme().text.base))
  return (
    <box flexDirection="column" width={props.w} marginBottom={1}>
      <box flexDirection="row" width={props.w}>
        <text wrapMode="none" fg={theme().text.faint}>
          ──{" "}
        </text>
        <text wrapMode="none" fg={color()}>
          <b>{title()}</b>
        </text>
        <text wrapMode="none" fg={theme().text.faint}>{` ${"─".repeat(rule())}`}</text>
        <Show when={props.right}>
          <text wrapMode="none" fg={theme().text.faint}>
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

/** Full-width faint `─` rule, optionally with a centered faint label. */
export function Rule(props: { w: number; label?: string }) {
  const context = usePlugin()
  const theme = () => context.theme
  const line = createMemo(() => {
    const w = Math.max(1, Math.floor(props.w))
    if (!props.label) return "─".repeat(w)
    const label = ` ${truncate(props.label, Math.max(1, w - 2))} `
    if (label.length >= w) return "─".repeat(w)
    const left = Math.floor((w - label.length) / 2)
    return `${"─".repeat(left)}${label}${"─".repeat(w - label.length - left)}`
  })
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
 * `█…░…` bar of `width` cells (capped at 20) as a two-text row: filled cells
 * in `color`, the rest in `dim`. Any value > 0 fills at least one cell.
 * Called as a plain function (`{bar(...)}`), not a component.
 */
export function bar(value: number, max: number, width: number, color: RGBA, dim: RGBA): JSX.Element {
  const cells = Math.min(20, Math.max(0, Math.floor(width)))
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

/** One line `key label · key label`; keys accent, labels faint, cut to w. */
export function KeyHints(props: { items: readonly [string, string][]; w: number }) {
  const context = usePlugin()
  const theme = () => context.theme
  const parts = createMemo(() => {
    const out: { key: string; label: string }[] = []
    let used = 0
    for (const [key, label] of props.items) {
      const need = (out.length > 0 ? 3 : 0) + key.length + 1 + label.length
      if (used + need > props.w) break
      out.push({ key, label })
      used += need
    }
    if (out.length === 0 && props.items.length > 0) {
      const [key, label] = props.items[0]!
      out.push({ key, label: truncate(label, Math.max(1, props.w - key.length - 1)) })
    }
    return out
  })
  return (
    <box flexDirection="row" width={props.w}>
      <For each={parts()}>
        {(part, index) => (
          <box flexDirection="row">
            <text wrapMode="none" fg={theme().text.faint}>
              {index() === 0 ? "" : " · "}
            </text>
            <text wrapMode="none" fg={theme().hue.accent[200]}>
              {part.key}
            </text>
            <text wrapMode="none" fg={theme().text.faint}>{` ${part.label}`}</text>
          </box>
        )}
      </For>
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
