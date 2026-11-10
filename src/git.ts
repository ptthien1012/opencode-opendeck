/**
 * Git data access + pure parsers.
 *
 * Layer A (pure, unit-tested): parse `git log --graph`, `git status --porcelain=v1 -z`,
 * `git diff --numstat -z`, build/flatten a file tree, split a multi-file patch.
 * Layer B (runtime, defensive, never throws): spawn git via Bun.
 */

declare const Bun: any
declare const process: { env: Record<string, string | undefined> }
declare const setTimeout: (cb: () => void, ms: number) => unknown
declare const clearTimeout: (id: unknown) => void

// ---------------------------------------------------------------------------
// Layer A — pure parsers
// ---------------------------------------------------------------------------

export type GraphCommit = {
  graph: string
  hash?: string
  short?: string
  parents: string[]
  author?: string
  relTime?: string
  refs: string[]
  subject?: string
}

/**
 * Parse `git log --graph --date-order --format=%x1f%H%x1f%h%x1f%P%x1f%an%x1f%ar%x1f%D%x1f%s`.
 * Lines without \x1f are graph-only connector lines (graph = whole line, no hash).
 */
export function parseGraphLog(out: string): GraphCommit[] {
  const commits: GraphCommit[] = []
  for (const line of out.split("\n")) {
    if (line === "") continue
    const sep = line.indexOf("\x1f")
    if (sep < 0) {
      commits.push({ graph: line, parents: [], refs: [] })
      continue
    }
    const graph = line.slice(0, sep).trimEnd()
    const fields = line.slice(sep + 1).split("\x1f")
    const [hash, short, parentsRaw, author, relTime, refsRaw, subject] = fields
    commits.push({
      graph,
      hash,
      short,
      parents: parentsRaw ? parentsRaw.split(" ").filter((p) => p !== "") : [],
      author,
      relTime,
      refs: refsRaw ? refsRaw.split(", ").filter((r) => r !== "") : [],
      subject,
    })
  }
  return commits
}

export type StatusEntry = {
  file: string
  index: string
  work: string
  status: "added" | "deleted" | "modified" | "renamed" | "untracked" | "conflict"
  staged: boolean
  orig?: string
}

const UNMERGED = new Set(["UU", "AA", "DD", "AU", "UA", "DU", "UD"])

/**
 * Parse `git status --porcelain=v1 -z` output (NUL separated; renames `R  new\0old\0`).
 */
export function parseStatusZ(out: string): StatusEntry[] {
  const entries: StatusEntry[] = []
  if (out === "") return entries
  const tokens = out.split("\0").filter((t) => t.length > 0)
  let i = 0
  while (i < tokens.length) {
    const tok = tokens[i]!
    i++
    if (tok.length < 3) continue // defensive: not a valid record
    const index = tok[0]!
    const work = tok[1]!
    const file = tok.slice(3)
    let orig: string | undefined
    if ((index === "R" || index === "C") && i < tokens.length) {
      orig = tokens[i]
      i++
    }
    const xy = index + work
    let status: StatusEntry["status"]
    if (index === "?" && work === "?") status = "untracked"
    else if (UNMERGED.has(xy)) status = "conflict"
    else if (index === "A" || work === "A") status = "added"
    else if (index === "D" || work === "D") status = "deleted"
    else if (index === "R" || work === "R" || index === "C" || work === "C") status = "renamed"
    else status = "modified"
    entries.push({
      file,
      index,
      work,
      status,
      staged: index !== " " && index !== "?",
      orig,
    })
  }
  return entries
}

export type NumStat = { file: string; additions: number; deletions: number }

const numOrZero = (s: string): number => {
  const n = Number(s)
  return Number.isFinite(n) ? n : 0
}

/**
 * Parse `git diff --numstat -z` output: `adds\tdels\tpath\0`, renames
 * `adds\tdels\t\0old\0new\0` (file = new path), binary `-\t-\t` → 0/0.
 */
export function parseNumstatZ(out: string): NumStat[] {
  const stats: NumStat[] = []
  if (out === "") return stats
  const tokens = out.split("\0")
  let i = 0
  while (i < tokens.length) {
    const tok = tokens[i]!
    i++
    const t1 = tok.indexOf("\t")
    const t2 = t1 >= 0 ? tok.indexOf("\t", t1 + 1) : -1
    if (t2 < 0) continue // defensive: not a stat line
    const additions = numOrZero(tok.slice(0, t1))
    const deletions = numOrZero(tok.slice(t1 + 1, t2))
    const path = tok.slice(t2 + 1)
    if (path === "") {
      // Rename record: old\0new\0 — the stat line carries an empty path.
      const next = tokens[i]
      const after = tokens[i + 1]
      if (after !== undefined) {
        i += next !== undefined ? 1 : 0
        i++
        stats.push({ file: after, additions, deletions })
      }
      continue
    }
    stats.push({ file: path, additions, deletions })
  }
  return stats
}

export type TreeNode = {
  name: string
  path: string
  dir: boolean
  depth: number
  additions: number
  deletions: number
  status?: string
  children: TreeNode[]
}

/**
 * Directory tree from file paths (+ optional status/counts).
 * Dirs before files, both alphabetical. Single-child directory chains are
 * collapsed into one node named "a/b/c"; depth reflects the compacted tree.
 * Dir additions/deletions = sum of descendants.
 */
export function buildTree(
  files: readonly { file: string; additions?: number; deletions?: number; status?: string }[],
): TreeNode[] {
  const root: TreeNode = { name: "", path: "", dir: true, depth: 0, additions: 0, deletions: 0, children: [] }
  for (const f of files) {
    const parts = f.file.split("/")
    let cur = root
    for (let i = 0; i + 1 < parts.length; i++) {
      const seg = parts[i]!
      let next: TreeNode | undefined
      for (const c of cur.children) {
        if (c.dir && c.name === seg) {
          next = c
          break
        }
      }
      if (!next) {
        next = { name: seg, path: parts.slice(0, i + 1).join("/"), dir: true, depth: 0, additions: 0, deletions: 0, children: [] }
        cur.children.push(next)
      }
      cur = next
    }
    cur.children.push({
      name: parts[parts.length - 1] ?? f.file,
      path: f.file,
      dir: false,
      depth: 0,
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
      status: f.status,
      children: [],
    })
  }

  const sortRec = (nodes: TreeNode[]): void => {
    nodes.sort((a, b) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1
      if (a.name < b.name) return -1
      if (a.name > b.name) return 1
      return 0
    })
    for (const n of nodes) sortRec(n.children)
  }
  sortRec(root.children)

  const compact = (nodes: readonly TreeNode[]): TreeNode[] => {
    const out: TreeNode[] = []
    for (const raw of nodes) {
      if (!raw.dir) {
        out.push(raw)
        continue
      }
      let node: TreeNode = { ...raw, children: compact(raw.children) }
      while (node.children.length === 1 && node.children[0]!.dir) {
        const child = node.children[0]!
        node = { ...node, name: `${node.name}/${child.name}`, path: child.path, children: child.children }
      }
      out.push(node)
    }
    return out
  }

  const sumRec = (n: TreeNode): void => {
    if (!n.dir) return
    let additions = 0
    let deletions = 0
    for (const c of n.children) {
      sumRec(c)
      additions += c.additions
      deletions += c.deletions
    }
    n.additions = additions
    n.deletions = deletions
  }

  const depthRec = (nodes: readonly TreeNode[], depth: number): void => {
    for (const n of nodes) {
      n.depth = depth
      depthRec(n.children, depth + 1)
    }
  }

  const result = compact(root.children)
  for (const n of result) sumRec(n)
  depthRec(result, 0)
  return result
}

/**
 * Flatten for rendering (pre-order), skipping children of collapsed dirs.
 * `collapsed` is a set of dir paths.
 */
export function flattenTree(nodes: readonly TreeNode[], collapsed: ReadonlySet<string>): TreeNode[] {
  const out: TreeNode[] = []
  const walk = (list: readonly TreeNode[]): void => {
    for (const n of list) {
      out.push(n)
      if (n.dir && !collapsed.has(n.path)) walk(n.children)
    }
  }
  walk(nodes)
  return out
}

/**
 * Split a multi-file unified patch on lines starting `diff --git a/`.
 * Key = path from `+++ b/<path>`, or `--- a/<path>` when +++ is /dev/null.
 */
export function splitPatchByFile(patch: string): Map<string, string> {
  const map = new Map<string, string>()
  if (patch === "") return map
  const lines = patch.split("\n")
  const starts: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.startsWith("diff --git a/")) starts.push(i)
  }
  for (let c = 0; c < starts.length; c++) {
    const s = starts[c]!
    const e = c + 1 < starts.length ? starts[c + 1]! : lines.length
    // Header region only: stop at the first hunk or binary payload so hunk
    // body lines can never be mistaken for ---/+++ headers.
    let headerEnd = s
    while (headerEnd < e) {
      const line = lines[headerEnd]!
      if (line.startsWith("@@") || line.startsWith("GIT binary patch") || line.startsWith("Binary files ")) break
      headerEnd++
    }
    let plus: string | undefined
    let minus: string | undefined
    for (let i = s; i < headerEnd; i++) {
      const line = lines[i]!
      if (plus === undefined && line.startsWith("+++ ")) plus = line
      else if (minus === undefined && line.startsWith("--- a/")) minus = line
      if (plus !== undefined && minus !== undefined) break
    }
    let key: string | undefined
    if (plus !== undefined && plus.startsWith("+++ b/")) key = plus.slice(6).trimEnd()
    else if (minus !== undefined) key = minus.slice(6).trimEnd()
    if (key === undefined || key === "") continue
    map.set(key, lines.slice(s, e).join("\n"))
  }
  return map
}

export type GitFileDiff = {
  file: string
  patch: string
  additions: number
  deletions: number
  status: "added" | "deleted" | "modified"
  staged?: boolean
  untracked?: boolean
}

/** Totals for a one-line working-tree summary (untracked files count as files with 0/0). */
export type WorkingSummary = { files: number; additions: number; deletions: number }

export function summarizeWorking(files: readonly GitFileDiff[]): WorkingSummary {
  let additions = 0
  let deletions = 0
  for (const f of files) {
    additions += f.additions
    deletions += f.deletions
  }
  return { files: files.length, additions, deletions }
}

/** Write actions the diff page can run (opt-in via the gitWrite option). */
export type GitWriteAction = "stage" | "unstage" | "stage-all" | "discard" | "commit"
export type GitWriteTarget = { file?: string; status?: GitFileDiff["status"]; untracked?: boolean; message?: string }

/**
 * argv for one write action, or undefined when the target is incomplete.
 * File paths come from `git status` (repo-root relative) while git runs with
 * `-C <session dir>` (maybe a subdirectory), so every pathspec is anchored at
 * the repo top and taken literally: `:(top,literal)<path>`.
 */
export function gitWriteArgs(action: GitWriteAction, target: GitWriteTarget): string[] | undefined {
  const hasFile = typeof target.file === "string" && target.file !== ""
  const file = `:(top,literal)${target.file ?? ""}`
  switch (action) {
    case "stage":
      return hasFile ? ["add", "--", file] : undefined
    case "unstage":
      return hasFile ? ["restore", "--staged", "--", file] : undefined
    case "stage-all":
      return ["add", "-A"]
    case "discard":
      if (!hasFile) return undefined
      if (target.untracked) return ["clean", "-f", "--", file]
      if (target.status === "added") return ["rm", "-f", "--", file]
      return ["restore", "--source=HEAD", "--staged", "--worktree", "--", file]
    case "commit": {
      const message = typeof target.message === "string" ? target.message.trim() : ""
      return message !== "" ? ["commit", "-m", message] : undefined
    }
  }
  return undefined
}

/** Whether a repo-relative git path was edited by an agent (agent paths may be absolute). */
export function isAgentPath(gitPath: string, agentPaths: ReadonlySet<string>): boolean {
  if (gitPath === "") return false
  if (agentPaths.has(gitPath)) return true
  const suffix = "/" + gitPath
  for (const p of agentPaths) {
    if (p.endsWith(suffix)) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Layer B — runtime wrappers (defensive, never throw)
// ---------------------------------------------------------------------------

export type GitResult = { ok: true; out: string } | { ok: false; error: string }

const brief = (err: unknown, max = 200): string => {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.trim().slice(0, max)
}

export async function git(cwd: string, args: string[], timeoutMs = 4000): Promise<GitResult> {
  if (typeof Bun === "undefined" || typeof Bun.spawn !== "function") {
    return { ok: false, error: "git unavailable" }
  }
  let proc: any
  try {
    proc = Bun.spawn(["git", "-C", cwd, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", LC_ALL: "C" },
    })
  } catch (err) {
    return { ok: false, error: brief(err) }
  }
  const stdoutText: Promise<string> =
    proc.stdout != null ? Bun.readableStreamToText(proc.stdout) : Promise.resolve("")
  const stderrText: Promise<string> =
    proc.stderr != null ? Bun.readableStreamToText(proc.stderr) : Promise.resolve("")
  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = { flag: false }
  try {
    timer = setTimeout(() => {
      timedOut.flag = true
      try {
        proc.kill()
      } catch {
        // already gone
      }
    }, timeoutMs)
    const [code, out, errOut] = await Promise.all([proc.exited, stdoutText, stderrText])
    if (timedOut.flag) return { ok: false, error: "git timed out" }
    if (code !== 0) {
      const msg = (typeof errOut === "string" ? errOut : "").trim().slice(0, 200)
      return { ok: false, error: msg !== "" ? msg : `git exited with code ${code}` }
    }
    return { ok: true, out: typeof out === "string" ? out : "" }
  } catch (err) {
    if (timedOut.flag) return { ok: false, error: "git timed out" }
    return { ok: false, error: brief(err) }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export async function loadGraph(cwd: string, limit = 200): Promise<GraphCommit[] | string> {
  const res = await git(cwd, [
    "log",
    "--graph",
    "--date-order",
    `--max-count=${limit}`,
    "--all",
    "--format=%x1f%H%x1f%h%x1f%P%x1f%an%x1f%ar%x1f%D%x1f%s",
  ])
  if (!res.ok) return res.error
  return parseGraphLog(res.out)
}

export async function loadCommitFiles(cwd: string, hash: string): Promise<GitFileDiff[] | string> {
  const statRes = await git(cwd, ["show", "--format=", "--numstat", "-z", "--find-renames", hash])
  if (!statRes.ok) return statRes.error
  const stats = parseNumstatZ(statRes.out)
  const patchRes = await git(cwd, ["show", "--format=", "--patch", "--no-color", "--find-renames", hash])
  const patches = patchRes.ok ? splitPatchByFile(patchRes.out) : new Map<string, string>()
  const out: GitFileDiff[] = []
  for (const st of stats) {
    const patch = patches.get(st.file) ?? ""
    let status: GitFileDiff["status"] = "modified"
    if (/^new file mode/m.test(patch)) status = "added"
    else if (/^deleted file mode/m.test(patch)) status = "deleted"
    out.push({ file: st.file, patch, additions: st.additions, deletions: st.deletions, status })
  }
  return out
}

export async function loadWorking(cwd: string): Promise<GitFileDiff[] | string> {
  const statusRes = await git(cwd, ["status", "--porcelain=v1", "-z"])
  if (!statusRes.ok) return statusRes.error
  const entries = parseStatusZ(statusRes.out)

  let statRes = await git(cwd, ["diff", "--numstat", "-z", "HEAD"])
  if (!statRes.ok) statRes = await git(cwd, ["diff", "--numstat", "-z"])
  const stats = statRes.ok ? parseNumstatZ(statRes.out) : []
  const statMap = new Map(stats.map((s) => [s.file, s]))

  let patchRes = await git(cwd, ["diff", "--no-color", "HEAD"])
  if (!patchRes.ok) patchRes = await git(cwd, ["diff", "--no-color"])
  const patches = patchRes.ok ? splitPatchByFile(patchRes.out) : new Map<string, string>()

  const out: GitFileDiff[] = []
  for (const e of entries) {
    if (e.status === "untracked") {
      out.push({ file: e.file, patch: "", additions: 0, deletions: 0, status: "added", untracked: true })
      continue
    }
    const st = statMap.get(e.file)
    const status: GitFileDiff["status"] =
      e.status === "added" ? "added" : e.status === "deleted" ? "deleted" : "modified"
    out.push({
      file: e.file,
      patch: patches.get(e.file) ?? "",
      additions: st?.additions ?? 0,
      deletions: st?.deletions ?? 0,
      status,
      staged: e.staged,
    })
  }
  return out
}

/**
 * Counts-only working-tree summary for the sidebar: `status` + `diff --numstat`
 * (no patch text), so frequent refreshes stay cheap.
 */
export async function loadWorkingSummary(cwd: string): Promise<WorkingSummary | string> {
  const statusRes = await git(cwd, ["status", "--porcelain=v1", "-z"])
  if (!statusRes.ok) return statusRes.error
  const entries = parseStatusZ(statusRes.out)
  let statRes = await git(cwd, ["diff", "--numstat", "-z", "HEAD"])
  if (!statRes.ok) statRes = await git(cwd, ["diff", "--numstat", "-z"])
  const stats = statRes.ok ? parseNumstatZ(statRes.out) : []
  let additions = 0
  let deletions = 0
  for (const st of stats) {
    additions += st.additions
    deletions += st.deletions
  }
  return { files: entries.length, additions, deletions }
}

/** Current branch name via git (fallback when the host has no vcs info). */
export async function loadBranch(cwd: string): Promise<string | undefined> {
  const res = await git(cwd, ["branch", "--show-current"])
  if (!res.ok) return undefined
  const branch = res.out.trim()
  return branch !== "" ? branch : undefined
}

/** Run one write action; returns undefined on success, else a short error. */
export async function runGitWrite(cwd: string, action: GitWriteAction, target: GitWriteTarget): Promise<string | undefined> {
  const args = gitWriteArgs(action, target)
  if (args === undefined) return "invalid git action"
  const res = await git(cwd, args, action === "commit" ? 15_000 : 4_000)
  return res.ok ? undefined : res.error
}
