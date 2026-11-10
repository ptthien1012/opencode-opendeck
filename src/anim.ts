// Frame helpers for the shared animation ticker (see state.ts). Everything
// here is a pure function of a tick phase or a progress value — no timers,
// no state — so the whole plugin runs on ONE interval and renders stay cheap.
//
// Frame/glyph choices follow claude-flightdeck's terminal language: braille
// spinners, `─` rails with a lit packet marching along them, `· → ◦ → ●`
// fan-out launches, `━` frozen bars for finished work.

import { RGBA } from "@opentui/core"
import { clamp01 } from "./num.js"

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
  const clamped = clamp01(t)
  return 1 - Math.pow(1 - clamped, 3)
}

/** Linear RGB blend between two theme colors (t=0 → a, t=1 → b). */
export function mixColor(a: RGBA, b: RGBA, t: number): RGBA {
  const k = clamp01(t)
  return RGBA.fromValues(a.r + (b.r - a.r) * k, a.g + (b.g - a.g) * k, a.b + (b.b - a.b) * k, 1)
}

/**
 * Smooth 0..1 pulse from the shared tick — one full sine per `period` ticks
 * (default 16 ticks ≈ 1.9s at TICK_MS), clamped so callers can scale opacity
 * or brightness straight from it. Pure: the caller owns the clock.
 */
export function pulseLevel(tick: number, period = 16): number {
  const p = period > 0 ? period : 1
  return clamp01((1 + Math.sin((tick / p) * 2 * Math.PI)) / 2)
}

/**
 * Tree-branch rail: one entry per row, each exactly `w` cells wide (min 2) —
 * dim `│` ancestors above the child, `├──`/`└──` at the join row, and blank
 * (last) or `│` (still has siblings below) rows after it. While `active`, a
 * lit packet (head `●`, trail `•`) climbs one row per tick, wrapping at the
 * join row. The join corner glyph is
 * preserved: when the head lands on the join row it sits in cell 1
 * (`├●─`, `└●─`) instead of replacing the corner.
 */
export function treeRail(opts: {
  rows: number
  join: number
  last: boolean
  active: boolean
  phase: number
  w: number
}): { text: string; lit: boolean }[] {
  const rows = Math.max(0, Math.floor(opts.rows))
  const w = Math.max(2, Math.floor(opts.w))
  const join = Math.max(0, Math.floor(opts.join))
  const head = opts.active ? ((opts.phase % (join + 1)) + (join + 1)) % (join + 1) : -1
  const out: { text: string; lit: boolean }[] = []
  for (let row = 0; row < rows; row++) {
    const glyph = row < join ? "│" : row === join ? (opts.last ? "└" : "├") : opts.last ? " " : "│"
    let text = glyph + (row === join ? "─".repeat(w - 1) : " ".repeat(w - 1))
    const lit = opts.active && (row === head || row === head - 1)
    if (lit) {
      if (row === join && row === head) {
        // Keep the join corner (├/└) in cell 0; the packet enters cell 1.
        text = glyph + "●" + "─".repeat(Math.max(0, w - 2))
      } else {
        text = (row === head ? "●" : "•") + text.slice(1)
      }
    }
    out.push({ text, lit })
  }
  return out
}
