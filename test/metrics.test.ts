import { describe, expect, test } from "bun:test"
import {
  cacheShare,
  diffFromTools,
  executeTarget,
  formatDuration,
  formatRate,
  hbar,
  recentErrors,
  sessionStats,
  sparkline,
  splitPatch,
  tokRate,
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

describe("tokRate", () => {
  test("empty input gives undefined last and avg", () => {
    expect(tokRate([])).toEqual({ last: undefined, avg: undefined })
  })
  test("output plus reasoning over the streamed time", () => {
    const messages = [assistant({ tokens: tokens(0, 100, 0, 0, 20), time: { created: 0, completed: 2_000 } })]
    expect(tokRate(messages)).toEqual({ last: 60, avg: 60 })
  })
  test("messages without completed time are ignored", () => {
    const messages = [
      assistant({ tokens: tokens(0, 100), time: { created: 0 } }),
      assistant({ tokens: tokens(0, 50), time: { created: 1_000, completed: 2_000 } }),
    ]
    expect(tokRate(messages)).toEqual({ last: 50, avg: 50 })
  })
  test("messages under minMs are ignored", () => {
    const messages = [
      assistant({ tokens: tokens(0, 100), time: { created: 0, completed: 100 } }),
      assistant({ tokens: tokens(0, 30), time: { created: 1_000, completed: 2_000 } }),
    ]
    expect(tokRate(messages)).toEqual({ last: 30, avg: 30 })
    expect(tokRate(messages, 100)).toEqual({ last: 30, avg: 130 / 1.1 })
  })
  test("avg is time-weighted and last comes from the newest message", () => {
    const messages = [
      assistant({ tokens: tokens(0, 100), time: { created: 2_000, completed: 5_000 } }),
      assistant({ tokens: tokens(0, 100), time: { created: 0, completed: 1_000 } }),
    ]
    const rate = tokRate(messages)
    expect(rate.avg).toBe(50)
    expect(rate.last).toBeCloseTo(100 / 3)
  })
})

describe("formatRate", () => {
  test("undefined, one decimal under 10, rounded above", () => {
    expect(formatRate(undefined)).toBe("–")
    expect(formatRate(7.44)).toBe("7.4")
    expect(formatRate(0)).toBe("0.0")
    expect(formatRate(42.4)).toBe("42")
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

describe("diffFromTools", () => {
  // One completed edit part carrying metadata.files, like the real edit tool.
  const edit = (files: unknown, created: number, id = "p") => ({
    sessionID: "s",
    part: tool("edit", { status: "completed", input: {}, metadata: { files } }, created, id),
  })
  test("merges two edits on the same file: sums counts, joins patches", () => {
    const out = diffFromTools([
      edit([{ file: "lib/a.dart", patch: "@@ first", additions: 2, deletions: 1, status: "modified" }], 1, "p1"),
      edit([{ file: "lib/a.dart", patch: "@@ second", additions: 3, deletions: 4, status: "modified" }], 2, "p2"),
    ])
    expect(out).toEqual([{ file: "lib/a.dart", patch: "@@ first\n@@ second", additions: 5, deletions: 5, status: "modified" }])
  })
  test("skips non-completed parts and parts without metadata.files", () => {
    const entries = [
      { sessionID: "s", part: tool("edit", { status: "running", input: {} }, 1, "p1") },
      { sessionID: "s", part: tool("edit", { status: "streaming", input: "" }, 2, "p2") },
      { sessionID: "s", part: tool("edit", { status: "completed", input: {} }, 3, "p3") },
      { sessionID: "s", part: tool("edit", { status: "completed", input: {}, metadata: { truncated: true } }, 4, "p4") },
      {
        sessionID: "s",
        part: tool(
          "edit",
          { status: "error", input: {}, error: { type: "t", message: "x" }, metadata: { files: [{ file: "x.ts" }] } },
          5,
          "p5",
        ),
      },
      edit([{ file: "ok.ts", patch: "", additions: 1, deletions: 0, status: "added" }], 6, "p6"),
    ]
    expect(diffFromTools(entries)).toEqual([{ file: "ok.ts", patch: "", additions: 1, deletions: 0, status: "added" }])
  })
  test("bad file items are ignored; defaults fill missing fields", () => {
    const out = diffFromTools([edit([null, "x", 42, { file: 7 }, { patch: "no file" }, { file: "" }, { file: "b.ts" }], 1)])
    expect(out).toEqual([{ file: "b.ts", patch: "", additions: 0, deletions: 0, status: "modified" }])
  })
  test("walks oldest first: first-seen order even when entries arrive newest-first, input untouched", () => {
    const entries = [
      edit([{ file: "c.ts", patch: "pc", additions: 1, deletions: 0, status: "modified" }], 3, "p3"),
      edit([{ file: "a.ts", patch: "pa", additions: 1, deletions: 0, status: "added" }], 1, "p1"),
      edit([{ file: "b.ts", patch: "pb", additions: 1, deletions: 0, status: "modified" }], 2, "p2"),
    ]
    expect(diffFromTools(entries).map((file) => file.file)).toEqual(["a.ts", "b.ts", "c.ts"])
    expect(entries.map((entry) => entry.part.time.created)).toEqual([3, 1, 2])
  })
  test("status merge: first 'added' sticks unless a later part deletes the file", () => {
    const kept = diffFromTools([
      edit([{ file: "n.ts", patch: "p1", additions: 5, deletions: 0, status: "added" }], 1, "p1"),
      edit([{ file: "n.ts", patch: "p2", additions: 1, deletions: 1, status: "modified" }], 2, "p2"),
    ])
    expect(kept[0]?.status).toBe("added")
    const deleted = diffFromTools([
      edit([{ file: "n.ts", patch: "p1", additions: 5, deletions: 0, status: "added" }], 1, "p1"),
      edit([{ file: "n.ts", patch: "", additions: 0, deletions: 5, status: "deleted" }], 2, "p2"),
    ])
    expect(deleted[0]?.status).toBe("deleted")
    expect(deleted[0]?.patch).toBe("p1")
  })
})

describe("splitPatch", () => {
  test("simple modify: 4 file rows, one hunk, paired del/add, context on both sides", () => {
    const patch = [
      "diff --git a/file.txt b/file.txt",
      "index 1234567..89abcde 100644",
      "--- a/file.txt",
      "+++ b/file.txt",
      "@@ -21,3 +21,3 @@",
      " line21",
      "-a",
      "+b",
      " line23",
    ].join("\n")
    expect(splitPatch(patch)).toEqual({
      rows: [
        { type: "file", text: "diff --git a/file.txt b/file.txt" },
        { type: "file", text: "index 1234567..89abcde 100644" },
        { type: "file", text: "--- a/file.txt" },
        { type: "file", text: "+++ b/file.txt" },
        { type: "hunk", text: "@@ -21,3 +21,3 @@" },
        { type: "line", left: { no: 21, text: "line21", kind: "ctx" }, right: { no: 21, text: "line21", kind: "ctx" } },
        { type: "line", left: { no: 22, text: "a", kind: "del" }, right: { no: 22, text: "b", kind: "add" } },
        { type: "line", left: { no: 23, text: "line23", kind: "ctx" }, right: { no: 23, text: "line23", kind: "ctx" } },
      ],
      hunks: [4],
    })
  })

  test("uneven runs pair row by row; extra del rows leave the right side undefined", () => {
    const patch = ["@@ -10,4 +10,3 @@", " ctx", "-x", "-y", "+z", " tail"].join("\n")
    expect(splitPatch(patch)).toEqual({
      rows: [
        { type: "hunk", text: "@@ -10,4 +10,3 @@" },
        { type: "line", left: { no: 10, text: "ctx", kind: "ctx" }, right: { no: 10, text: "ctx", kind: "ctx" } },
        { type: "line", left: { no: 11, text: "x", kind: "del" }, right: { no: 11, text: "z", kind: "add" } },
        { type: "line", left: { no: 12, text: "y", kind: "del" }, right: undefined },
        { type: "line", left: { no: 13, text: "tail", kind: "ctx" }, right: { no: 12, text: "tail", kind: "ctx" } },
      ],
      hunks: [0],
    })
  })

  test("pure add hunk: left side stays undefined, right numbers run 1,2", () => {
    const patch = [
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1,2 @@",
      "+a",
      "+b",
    ].join("\n")
    const { rows, hunks } = splitPatch(patch)
    expect(hunks).toEqual([4])
    expect(rows.length).toBe(7)
    expect(rows.slice(5)).toEqual([
      { type: "line", left: undefined, right: { no: 1, text: "a", kind: "add" } },
      { type: "line", left: undefined, right: { no: 2, text: "b", kind: "add" } },
    ])
  })

  test("two hunks give two indexes; '\\ No newline at end of file' is skipped", () => {
    const patch = [
      "diff --git a/f.txt b/f.txt",
      "index 111..222 100644",
      "--- a/f.txt",
      "+++ b/f.txt",
      "@@ -1,3 +1,3 @@",
      " one",
      "-two",
      "+two!",
      " three",
      "@@ -8,3 +8,3 @@",
      " eight",
      "-nine",
      "+nine!",
      " ten",
      "\\ No newline at end of file",
    ].join("\n")
    const { rows, hunks } = splitPatch(patch)
    expect(hunks).toEqual([4, 8])
    expect(rows.length).toBe(12)
    expect(rows[8]).toEqual({ type: "hunk", text: "@@ -8,3 +8,3 @@" })
    expect(rows[11]).toEqual({
      type: "line",
      left: { no: 10, text: "ten", kind: "ctx" },
      right: { no: 10, text: "ten", kind: "ctx" },
    })
    expect(JSON.stringify(rows)).not.toContain("No newline")
  })

  test("empty patch gives empty rows and hunks", () => {
    expect(splitPatch("")).toEqual({ rows: [], hunks: [] })
  })
})
