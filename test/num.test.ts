import { describe, expect, test } from "bun:test"
import { clamp01, fixed1 } from "../src/num.ts"

describe("clamp01", () => {
  test("clamps to 0..1", () => {
    expect(clamp01(-1)).toBe(0)
    expect(clamp01(0.4)).toBe(0.4)
    expect(clamp01(1)).toBe(1)
    expect(clamp01(2)).toBe(1)
  })
})

describe("fixed1", () => {
  test("one decimal, trailing .0 dropped", () => {
    expect(fixed1(1)).toBe("1")
    expect(fixed1(1.25)).toBe("1.3")
    expect(fixed1(944.6)).toBe("944.6")
    expect(fixed1(2.04)).toBe("2")
  })
})
