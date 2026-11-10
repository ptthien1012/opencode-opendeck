import { describe, expect, test } from "bun:test"
import {
  brailleChart,
  bucket,
  cacheHit,
  compact,
  dailySeries,
  dayKey,
  heatmapGrid,
  level,
  modelRows,
  tokenTotal,
} from "../src/usage.ts"

const tokens = (input: number, output: number, read = 0, write = 0, reasoning = 0) => ({
  input,
  output,
  reasoning,
  cache: { read, write },
})

describe("dailySeries", () => {
  test("one entry per day, oldest first, missing days are 0", () => {
    const now = new Date(2026, 9, 28, 12).getTime()
    const series = dailySeries([{ date: "2026-10-27", steps: 5 }, { date: "2026-10-28", steps: 2 }], 3, now)
    expect(series).toEqual([
      { date: "2026-10-26", value: 0 },
      { date: "2026-10-27", value: 5 },
      { date: "2026-10-28", value: 2 },
    ])
    expect(dayKey(now)).toBe("2026-10-28")
  })
})

describe("level", () => {
  test("0 only for zero, quartiles otherwise", () => {
    expect(level(0, 10)).toBe(0)
    expect(level(1, 10)).toBe(1)
    expect(level(3, 10)).toBe(2)
    expect(level(6, 10)).toBe(3)
    expect(level(10, 10)).toBe(4)
    expect(level(5, 0)).toBe(0)
  })
})

describe("heatmapGrid", () => {
  test("7 rows, Monday first, blank (-1) padding before the first day", () => {
    // 2026-10-28 is a Wednesday → 2 blank cells (Mon, Tue) before it
    const grid = heatmapGrid([
      { date: "2026-10-28", value: 4 },
      { date: "2026-10-29", value: 0 },
    ])
    expect(grid.length).toBe(7)
    expect(grid.map((row) => row[0])).toEqual([-1, -1, 4, 0, -1, -1, -1])
  })
  test("empty series", () => {
    expect(heatmapGrid([]).every((row) => row.length === 0)).toBe(true)
  })
})

describe("bucket", () => {
  test("sums into buckets, passthrough when it fits", () => {
    expect(bucket([1, 2, 3], 5)).toEqual([1, 2, 3])
    expect(bucket([1, 1, 1, 1], 2)).toEqual([2, 2])
  })
})

describe("brailleChart", () => {
  test("full value fills every dot of its column, zero is blank", () => {
    const [line] = brailleChart([4, 0], 1)
    // left column all 4 dots = 0x01|0x02|0x04|0x40 = 0x47
    expect(line).toBe(String.fromCharCode(0x2800 + 0x47))
  })
  test("two rows: half height fills only the bottom line", () => {
    const lines = brailleChart([4, 8], 2, 8)
    expect(lines.length).toBe(2)
    // top line: only right column (8/8) filled → right bits 0x08|0x10|0x20|0x80
    expect(lines[0]).toBe(String.fromCharCode(0x2800 + 0xb8))
    // bottom line: both columns full
    expect(lines[1]).toBe(String.fromCharCode(0x2800 + 0xff))
  })
  test("width is ceil(values / 2)", () => {
    expect(brailleChart([1, 2, 3], 1)[0]!.length).toBe(2)
  })
})

describe("tokens", () => {
  const t = tokens(100, 50, 800, 40, 10)
  test("total, shares and cache hit", () => {
    expect(tokenTotal(t)).toBe(1000)
    expect(cacheHit(t)).toBeCloseTo(800 / 940)
    expect(cacheHit(tokens(0, 5))).toBe(0)
  })
})

describe("modelRows", () => {
  test("keys include variant, sorted by total desc", () => {
    const rows = modelRows([
      { model: { id: "a", providerID: "p" }, steps: 1, tokens: tokens(1, 1), cost: 0 },
      { model: { id: "b", providerID: "p", variant: "max" } as any, steps: 2, tokens: tokens(10, 10, 100), cost: 0.5 },
    ] as any)
    expect(rows.map((row) => row.key)).toEqual(["p/b#max", "p/a"])
    expect(rows[0]!.cacheRead).toBe(100)
  })
})

describe("compact", () => {
  test("k / M / B", () => {
    expect(compact(950)).toBe("950")
    expect(compact(1234)).toBe("1.2k")
    expect(compact(944_600_000)).toBe("944.6M")
    expect(compact(1_200_000_000)).toBe("1.2B")
    expect(compact(2_000_000)).toBe("2M")
  })
})
