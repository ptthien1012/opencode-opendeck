// Frame helpers for the shared animation ticker (see state.ts). Everything
// here is a pure function of a tick phase or a progress value — no timers,
// no state — so the whole plugin runs on ONE interval and renders stay cheap.
//
// Frame/glyph choices follow claude-flightdeck's terminal language: braille
// spinners, `─` rails with a lit packet marching along them, `· → ◦ → ●`
// fan-out launches, `━` frozen bars for finished work.

import { RGBA } from "@opentui/core"

/** Frame-clock resolution: one shared interval in state.ts drives all frames. */
export const TICK_MS = 120

/** Braille spinner, one frame per tick (full cycle ≈ 1.2s). */
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const

export function spinner(tick: number): string {
  return SPINNER[((tick % SPINNER.length) + SPINNER.length) % SPINNER.length] ?? "⠋"
}

/** Subagent fan-out launch frames, ~200ms each. */
const LAUNCH = ["·", "◦", "●"] as const
export const LAUNCH_MS = 600

export function launchFrame(elapsedMs: number): string {
  const index = Math.min(LAUNCH.length - 1, Math.max(0, Math.floor((elapsedMs / LAUNCH_MS) * LAUNCH.length)))
  return LAUNCH[index] ?? "●"
}

/** New-row highlight window (activity rows, permission requests). */
export const FLASH_MS = 1500

/** Context-bar tween duration + easing (easeOutCubic). */
export const TWEEN_MS = 400

export function easeOut(t: number): number {
  const clamped = Math.max(0, Math.min(1, t))
  return 1 - Math.pow(1 - clamped, 3)
}

/**
 * Swimlane flow: a dim `─` line with one lit packet (head `●`, trail `•`)
 * marching left→right, one cell per tick — the inline-lane version of
 * claude-flightdeck's animated rail connectors. Returns coalesced runs of
 * same-colour cells so a 12-cell lane renders as ~3 text nodes per frame.
 */
export function flowRuns(phase: number, width: number): { text: string; lit: boolean }[] {
  const w = Math.max(1, Math.floor(width))
  // Sweep 2 cells past the right edge so the packet fully exits before re-entry.
  const head = ((phase % (w + 2)) + (w + 2)) % (w + 2)
  const runs: { text: string; lit: boolean }[] = []
  for (let i = 0; i < w; i++) {
    const lit = i === head || i === head - 1
    const glyph = i === head ? "●" : i === head - 1 ? "•" : "─"
    const last = runs[runs.length - 1]
    if (last && last.lit === lit) last.text += glyph
    else runs.push({ text: glyph, lit })
  }
  return runs
}

/**
 * Connector rail (claude-flightdeck's card-grid rails): a dim `─` line with
 * `┬` (fan-out) or `┴` (merge) marks at the given cells. While `active`, lit
 * packets (head `●`, trail `•`, two per 24 cells) march left→right, one cell
 * per tick. Returns coalesced runs of same-kind cells so a long rail renders
 * as a handful of text nodes per frame.
 */
export function railRuns(
  phase: number,
  width: number,
  marks: readonly number[],
  merge: boolean,
  active: boolean,
): { text: string; lit: boolean }[] {
  const w = Math.max(1, Math.floor(width))
  const markSet = new Set<number>()
  for (const mark of marks) {
    const cell = Math.floor(mark)
    if (cell >= 0 && cell < w) markSet.add(cell)
  }
  const lit = new Map<number, string>()
  if (active) {
    // Sweep 24 cells past the right edge so packets fully exit before re-entry.
    for (let base = 0; base < w + 24; base += 24) {
      const head = (((base + phase) % (w + 24)) + w + 24) % (w + 24)
      if (head < w) lit.set(head, "●")
      const trail = head - 1
      if (trail >= 0 && trail < w && !lit.has(trail)) lit.set(trail, "•")
    }
  }
  const runs: { text: string; lit: boolean }[] = []
  for (let i = 0; i < w; i++) {
    const litGlyph = lit.get(i)
    const glyph = litGlyph ?? (markSet.has(i) ? (merge ? "┴" : "┬") : "─")
    const last = runs[runs.length - 1]
    if (last && last.lit === (litGlyph !== undefined)) last.text += glyph
    else runs.push({ text: glyph, lit: litGlyph !== undefined })
  }
  return runs
}

/** Linear RGB blend between two theme colors (t=0 → a, t=1 → b). */
export function mixColor(a: RGBA, b: RGBA, t: number): RGBA {
  const k = Math.max(0, Math.min(1, t))
  return RGBA.fromValues(a.r + (b.r - a.r) * k, a.g + (b.g - a.g) * k, a.b + (b.b - a.b) * k, 1)
}
