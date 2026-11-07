/** @jsxImportSource @opentui/solid */
// Help page (plugin route "opendeck-help"): every shortcut per page plus the
// symbol legend, in one flat scrolled column (j/k) so the page fits narrow
// terminals and lists every key. ?/q/esc returns to the page it was opened
// from (deck.helpBack). Static content only: no fetches, no timers.
// Borderless Grok-CLI style like the other pages.

import { usePlugin } from "@opencode/plugin/tui"
import type { BoxRenderable } from "@opentui/core"
import { createMemo, createSignal, For, onMount, Show } from "solid-js"
import { fit, truncate } from "./format.js"
import type { Deck } from "./state.js"
import { KeyHints, Rule, glyph } from "./ui.js"

// Fixed legend slots: keys get 12 cells, symbols 8 — rows line up.
const KEY_W = 12
const SYM_W = 8

// Left column: one row per page with its keys.
const NAV_ROWS: [string, string][] = [
  ["/opendeck", "open the dashboard"],
  ["1-4", "dashboard tabs"],
  ["t", "cards/lanes"],
  ["j/k", "select agent (agents tab)"],
  ["enter", "open selected agent"],
  ["f", "files/diff"],
  ["l", "git log"],
  ["u", "usage"],
  ["?", "help"],
  ["q/esc", "back"],
]

const DIFF_ROWS: [string, string][] = [
  ["j/k", "file"],
  ["enter", "open"],
  ["h", "collapse parent"],
  ["tab", "pane"],
  ["1/2/3", "edits/git/log"],
  ["s", "split/unified"],
  ["space/b", "page"],
  ["n/p", "hunk"],
  ["g/G", "top/bottom"],
  ["r", "refresh git"],
  ["ctrl+d/u", "half page"],
  ["l / →", "open"],
  ["h / ←", "collapse"],
  ["q", "close"],
  ["esc", "back"],
]

const GIT_ROWS: [string, string][] = [
  ["j/k", "select"],
  ["enter", "files"],
  ["space/b", "page"],
  ["g/G", "top/bottom"],
  ["r", "reload"],
  ["esc", "back"],
]

const USAGE_ROWS: [string, string][] = [
  ["1/2/3", "30d/90d/1y"],
  ["p", "all/project"],
  ["j/k", "models"],
  ["r", "reload"],
  ["esc", "back"],
]

// Right column: the symbol legend. Status glyphs come from the shared glyph
// map so the legend cannot drift from what the views actually render.
const SYMBOL_ROWS: [string, string][] = [
  ["▰ ▱", "gauge filled/empty"],
  ["█ ░", "bar"],
  ["▌", "current row"],
  [glyph.main, "orchestrator/main"],
  [glyph.running, "running"],
  [glyph.idle, "idle"],
  [glyph.done, "done"],
  [glyph.error, "failed"],
  [glyph.interrupted, "interrupted"],
  ["A M D ?", "file added/modified/deleted/untracked"],
  ["⎇", "branch"],
  ["[HEAD→x]", "git ref"],
]

// Flat page rows: section titles and legend rows are single lines, so the
// page can scroll one row at a time on any width or terminal height.
type HelpRow =
  | { kind: "blank" }
  | { kind: "title"; title: string }
  | { kind: "row"; left: string; right: string; slot: number }

const SECTIONS: readonly { title: string; rows: readonly [string, string][]; slot: number }[] = [
  { title: "navigation", rows: NAV_ROWS, slot: KEY_W },
  { title: "diff page", rows: DIFF_ROWS, slot: KEY_W },
  { title: "git log", rows: GIT_ROWS, slot: KEY_W },
  { title: "usage", rows: USAGE_ROWS, slot: KEY_W },
  { title: "symbols", rows: SYMBOL_ROWS, slot: SYM_W },
]

const ROWS: readonly HelpRow[] = SECTIONS.flatMap((s, index) => [
  ...(index > 0 ? [{ kind: "blank" } as HelpRow] : []),
  { kind: "title", title: s.title } as HelpRow,
  ...s.rows.map(([left, right]) => ({ kind: "row", left, right, slot: s.slot }) as HelpRow),
])

export function HelpView(props: { deck: Deck; sessionID?: string }) {
  const context = usePlugin()
  const theme = () => context.theme
  const deck = props.deck

  let rootRef: BoxRenderable | undefined
  const [measured, setMeasured] = createSignal(0)
  onMount(() => setMeasured(rootRef?.width ?? context.renderer.terminalWidth ?? 120))
  const W = createMemo(() => Math.max(48, (measured() || context.renderer.terminalWidth || 120) - 2))
  // Header (2) + its gap (1) + the hints line (1) are fixed; the rest scrolls.
  const height = createMemo(() => Math.max(5, (context.renderer.terminalHeight ?? 40) - 5))
  // Offset is raw state; clamp it here because the view owns the row count.
  const offset = createMemo(() => Math.min(deck.helpScroll(), Math.max(0, ROWS.length - height())))
  const visible = createMemo(() => ROWS.slice(offset(), offset() + height()))
  const more = createMemo(() => offset() + height() < ROWS.length)
  const indicator = createMemo(() => `${offset() > 0 ? "↑ " : ""}${more() ? "↓ more (j/k)" : ""}`.trim())

  /** One legend row: accent `left` in a fixed slot, muted `right` after it. */
  function legendRow(left: string, right: string, slot: number) {
    const w = W()
    return (
      <box flexDirection="row" width={w} paddingLeft={2}>
        <text wrapMode="none" flexShrink={0} fg={theme().hue.accent[200]}>{fit(left, slot)}</text>
        <text wrapMode="none" flexShrink={0} fg={theme().text.muted}>{fit(right, Math.max(0, w - 2 - slot))}</text>
      </box>
    )
  }

  /** Section header line, same look as the shared Section rule. */
  function titleRow(title: string) {
    const label = truncate(title, Math.max(1, W() - 5))
    const rule = "─".repeat(Math.max(1, W() - 5 - label.length))
    return (
      <box flexDirection="row" width={W()}>
        <text wrapMode="none" flexShrink={0} fg={theme().text.faint}>{"── "}</text>
        <text wrapMode="none" flexShrink={0} fg={theme().text.base}><b>{label}</b></text>
        <text wrapMode="none" flexShrink={0} fg={theme().text.faint}>{` ${rule}`}</text>
      </box>
    )
  }

  function renderRow(row: HelpRow) {
    if (row.kind === "blank") return <text wrapMode="none" fg={theme().text.faint}>{" "}</text>
    if (row.kind === "title") return titleRow(row.title)
    return legendRow(row.left, row.right, row.slot)
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
      <box flexDirection="column" width="100%" marginBottom={1}>
        <box flexDirection="row" gap={1} width="100%">
          <text wrapMode="none" flexShrink={0} fg={theme().hue.accent[200]}>
            <b>{`${glyph.main} opendeck · help`}</b>
          </text>
          {/* Subtitle only when the header row has the cells for it. */}
          <Show when={W() >= 60}>
            <text wrapMode="none" flexShrink={0} fg={theme().text.faint}>every page · symbol legend</text>
          </Show>
        </box>
        <Rule w={W()} />
      </box>
      <box flexDirection="column" width={W()}>
        <For each={visible()}>{(row) => renderRow(row)}</For>
      </box>
      <Show when={more() || offset() > 0}>
        <text wrapMode="none" fg={theme().text.faint}>{indicator()}</text>
      </Show>
      <KeyHints items={[["q/esc/?", "back"]]} w={W()} />
    </box>
  )
}
