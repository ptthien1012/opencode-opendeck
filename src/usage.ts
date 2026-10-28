// Pure helpers for the usage page: date-keyed activity → heatmap grid and
// braille line chart, model rows, token shares. No Solid, no host access;
// unit-tested in test/usage.test.ts.

import type { SessionStatsActivity, SessionStatsModelUsage, TokenUsageInfo } from "@opencode/client"

export type UsageRange = "30d" | "90d" | "1y"

export const RANGE_DAYS: Record<UsageRange, number> = { "30d": 30, "90d": 90, "1y": 365 }

const DAY_MS = 86_400_000

/** Local calendar date "YYYY-MM-DD" of a ms timestamp. */
export function dayKey(ms: number): string {
  const d = new Date(ms)
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${d.getFullYear()}-${m}-${day}`
}

/** One value per calendar day from `days` days ago up to `now` (oldest first), 0 when missing. */
export function dailySeries(activity: readonly SessionStatsActivity[], days: number, now: number): { date: string; value: number }[] {
  const byDate = new Map<string, number>()
  for (const item of activity) byDate.set(item.date, (byDate.get(item.date) ?? 0) + item.steps)
  const out: { date: string; value: number }[] = []
  for (let i = Math.max(1, days) - 1; i >= 0; i--) {
    const date = dayKey(now - i * DAY_MS)
    out.push({ date, value: byDate.get(date) ?? 0 })
  }
  return out
}

/** Intensity level 0..4 of a value against the series max (0 only when value is 0). */
export function level(value: number, max: number): 0 | 1 | 2 | 3 | 4 {
  if (!(value > 0) || !(max > 0)) return 0
  const ratio = value / max
  if (ratio > 0.75) return 4
  if (ratio > 0.5) return 3
  if (ratio > 0.25) return 2
  return 1
}

/**
 * GitHub-style heatmap: 7 rows (Mon..Sun) × N week columns, oldest week
 * left. Cells before the first day / after today are -1 (blank). Values are
 * intensity levels 0..4.
 */
export function heatmapGrid(series: readonly { date: string; value: number }[]): number[][] {
  const rows: number[][] = Array.from({ length: 7 }, () => [])
  if (series.length === 0) return rows
  const max = Math.max(0, ...series.map((item) => item.value))
  const first = series[0]!
  const [y, m, d] = first.date.split("-").map(Number)
  // Monday = 0 … Sunday = 6
  const startDow = (new Date(y!, (m ?? 1) - 1, d ?? 1).getDay() + 6) % 7
  const cells: number[] = [...Array<number>(startDow).fill(-1), ...series.map((item) => level(item.value, max))]
  while (cells.length % 7 !== 0) cells.push(-1)
  for (let i = 0; i < cells.length; i++) rows[i % 7]!.push(cells[i]!)
  return rows
}

/** Downsample `values` to `width` buckets by summing (keeps totals honest). */
export function bucket(values: readonly number[], width: number): number[] {
  const w = Math.max(1, Math.floor(width))
  if (values.length <= w) return [...values]
  const out = new Array<number>(w).fill(0)
  for (let i = 0; i < values.length; i++) out[Math.min(w - 1, Math.floor((i * w) / values.length))]! += values[i]!
  return out
}

// Braille dot bits: left column rows 0..3 = 0x01,0x02,0x04,0x40; right = 0x08,0x10,0x20,0x80.
const LEFT = [0x01, 0x02, 0x04, 0x40] as const
const RIGHT = [0x08, 0x10, 0x20, 0x80] as const

/**
 * Braille area chart: `rows` text lines, each char holds 2 values (2 columns
 * × 4 dot rows), filled from the bottom up to each value's height. Width in
 * chars = ceil(values / 2). Top line first.
 */
export function brailleChart(values: readonly number[], rows: number, max?: number): string[] {
  const lines = Math.max(1, Math.floor(rows))
  const dots = lines * 4
  const top = max ?? Math.max(0, ...values)
  const heights = values.map((v) => (top > 0 && v > 0 ? Math.max(1, Math.round((Math.min(v, top) / top) * dots)) : 0))
  const chars = Math.ceil(heights.length / 2)
  const out: string[] = []
  for (let line = 0; line < lines; line++) {
    // dot rows covered by this text line, counted from the bottom
    const base = (lines - 1 - line) * 4
    let text = ""
    for (let c = 0; c < chars; c++) {
      let bits = 0
      for (const [side, mask] of [
        [heights[c * 2] ?? 0, LEFT],
        [heights[c * 2 + 1] ?? 0, RIGHT],
      ] as const) {
        for (let r = 0; r < 4; r++) {
          // r = 0 is the top dot of the cell; filled when height reaches it
          const fromBottom = base + (3 - r) + 1
          if (side >= fromBottom) bits |= mask[r]!
        }
      }
      text += String.fromCharCode(0x2800 + bits)
    }
    out.push(text)
  }
  return out
}

/** --- Tokens & models ---------------------------------------------------- */

export function tokenTotal(tokens: TokenUsageInfo): number {
  return tokens.input + tokens.output + tokens.reasoning + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0)
}

/** Shares of the total (0..1) per token kind. */
export function tokenShares(tokens: TokenUsageInfo): { input: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number } {
  const total = tokenTotal(tokens)
  const share = (n: number) => (total > 0 ? n / total : 0)
  return {
    input: share(tokens.input),
    cacheRead: share(tokens.cache?.read ?? 0),
    cacheWrite: share(tokens.cache?.write ?? 0),
    output: share(tokens.output),
    reasoning: share(tokens.reasoning),
  }
}

/** Cache read / (input + cache read + cache write), 0..1. */
export function cacheHit(tokens: TokenUsageInfo): number {
  const read = tokens.cache?.read ?? 0
  const all = tokens.input + read + (tokens.cache?.write ?? 0)
  return all > 0 ? read / all : 0
}

export type ModelRow = {
  key: string
  id: string
  provider: string
  variant?: string
  steps: number
  total: number
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  reasoning: number
  cost: number
}

/** One row per model (+variant), sorted by total tokens desc. */
export function modelRows(models: readonly SessionStatsModelUsage[]): ModelRow[] {
  const rows = models.map((item): ModelRow => {
    const variant = (item.model as { variant?: string }).variant
    return {
      key: `${item.model.providerID}/${item.model.id}${variant ? `#${variant}` : ""}`,
      id: item.model.id,
      provider: item.model.providerID,
      variant,
      steps: item.steps,
      total: tokenTotal(item.tokens),
      input: item.tokens.input,
      cacheRead: item.tokens.cache?.read ?? 0,
      cacheWrite: item.tokens.cache?.write ?? 0,
      output: item.tokens.output,
      reasoning: item.tokens.reasoning,
      cost: item.cost,
    }
  })
  return rows.sort((a, b) => b.total - a.total)
}

/** 1234 → "1.2k", 944_600_000 → "944.6M", 1_200_000_000 → "1.2B". */
export function compact(value: number): string {
  const abs = Math.abs(value)
  const fmt = (n: number, unit: string) => `${n.toFixed(1).replace(/\.0$/, "")}${unit}`
  if (abs >= 1e9) return fmt(value / 1e9, "B")
  if (abs >= 1e6) return fmt(value / 1e6, "M")
  if (abs >= 1e3) return fmt(value / 1e3, "k")
  return `${Math.round(value)}`
}
