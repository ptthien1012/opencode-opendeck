import { describe, expect, test } from "bun:test"
import {
  cacheShare,
  executeTarget,
  filesTouched,
  formatDuration,
  hbar,
  recentErrors,
  sessionStats,
  sparkline,
  toolState,
  turnSeries,
} from "../src/metrics.ts"

// Minimal fixtures shaped like @opencode/client messages; cast at the edge.
const tokens = (input: number, output: number, read = 0, write = 0, reasoning = 0) => ({
  input,
  output,
  reasoning,
  cache: { read, write },
})
const assistant = (over: Record<string, unknown>) =>
  ({ type: "assistant", id: "m", agent: "a", model: { id: "x", providerID: "p" }, content: [], time: { created: 0 }, ...over }) as any
const tool = (name: string, state: Record<string, unknown>, created = 0, id = "p") =>
  ({ type: "tool", id, name, state, time: { created } }) as any

describe("sparkline", () => {
  test("scales to the max and keeps the last width values", () => {
    expect(sparkline([0, 1, 2, 4, 8], 5)).toBe(" ▁▂▄█")
    expect(sparkline([1, 2, 3, 8], 2)).toBe("▃█")
  })
  test("empty input or zero width gives an empty string", () => {
    expect(sparkline([], 5)).toBe("")
    expect(sparkline([1, 2], 0)).toBe("")
  })
  test("fixed max caps values", () => {
    expect(sparkline([50, 100, 200], 3, 100)).toBe("▄██")
  })
})

describe("hbar", () => {
  test("fills proportionally and at least one cell for small values", () => {
    expect(hbar(5, 10, 10)).toBe("█████░░░░░")
    expect(hbar(1, 100, 10)).toBe("█░░░░░░░░░")
    expect(hbar(0, 10, 4)).toBe("░░░░")
    expect(hbar(3, 0, 3)).toBe("█░░")
  })
})

describe("formatDuration", () => {
  test("seconds, minutes, hours", () => {
    expect(formatDuration(45_000)).toBe("45s")
    expect(formatDuration(44 * 60_000 + 34_000)).toBe("44m")
    expect(formatDuration(65 * 60_000)).toBe("1h05m")
    expect(formatDuration(-5)).toBe("0s")
  })
})

describe("tokens", () => {
  const messages = [
    assistant({ tokens: tokens(4, 300, 90, 6, 28), time: { created: 1 } }),
    assistant({ time: { created: 2 } }),
    assistant({ tokens: tokens(0, 0), time: { created: 3 } }),
    assistant({ tokens: tokens(10, 50), time: { created: 4 } }),
  ]
  test("turnSeries folds cache into input and reasoning into output, skips empty turns", () => {
    expect(turnSeries(messages)).toEqual([
      { input: 100, output: 328, ctx: 428, created: 1 },
      { input: 10, output: 50, ctx: 60, created: 4 },
    ])
  })
  test("cacheShare is cached / all input", () => {
    expect(cacheShare(messages)).toBeCloseTo(96 / 110)
    expect(cacheShare([])).toBe(0)
  })
})

describe("sessionStats", () => {
  test("counts prompts, replies, compactions, duration, tps and cache hit", () => {
    const list = [
      { type: "user", time: { created: 1_000 } },
      assistant({ tokens: tokens(10, 100, 30), time: { created: 2_000, completed: 4_000 } }),
      { type: "compaction", time: { created: 5_000 } },
      { type: "user", time: { created: 6_000 } },
      assistant({ tokens: tokens(0, 100, 60), time: { created: 7_000, completed: 9_000 } }),
    ] as any
    const stats = sessionStats(list)
    expect(stats.prompts).toBe(2)
    expect(stats.replies).toBe(2)
    expect(stats.compactions).toBe(1)
    expect(stats.durationMs).toBe(8_000)
    expect(stats.tps).toBe(50)
    expect(stats.cacheHit).toBeCloseTo(90 / 100)
  })
  test("empty list", () => {
    expect(sessionStats(undefined)).toEqual({ prompts: 0, replies: 0, durationMs: 0, tps: undefined, cacheHit: 0, compactions: 0 })
  })
})

describe("tool calls", () => {
  test("executeTarget extracts server.tool from code-mode bodies", () => {
    expect(executeTarget(tool("execute", { status: "completed", input: { code: `await tools.finder["index-status"]({})` } }))).toBe(
      "finder.index-status",
    )
    expect(executeTarget(tool("execute", { status: "running", input: { code: "tools.tavily.tavily_search({})" } }))).toBe(
      "tavily.tavily_search",
    )
    expect(executeTarget(tool("execute", { status: "running", input: { code: "const t = tools['context7']" } }))).toBe("context7")
    expect(executeTarget(tool("execute", { status: "streaming", input: "tools.finder" }))).toBeUndefined()
    expect(executeTarget(tool("shell", { status: "completed", input: { command: "ls" } }))).toBeUndefined()
    expect(executeTarget(tool("execute", { status: "completed", input: { code: "return 1" } }))).toBeUndefined()
  })
  test("toolState marks cut-off calls as interrupted", () => {
    expect(toolState(tool("x", { status: "running", input: {} }), true)).toBe("running")
    expect(toolState(tool("x", { status: "running", input: {} }), false)).toBe("interrupted")
    expect(toolState(tool("x", { status: "streaming", input: "" }), false)).toBe("interrupted")
    expect(toolState(tool("x", { status: "error", input: {}, error: { type: "t", message: "m" } }), false)).toBe("error")
    expect(toolState(tool("x", { status: "completed", input: {}, content: [] }), true)).toBe("done")
  })
  test("recentErrors keeps errors only, newest first, one-line messages", () => {
    const entries = [
      { sessionID: "a", part: tool("shell", { status: "error", input: {}, error: { type: "t", message: "boom\n  at x" } }, 1, "p1") },
      { sessionID: "b", part: tool("read", { status: "completed", input: {}, content: [] }, 2, "p2") },
      { sessionID: "b", part: tool("edit", { status: "error", input: {}, error: { type: "t", message: "no match" } }, 3, "p3") },
    ]
    expect(recentErrors(entries, 5)).toEqual([
      { sessionID: "b", name: "edit", message: "no match", created: 3, partID: "p3" },
      { sessionID: "a", name: "shell", message: "boom at x", created: 1, partID: "p1" },
    ])
    expect(recentErrors(entries, 1).length).toBe(1)
  })
})

describe("filesTouched", () => {
  test("unique files in first-seen order", () => {
    const messages = [
      assistant({ snapshot: { files: ["a.ts", "b.ts"] } }),
      assistant({}),
      assistant({ snapshot: { files: ["b.ts", "c.ts"] } }),
    ]
    expect(filesTouched(messages)).toEqual(["a.ts", "b.ts", "c.ts"])
  })
})
