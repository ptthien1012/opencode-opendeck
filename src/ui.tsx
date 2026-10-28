/** @jsxImportSource @opentui/solid */
// Shared Grok-CLI-style UI primitives: borderless sections headed by a title
// rule line, ▰▱ gauges, ▌ status markers and one-line key hints. Minimal and
// monochrome — text.base/muted/faint plus a single accent (hue.accent[200]).
// Pure presentation over the host theme: no timers, no state, no writes.

import { usePlugin } from "@opencode/plugin/tui"
import type { RGBA } from "@opentui/core"
import { createMemo, For, Show } from "solid-js"
import type { JSX } from "solid-js"
import { truncate } from "./format.js"

/**
 * A section = `── title ──────── right` rule line, then children indented by
 * 2 spaces. Title is bold text.base (accent when props.accent, or an explicit
 * titleColor), rule chars are faint, right label muted. Total header width is
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
          <text wrapMode="none" fg={theme().text.muted}>
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
    <box flexDirection="row">
      <text wrapMode="none" fg={theme().hue.accent[200]}>{"▰".repeat(filled())}</text>
      <text wrapMode="none" fg={theme().text.faint}>{"▱".repeat(cells() - filled())}</text>
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

export const glyph = {
  running: "●",
  done: "✓",
  error: "✗",
  idle: "○",
  interrupted: "⚠",
  main: "◆",
}
