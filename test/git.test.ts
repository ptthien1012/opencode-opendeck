import { describe, expect, test } from "bun:test"
import {
  buildTree,
  flattenTree,
  gitWriteArgs,
  isAgentPath,
  parseGraphLog,
  parseNumstatZ,
  parseStatusZ,
  splitPatchByFile,
  summarizeWorking,
} from "../src/git.ts"

// ---------------------------------------------------------------------------
// parseGraphLog
// ---------------------------------------------------------------------------

describe("parseGraphLog", () => {
  const log = [
    "* \x1fh1\x1fs1\x1fp1 p2\x1fAlice\x1f2 hours ago\x1fHEAD -> main, origin/main, tag: v1\x1ffix bug",
    "|\\",
    "| * \x1fh2\x1fs2\x1fh1\x1fBob\x1f3 days ago\x1f\x1fadd feature",
    "* \x1fh3\x1fs3\x1f\x1fRoot\x1f1 year ago\x1f\x1finit",
    "",
  ].join("\n")

  test("parses commit lines with all fields", () => {
    const cs = parseGraphLog(log)
    expect(cs).toHaveLength(4)
    expect(cs[0]).toMatchObject({
      graph: "*",
      hash: "h1",
      short: "s1",
      parents: ["p1", "p2"],
      author: "Alice",
      relTime: "2 hours ago",
      refs: ["HEAD -> main", "origin/main", "tag: v1"],
      subject: "fix bug",
    })
  })

  test("connector lines have no hash and empty parents/refs", () => {
    const cs = parseGraphLog(log)
    expect(cs[1]).toEqual({ graph: "|\\", parents: [], refs: [] })
    expect(cs[1]!.hash).toBeUndefined()
  })

  test("empty %D and %P yield empty arrays", () => {
    const cs = parseGraphLog(log)
    expect(cs[2]).toMatchObject({ graph: "| *", refs: [] })
    expect(cs[3]).toMatchObject({ parents: [], refs: [], subject: "init" })
  })

  test("empty input yields no commits", () => {
    expect(parseGraphLog("")).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// parseStatusZ
// ---------------------------------------------------------------------------

describe("parseStatusZ", () => {
  const out =
    "M  src/a.ts\0 M src/b.ts\0?? notes.txt\0R  src/new.ts\0src/old.ts\0UU merge.txt\0"

  test("staged and unstaged modified", () => {
    const es = parseStatusZ(out)
    expect(es).toHaveLength(5)
    expect(es[0]).toEqual({ file: "src/a.ts", index: "M", work: " ", status: "modified", staged: true })
    expect(es[1]).toEqual({ file: "src/b.ts", index: " ", work: "M", status: "modified", staged: false })
  })

  test("untracked", () => {
    expect(parseStatusZ(out)[2]).toEqual({
      file: "notes.txt",
      index: "?",
      work: "?",
      status: "untracked",
      staged: false,
    })
  })

  test("rename carries orig path", () => {
    expect(parseStatusZ(out)[3]).toEqual({
      file: "src/new.ts",
      index: "R",
      work: " ",
      status: "renamed",
      staged: true,
      orig: "src/old.ts",
    })
  })

  test("conflict", () => {
    expect(parseStatusZ(out)[4]).toEqual({
      file: "merge.txt",
      index: "U",
      work: "U",
      status: "conflict",
      staged: true,
    })
  })

  test("empty input yields no entries", () => {
    expect(parseStatusZ("")).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// parseNumstatZ
// ---------------------------------------------------------------------------

describe("parseNumstatZ", () => {
  test("normal, binary and rename records", () => {
    const ns = parseNumstatZ("10\t2\tsrc/a.ts\0-\t-\timg.png\0" + "5\t0\t\0old.ts\0new.ts\0")
    expect(ns).toEqual([
      { file: "src/a.ts", additions: 10, deletions: 2 },
      { file: "img.png", additions: 0, deletions: 0 },
      { file: "new.ts", additions: 5, deletions: 0 },
    ])
  })

  test("empty input yields no stats", () => {
    expect(parseNumstatZ("")).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// buildTree
// ---------------------------------------------------------------------------

describe("buildTree", () => {
  const tree = buildTree([
    { file: "src/git.ts", additions: 3, deletions: 1 },
    { file: "src/deep/nested/a.ts", additions: 1, deletions: 0 },
    { file: "src/deep/nested/b.ts", additions: 2, deletions: 2, status: "modified" },
    { file: "README.md", additions: 5, deletions: 5 },
    { file: "a/b/c/d.txt", additions: 4, deletions: 0 },
  ])

  test("dirs before files, alphabetical, chains collapsed", () => {
    expect(tree.map((n) => [n.name, n.dir])).toEqual([
      ["a/b/c", true],
      ["src", true],
      ["README.md", false],
    ])
    const src = tree[1]!
    expect(src.children.map((c) => [c.name, c.dir])).toEqual([
      ["deep/nested", true],
      ["git.ts", false],
    ])
    const nested = src.children[0]!
    expect(nested.children.map((c) => c.name)).toEqual(["a.ts", "b.ts"])
  })

  test("depth and path reflect the compacted tree", () => {
    const abc = tree[0]!
    expect(abc.path).toBe("a/b/c")
    expect(abc.depth).toBe(0)
    expect(abc.children[0]).toMatchObject({ name: "d.txt", path: "a/b/c/d.txt", depth: 1 })
    const src = tree[1]!
    expect(src.depth).toBe(0)
    expect(src.children[0]).toMatchObject({ path: "src/deep/nested", depth: 1 })
    expect(src.children[0]!.children[0]).toMatchObject({ path: "src/deep/nested/a.ts", depth: 2 })
  })

  test("dir additions/deletions sum descendants, files keep own counts + status", () => {
    expect(tree[0]!.additions).toBe(4)
    expect(tree[0]!.deletions).toBe(0)
    const src = tree[1]!
    expect(src.additions).toBe(6) // 3 + 1 + 2
    expect(src.deletions).toBe(3) // 1 + 0 + 2
    expect(src.children[0]!.additions).toBe(3) // 1 + 2
    expect(src.children[1]).toMatchObject({ additions: 3, deletions: 1 })
    expect(src.children[0]!.children[1]).toMatchObject({ status: "modified" })
    expect(tree[2]).toMatchObject({ additions: 5, deletions: 5 })
  })

  test("empty input yields an empty tree", () => {
    expect(buildTree([])).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// flattenTree
// ---------------------------------------------------------------------------

describe("flattenTree", () => {
  const tree = buildTree([
    { file: "src/git.ts", additions: 3, deletions: 1 },
    { file: "src/deep/nested/a.ts", additions: 1, deletions: 0 },
    { file: "src/deep/nested/b.ts", additions: 2, deletions: 2 },
    { file: "README.md", additions: 5, deletions: 5 },
    { file: "a/b/c/d.txt", additions: 4, deletions: 0 },
  ])

  test("pre-order flatten of the full tree", () => {
    const flat = flattenTree(tree, new Set<string>())
    expect(flat.map((n) => n.path)).toEqual([
      "a/b/c",
      "a/b/c/d.txt",
      "src",
      "src/deep/nested",
      "src/deep/nested/a.ts",
      "src/deep/nested/b.ts",
      "src/git.ts",
      "README.md",
    ])
  })

  test("collapsed dir hides its children", () => {
    const flat = flattenTree(tree, new Set(["src"]))
    expect(flat.map((n) => n.path)).toEqual(["a/b/c", "a/b/c/d.txt", "src", "README.md"])
  })
})

// ---------------------------------------------------------------------------
// splitPatchByFile
// ---------------------------------------------------------------------------

describe("splitPatchByFile", () => {
  const patch = [
    "diff --git a/one.ts b/one.ts",
    "index 111..222 100644",
    "--- a/one.ts",
    "+++ b/one.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "diff --git a/gone.ts b/gone.ts",
    "deleted file mode 100644",
    "index 333..000",
    "--- a/gone.ts",
    "+++ /dev/null",
    "@@ -1 +0 @@",
    "-x",
    "",
  ].join("\n")

  test("splits two files and keys them by +++ b/ path", () => {
    const m = splitPatchByFile(patch)
    expect(m.size).toBe(2)
    const one = m.get("one.ts")!
    expect(one.split("\n")[0]).toBe("diff --git a/one.ts b/one.ts")
    expect(one).toContain("--- a/one.ts")
    expect(one).toContain("+new")
    expect(one).not.toContain("diff --git a/gone.ts")
  })

  test("deleted file is keyed by the --- a/ path", () => {
    const m = splitPatchByFile(patch)
    const gone = m.get("gone.ts")!
    expect(gone).toContain("deleted file mode 100644")
    expect(gone.split("\n")[0]).toBe("diff --git a/gone.ts b/gone.ts")
    expect(gone).not.toContain("diff --git a/one.ts")
  })

  test("hunk body lines never act as headers", () => {
    const tricky = [
      "diff --git a/one.ts b/one.ts",
      "--- a/one.ts",
      "+++ b/one.ts",
      "@@ -1,2 +1,2 @@",
      "--- a/trap.ts", // removed line whose content is "-- a/trap.ts"
      "+++ b/trap.ts",
      " context",
      "",
    ].join("\n")
    const m = splitPatchByFile(tricky)
    expect(m.size).toBe(1)
    expect(m.has("one.ts")).toBe(true)
  })

  test("empty patch yields an empty map", () => {
    expect(splitPatchByFile("")).toEqual(new Map())
  })
})

// ---------------------------------------------------------------------------
// summarizeWorking
// ---------------------------------------------------------------------------

describe("summarizeWorking", () => {
  test("empty list is all zeros", () => {
    expect(summarizeWorking([])).toEqual({ files: 0, additions: 0, deletions: 0 })
  })

  test("counts every file and sums +/- including untracked 0/0", () => {
    const s = summarizeWorking([
      { file: "a.ts", patch: "", additions: 3, deletions: 1, status: "modified" },
      { file: "b.ts", patch: "", additions: 10, deletions: 0, status: "added" },
      { file: "c.ts", patch: "", additions: 0, deletions: 7, status: "deleted" },
      { file: "d.ts", patch: "", additions: 0, deletions: 0, status: "added", untracked: true },
    ])
    expect(s).toEqual({ files: 4, additions: 13, deletions: 8 })
  })
})

// ---------------------------------------------------------------------------
// gitWriteArgs
// ---------------------------------------------------------------------------

describe("gitWriteArgs", () => {
  test("stage / unstage / stage-all argv", () => {
    expect(gitWriteArgs("stage", { file: "a.ts" })).toEqual(["add", "--", ":(top,literal)a.ts"])
    expect(gitWriteArgs("unstage", { file: "a.ts" })).toEqual(["restore", "--staged", "--", ":(top,literal)a.ts"])
    expect(gitWriteArgs("stage-all", {})).toEqual(["add", "-A"])
  })

  test("discard branches: untracked, added, modified", () => {
    expect(gitWriteArgs("discard", { file: "u.ts", untracked: true })).toEqual(["clean", "-f", "--", ":(top,literal)u.ts"])
    expect(gitWriteArgs("discard", { file: "n.ts", status: "added" })).toEqual(["rm", "-f", "--", ":(top,literal)n.ts"])
    expect(gitWriteArgs("discard", { file: "m.ts", status: "modified" })).toEqual([
      "restore",
      "--source=HEAD",
      "--staged",
      "--worktree",
      "--",
      ":(top,literal)m.ts",
    ])
  })

  test("pathspecs are anchored at the repo top, so a subdirectory cwd still hits the right file", () => {
    expect(gitWriteArgs("stage", { file: "src/a.ts" })).toEqual(["add", "--", ":(top,literal)src/a.ts"])
    expect(gitWriteArgs("stage", { file: "weird*[name].ts" })).toEqual(["add", "--", ":(top,literal)weird*[name].ts"])
  })

  test("commit message is trimmed", () => {
    expect(gitWriteArgs("commit", { message: "  fix bug  " })).toEqual(["commit", "-m", "fix bug"])
  })

  test("undefined for missing file or empty commit message", () => {
    expect(gitWriteArgs("stage", {})).toBeUndefined()
    expect(gitWriteArgs("stage", { file: "" })).toBeUndefined()
    expect(gitWriteArgs("unstage", {})).toBeUndefined()
    expect(gitWriteArgs("discard", {})).toBeUndefined()
    expect(gitWriteArgs("commit", {})).toBeUndefined()
    expect(gitWriteArgs("commit", { message: "   " })).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// isAgentPath
// ---------------------------------------------------------------------------

describe("isAgentPath", () => {
  test("exact repo-relative match", () => {
    expect(isAgentPath("src/a.ts", new Set(["src/a.ts"]))).toBe(true)
  })

  test("absolute agent path matches by suffix", () => {
    expect(isAgentPath("src/a.ts", new Set(["/repo/src/a.ts"]))).toBe(true)
  })

  test("no false positive on partial filename", () => {
    expect(isAgentPath("b.ts", new Set(["/x/ab.ts"]))).toBe(false)
  })

  test("empty git path is never a match", () => {
    expect(isAgentPath("", new Set(["/x/a.ts"]))).toBe(false)
  })
})
