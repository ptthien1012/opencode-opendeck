import { describe, expect, test } from "bun:test"
import { DEFAULT_CONFIG, parseConfig } from "../src/config.ts"

describe("parseConfig", () => {
  test("non-object input returns a fresh copy of the defaults", () => {
    for (const raw of [undefined, null, "x", 7, [1, 2]]) {
      const config = parseConfig(raw)
      expect(config).toEqual(DEFAULT_CONFIG)
      expect(config).not.toBe(DEFAULT_CONFIG)
      expect(config.panels).not.toBe(DEFAULT_CONFIG.panels)
    }
  })

  test("valid fields are honoured", () => {
    expect(parseConfig({ animations: false }).animations).toBe(false)
    expect(parseConfig({ doneLimit: 5 }).doneLimit).toBe(5)
    expect(parseConfig({ gitLogLimit: 50 }).gitLogLimit).toBe(50)
    expect(parseConfig({ gitLogLimit: 2000 }).gitLogLimit).toBe(2000)
    expect(parseConfig({ gitWrite: true }).gitWrite).toBe(true)
    expect(parseConfig({ panels: { stats: false } }).panels.stats).toBe(false)
    expect(parseConfig({ panels: { files: false } }).panels.files).toBe(false)
  })

  test("invalid values fall back to the default", () => {
    expect(parseConfig({ animations: "no" }).animations).toBe(true)
    expect(parseConfig({ gitWrite: "yes" }).gitWrite).toBe(false)
    for (const doneLimit of [0, 101, 1.5, "12", null]) {
      expect(parseConfig({ doneLimit }).doneLimit).toBe(DEFAULT_CONFIG.doneLimit)
    }
    for (const gitLogLimit of [49, 2001, 12.5]) {
      expect(parseConfig({ gitLogLimit }).gitLogLimit).toBe(DEFAULT_CONFIG.gitLogLimit)
    }
  })

  test("panels is merged field by field", () => {
    expect(parseConfig({ panels: { charts: false, errors: "yes" } }).panels).toEqual({
      stats: true,
      charts: false,
      errors: true,
      files: true,
    })
    expect(parseConfig({ panels: null }).panels).toEqual(DEFAULT_CONFIG.panels)
  })
})
