import { describe, expect, test } from "bun:test"
import { cmdVerb, shortPath } from "../src/format.ts"

const CWD = "/Volumes/MyDrive/git/work/zeus_mobile"
const HOME = "/Users/thien"

describe("shortPath", () => {
  test("cwd prefix collapses to ./", () => {
    expect(shortPath(`${CWD}/lib/main.dart`, { cwd: CWD })).toBe("./lib/main.dart")
  })

  test("home prefix collapses to ~", () => {
    expect(shortPath(`${HOME}/dev/project/file.ts`, { home: HOME })).toBe("~/dev/project/file.ts")
  })

  test("macOS temp folders collapse to $TMP", () => {
    expect(shortPath("/private/var/folders/mp/abc123/T/opencode/session.log")).toBe("$TMP/opencode/session.log")
    expect(shortPath("/var/folders/mp/abc123/T/opencode/session.log")).toBe("$TMP/opencode/session.log")
  })

  test("long paths elide the middle", () => {
    expect(shortPath(`${CWD}/lib/core/routes/app_routes_getx.dart`, { max: 40 })).toBe("/…/routes/app_routes_getx.dart")
  })

  test("output never exceeds max", () => {
    const deep =
      "/private/var/folders/mp/m02xbvb54j13_bk8trdhs6380000gp/T/opencode/some/very/deep/nest/with_a_really_long_file_name.dart"
    for (const max of [10, 20, 30, 59]) {
      expect(shortPath(deep, { max }).length).toBeLessThanOrEqual(max)
    }
  })

  test("short relative paths come back unchanged", () => {
    expect(shortPath("lib/main.dart")).toBe("lib/main.dart")
    expect(shortPath("lib/main.dart", { cwd: CWD, home: HOME, max: 5 })).toBe("lib/main.dart")
  })
})

describe("cmdVerb", () => {
  test("plain command with flags", () => {
    expect(cmdVerb("git -C /some/path status")).toBe("git")
  })

  test("skips set flags and cd chains", () => {
    expect(cmdVerb("set -e cd /a && bun test")).toBe("bun")
    expect(cmdVerb("cd /a && bun test")).toBe("bun")
  })

  test("skips env assignments", () => {
    expect(cmdVerb("FOO=1 flutter build apk")).toBe("flutter")
  })

  test("stops at the first pipe segment", () => {
    expect(cmdVerb("rg foo . | head")).toBe("rg")
  })

  test("empty input", () => {
    expect(cmdVerb("")).toBe("")
    expect(cmdVerb("   ")).toBe("")
  })

  test("bare subcommand", () => {
    expect(cmdVerb("npm run build")).toBe("npm")
  })
})
