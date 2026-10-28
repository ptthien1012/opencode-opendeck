/** @jsxImportSource @opentui/solid */
// Help page (plugin route "opendeck-help"): every shortcut per page plus the
// symbol legend — two columns at >=100 cols, stacked below. ?/q/esc returns
// to the page it was opened from (deck.helpBack). Static content only: no
// fetches, no timers. Borderless Grok-CLI style like the other pages.

import { usePlugin } from "@opencode/plugin/tui"
import type { BoxRenderable } from "@opentui/core"
import { createMemo, createSignal, onMount, Show } from "solid-js"
import { truncate } from "./format.js"
import type { Deck } from "./state.js"
import { KeyHints, Rule, Section, glyph } from "./ui.js"

// Fixed legend slots: keys get 12 cells, symbols 8 — rows line up.
const KEY_W = 12
const SYM_W = 8
// Two columns only once both halves are wide enough for the longest rows.
const TWO_COL_MIN = 100

/** Fit `text` into exactly `width` cells. */
function fit(text: string, width: number, alignRight = false): string {
  const w = Math.max(0, Math.floor(width))
  const cut = truncate(text, w)
  const pad = " ".repeat(Math.max(0, w - cut.length))
  return alignRight ? pad + cut : cut + pad
}

// Left column: one row per page with its keys.
const NAV_ROWS: [string, string][] = [
  ["/opendeck", "open the dashboard"],
  ["1-4", "dashboard tabs"],
  ["t", "cards/lanes"],
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

export function HelpView(props: { deck: Deck; sessionID?: string }) {
  const context = usePlugin()
  const theme = () => context.theme

  let rootRef: BoxRenderable | undefined
  const [measured, setMeasured] = createSignal(0)
  onMount(() => setMeasured(rootRef?.width ?? context.renderer.terminalWidth ?? 120))
  const W = createMemo(() => Math.max(60, (measured() || context.renderer.terminalWidth || 120) - 2))
  const twoCols = createMemo(() => W() >= TWO_COL_MIN)
  const colW = createMemo(() => (twoCols() ? Math.floor((W() - 2) / 2) : W()))

  /** One legend row: accent `left` in a fixed slot, muted `right` after it. */
  function legendRow(left: string, right: string, slot: number, w: number) {
    return (
      <box flexDirection="row" width={Math.max(1, w)}>
        <text wrapMode="none" flexShrink={0} fg={theme().hue.accent[200]}>{fit(left, slot)}</text>
        <text wrapMode="none" flexShrink={0} fg={theme().text.muted}>{fit(right, Math.max(0, w - slot))}</text>
      </box>
    )
  }

  function section(title: string, rows: readonly [string, string][], slot: number, w: number) {
    return (
      <Section title={title} w={w}>
        {rows.map(([left, right]) => legendRow(left, right, slot, w - 2))}
      </Section>
    )
  }

  function leftColumn(w: number) {
    return (
      <>
        {section("navigation", NAV_ROWS, KEY_W, w)}
        {section("diff page", DIFF_ROWS, KEY_W, w)}
        {section("git log", GIT_ROWS, KEY_W, w)}
        {section("usage", USAGE_ROWS, KEY_W, w)}
      </>
    )
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
          <text wrapMode="none" flexShrink={0} fg={theme().text.faint}>every page · symbol legend</text>
        </box>
        <Rule w={W()} />
      </box>
      {/* Keyed on the column width: every resize re-fits the fixed slots. */}
      <Show when={colW()} keyed>
        {(w: number) =>
          twoCols() ? (
            <box flexDirection="row" gap={2} width={W()}>
              <box flexDirection="column" width={w}>{leftColumn(w)}</box>
              <box flexDirection="column" width={w}>{section("symbols", SYMBOL_ROWS, SYM_W, w)}</box>
            </box>
          ) : (
            <box flexDirection="column" width={W()}>
              {leftColumn(w)}
              {section("symbols", SYMBOL_ROWS, SYM_W, w)}
            </box>
          )
        }
      </Show>
      <KeyHints items={[["q/esc/?", "back"]]} w={W()} />
    </box>
  )
}
