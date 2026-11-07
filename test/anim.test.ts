import { describe, expect, test } from "bun:test"
import { pulseLevel, treeRail } from "../src/anim.ts"

describe("treeRail", () => {
  test("inactive, last child", () => {
    const rows = treeRail({ rows: 5, join: 2, last: true, active: false, phase: 0, w: 3 })
    expect(rows.map((r) => r.text)).toEqual(["│  ", "│  ", "└──", "   ", "   "])
    expect(rows.every((r) => !r.lit)).toBe(true)
  })

  test("inactive, still has siblings below", () => {
    const rows = treeRail({ rows: 5, join: 2, last: false, active: false, phase: 0, w: 3 })
    expect(rows[3]?.text).toBe("│  ")
    expect(rows[4]?.text).toBe("│  ")
    expect(rows.every((r) => !r.lit)).toBe(true)
  })

  test("active packet climbs from the top row", () => {
    const first = treeRail({ rows: 5, join: 2, last: true, active: true, phase: 0, w: 3 })
    expect(first[0]).toEqual({ text: "●  ", lit: true })

    const second = treeRail({ rows: 5, join: 2, last: true, active: true, phase: 1, w: 3 })
    expect(second[0]).toEqual({ text: "•  ", lit: true })
    expect(second[1]).toEqual({ text: "●  ", lit: true })
  })

  test("active head on the join row keeps the corner glyph", () => {
    const rows = treeRail({ rows: 5, join: 2, last: false, active: true, phase: 2, w: 3 })
    expect(rows[2]).toEqual({ text: "├●─", lit: true })
    expect(rows[1]).toEqual({ text: "•  ", lit: true })
  })

  test("every row is exactly w cells wide", () => {
    for (const w of [2, 3, 5]) {
      for (const last of [true, false]) {
        for (const active of [true, false]) {
          for (let phase = 0; phase < 6; phase++) {
            const rows = treeRail({ rows: 4, join: 2, last, active, phase, w })
            for (const row of rows) expect(row.text.length).toBe(w)
          }
        }
      }
    }
  })

  test("join on row 0 keeps the corner with the head", () => {
    const rows = treeRail({ rows: 1, join: 0, last: false, active: true, phase: 0, w: 3 })
    expect(rows.map((r) => r.text)).toEqual(["├●─"])
  })
})

describe("pulseLevel", () => {
  test("starts at the middle of the pulse", () => {
    expect(pulseLevel(0)).toBe(0.5)
  })

  test("stays within 0..1 across a full period", () => {
    for (let tick = 0; tick <= 40; tick++) {
      const level = pulseLevel(tick)
      expect(level).toBeGreaterThanOrEqual(0)
      expect(level).toBeLessThanOrEqual(1)
    }
  })
})
