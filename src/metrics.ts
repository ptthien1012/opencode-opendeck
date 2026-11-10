// Pure metrics and terminal-chart helpers for Opendeck. No Solid, no host
// access, no timers: every function takes plain data and returns plain data,
// so it is unit-tested with `bun test` (test/metrics.test.ts).

import type { FileDiffInfo, SessionMessageAssistant, SessionMessageAssistantTool, SessionMessageInfo } from "@opencode/client"
import { clamp01 } from "./num.js"

/** --- Charts ------------------------------------------------------------- */

const SPARK = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const

/**
 * One-line sparkline of the last `width` values, scaled to `max` (default:
 * the largest shown value). Zero/negative values render as a space, any
 * positive value as at least `▁`.
 */
export function sparkline(values: readonly number[], width: number, max?: number): string {
  const shown = values.slice(-Math.max(1, Math.floor(width)))
  if (width < 1 || shown.length === 0) return ""
  const top = max ?? Math.max(0, ...shown)
  return shown
    .map((value) => {
      if (!(value > 0) || !(top > 0)) return " "
      const level = Math.ceil((Math.min(value, top) / top) * SPARK.length) - 1
      return SPARK[Math.max(0, Math.min(SPARK.length - 1, level))]
    })
    .join("")
}

/** Horizontal bar `█…░…` of `width` cells; any value > 0 fills at least 1 cell. */
export function hbar(value: number, max: number, width: number): string {
  const cells = Math.max(0, Math.floor(width))
  if (cells === 0) return ""
  const ratio = max > 0 ? clamp01(value / max) : 0
  let filled = Math.round(ratio * cells)
  if (value > 0 && filled === 0) filled = 1
  return "█".repeat(filled) + "░".repeat(cells - filled)
}

/** --- Formatting --------------------------------------------------------- */

/** Human duration: "45s" under a minute, "44m" under an hour, then "1h05m". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`
}

/** Tokens/sec for display: "–" when unknown, one decimal under 10, else rounded ("42"). */
export function formatRate(rate: number | undefined): string {
  if (rate === undefined) return "–"
  return rate < 10 ? rate.toFixed(1) : String(Math.round(rate))
}

/** --- Tokens ------------------------------------------------------------- */

export type Turn = { input: number; output: number; ctx: number; created: number }

/**
 * One entry per assistant message that reported token usage, oldest first.
 * `input` folds in cache read+write, `output` folds in reasoning, `ctx` is
 * that turn's context size (input + output).
 */
export function turnSeries(messages: readonly SessionMessageAssistant[]): Turn[] {
  const out: Turn[] = []
  for (const message of messages) {
    const tokens = message.tokens
    if (!tokens) continue
    const input = tokens.input + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0)
    const output = tokens.output + tokens.reasoning
    if (input + output === 0) continue
    out.push({ input, output, ctx: input + output, created: message.time.created })
  }
  return out
}

/** Share of input tokens that came from cache (read+write), 0..1; 0 without input. */
export function cacheShare(messages: readonly SessionMessageAssistant[]): number {
  let cached = 0
  let total = 0
  for (const message of messages) {
    const tokens = message.tokens
    if (!tokens) continue
    const read = tokens.cache?.read ?? 0
    const write = tokens.cache?.write ?? 0
    cached += read + write
    total += tokens.input + read + write
  }
  return total > 0 ? cached / total : 0
}

/**
 * Assistant output speed in tokens per second. Counts generated tokens only
 * (`tokens.output + tokens.reasoning`), never input or cache tokens, so the
 * number reflects how fast the model streamed, not how big the prompt was.
 * Only messages with token usage and a numeric `time.completed` later than
 * `time.created` qualify, and turns shorter than `minMs` (default 500ms) are
 * skipped as too noisy.
 *
 * `last` is the newest qualifying message (by `time.created`); `avg` is
 * time-weighted over all qualifying messages. Both are undefined when nothing
 * qualifies.
 */
export function tokRate(
  messages: readonly SessionMessageAssistant[],
  minMs = 500,
): { last: number | undefined; avg: number | undefined } {
  let genAll = 0
  let msAll = 0
  let lastRate: number | undefined
  let lastCreated = Number.NEGATIVE_INFINITY
  for (const message of messages) {
    const tokens = message.tokens
    if (!tokens) continue
    const end = message.time.completed
    if (typeof end !== "number" || !(end > message.time.created)) continue
    const gen = tokens.output + tokens.reasoning
    const ms = end - message.time.created
    if (gen <= 0 || ms < minMs) continue
    genAll += gen
    msAll += ms
    if (message.time.created > lastCreated) {
      lastCreated = message.time.created
      lastRate = gen / (ms / 1000)
    }
  }
  return { last: lastRate, avg: msAll > 0 ? genAll / (msAll / 1000) : undefined }
}

export type SessionStats = {
  /** user prompts */
  prompts: number
  /** assistant messages */
  replies: number
  /** first message → last activity, ms */
  durationMs: number
  /** output tokens per second of assistant streaming time; undefined when unknown */
  tps: number | undefined
  /** cache read / all input tokens, 0..1 */
  cacheHit: number
  compactions: number
}

/** Session-level numbers for the stats panel, from the raw message list. */
export function sessionStats(list: readonly SessionMessageInfo[] | undefined): SessionStats {
  const items = list ?? []
  let prompts = 0
  let replies = 0
  let compactions = 0
  let first = Number.POSITIVE_INFINITY
  let last = 0
  let outTokens = 0
  let streamMs = 0
  let cacheRead = 0
  let inputAll = 0
  for (const item of items) {
    const created = item.time.created
    if (created < first) first = created
    if (created > last) last = created
    if (item.type === "user") prompts++
    else if (item.type === "compaction") compactions++
    else if (item.type === "assistant") {
      replies++
      const end = item.time.completed
      if (end !== undefined && end > last) last = end
      const tokens = item.tokens
      if (tokens) {
        const read = tokens.cache?.read ?? 0
        cacheRead += read
        inputAll += tokens.input + read + (tokens.cache?.write ?? 0)
        if (end !== undefined && end > created) {
          outTokens += tokens.output + tokens.reasoning
          streamMs += end - created
        }
      }
    }
  }
  return {
    prompts,
    replies,
    durationMs: items.length > 0 && last > first ? last - first : 0,
    tps: streamMs > 0 ? outTokens / (streamMs / 1000) : undefined,
    cacheHit: inputAll > 0 ? cacheRead / inputAll : 0,
    compactions,
  }
}

/** --- Tool calls --------------------------------------------------------- */

const TARGET_RE =
  /tools(?:\.([A-Za-z0-9_-]+)|\[["']([A-Za-z0-9_-]+)["']\])(?:\.([A-Za-z0-9_-]+)|\[["']([A-Za-z0-9_-]+)["']\])?/

/**
 * First MCP call inside a code-mode `execute` body as "server.tool"
 * (e.g. `tools.finder["index-status"]` → "finder.index-status"), "server"
 * when no tool follows, undefined for other tools or while args stream.
 */
export function executeTarget(part: SessionMessageAssistantTool): string | undefined {
  if (part.name !== "execute" || part.state.status === "streaming") return undefined
  const input: unknown = part.state.input
  const code = input !== null && typeof input === "object" ? (input as Record<string, unknown>).code : undefined
  if (typeof code !== "string") return undefined
  const match = code.match(TARGET_RE)
  if (!match) return undefined
  const server = match[1] ?? match[2]
  const tool = match[3] ?? match[4]
  if (!server) return undefined
  return tool ? `${server}.${tool}` : server
}

export type ToolState = "running" | "interrupted" | "error" | "done"

/**
 * Display state of a tool call. A call still marked running/streaming while
 * its session is no longer running was cut off and will never finish.
 */
export function toolState(part: SessionMessageAssistantTool, sessionRunning: boolean): ToolState {
  const status = part.state.status
  if (status === "running" || status === "streaming") return sessionRunning ? "running" : "interrupted"
  if (status === "error") return "error"
  return "done"
}

export type ToolError = { sessionID: string; name: string; message: string; created: number; partID: string }

/** Errored tool calls, newest first, at most `limit`, message squashed to one line. */
export function recentErrors(
  entries: readonly { part: SessionMessageAssistantTool; sessionID: string }[],
  limit: number,
): ToolError[] {
  const out: ToolError[] = []
  for (const { part, sessionID } of entries) {
    if (part.state.status !== "error") continue
    const raw = part.state.error?.message ?? "error"
    out.push({
      sessionID,
      name: part.name,
      message: raw.replace(/\s+/g, " ").trim(),
      created: part.time.created,
      partID: part.id,
    })
  }
  out.sort((a, b) => b.created - a.created)
  return out.slice(0, Math.max(0, limit))
}

/** --- Files -------------------------------------------------------------- */

/**
 * Files changed by edit-family tool calls, as FileDiffInfo rows merged per
 * file path in first-seen order. The server-side session.diff snapshot can be
 * empty for sessions that edited files, so the diff view derives the same
 * shape locally from completed tool parts' state.metadata.files. Walked
 * oldest first (input NOT mutated). Defensive: malformed parts/items are
 * skipped; patch defaults to "", counts to 0, unknown status to "modified".
 * Status merge: a first-seen "added" sticks unless a later part "deleted" the
 * file; otherwise the latest status wins.
 */
export function diffFromTools(
  entries: readonly { part: SessionMessageAssistantTool; sessionID: string }[],
): FileDiffInfo[] {
  const oldest = [...entries].sort((a, b) => a.part.time.created - b.part.time.created)
  const byFile = new Map<string, FileDiffInfo>()
  for (const { part } of oldest) {
    if (part.state.status !== "completed") continue
    const metadata: unknown = part.state.metadata
    const files = metadata !== null && typeof metadata === "object" ? (metadata as Record<string, unknown>).files : undefined
    if (!Array.isArray(files)) continue
    for (const item of files as unknown[]) {
      if (item === null || typeof item !== "object") continue
      const raw = item as Record<string, unknown>
      if (typeof raw.file !== "string" || raw.file.length === 0) continue
      const patch = typeof raw.patch === "string" ? raw.patch : ""
      const additions = typeof raw.additions === "number" ? raw.additions : 0
      const deletions = typeof raw.deletions === "number" ? raw.deletions : 0
      const status: FileDiffInfo["status"] =
        raw.status === "added" || raw.status === "deleted" || raw.status === "modified" ? raw.status : "modified"
      const existing = byFile.get(raw.file)
      if (!existing) {
        byFile.set(raw.file, { file: raw.file, patch, additions, deletions, status })
        continue
      }
      existing.additions += additions
      existing.deletions += deletions
      if (patch) existing.patch = existing.patch ? `${existing.patch}\n${patch}` : patch
      existing.status = existing.status === "added" && status !== "deleted" ? "added" : status
    }
  }
  return [...byFile.values()]
}

/** --- Diff split --------------------------------------------------------- */

/** One side of a side-by-side row: 1-based line number, text without the diff prefix, and kind. */
export type SplitCell = { no: number; text: string; kind: "ctx" | "del" | "add" } | undefined

export type SplitRow =
  | { type: "file"; text: string } // "Index:", "===", "---", "+++" header lines
  | { type: "hunk"; text: string } // "@@ -a,b +c,d @@ ..." line
  | { type: "line"; left: SplitCell; right: SplitCell }

/** Side-by-side view of a unified diff: all rows plus the row indexes of "hunk" rows. */
export type SplitPatch = { rows: SplitRow[]; hunks: number[] }

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * Pure unified-diff → side-by-side conversion. Lines outside hunks (headers
 * before the first "@@" of a file, or once a hunk's line counts are used up)
 * become "file" rows; "@@" lines become "hunk" rows and their row indexes are
 * collected in `hunks`. Hunk content becomes "line" rows: context lines show
 * on both sides with running old/new numbers, and a run of "-" lines followed
 * by a run of "+" lines is paired row by row — the longer side's extra rows
 * leave the other side undefined, as do lone runs. "\ No newline at end of
 * file" markers are skipped; concatenated multi-file patches are supported,
 * with numbering restarting at each hunk header.
 */
export function splitPatch(patch: string): SplitPatch {
  const rows: SplitRow[] = []
  const hunks: number[] = []
  const lines = patch.split("\n")
  const end = lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length
  let sawHunk = false
  let oldNo = 0
  let newNo = 0
  let oldLeft = 0 // old-side lines still expected by the current hunk header
  let newLeft = 0
  let i = 0
  while (i < end) {
    const line = lines[i]!
    const header = HUNK_HEADER_RE.exec(line)
    if (header) {
      rows.push({ type: "hunk", text: line })
      hunks.push(rows.length - 1)
      sawHunk = true
      oldNo = Number(header[1] ?? 0)
      newNo = Number(header[3] ?? 0)
      oldLeft = header[2] !== undefined ? Number(header[2]) : 1
      newLeft = header[4] !== undefined ? Number(header[4]) : 1
      i++
    } else if (sawHunk && line.startsWith("\\")) {
      i++ // "\ No newline at end of file"
    } else if (oldLeft > 0 || newLeft > 0) {
      if (line === "" || line.startsWith(" ")) {
        rows.push({
          type: "line",
          left: { no: oldNo++, text: line.slice(1), kind: "ctx" },
          right: { no: newNo++, text: line.slice(1), kind: "ctx" },
        })
        oldLeft--
        newLeft--
        i++
        continue
      }
      const dels: string[] = []
      while (i < end && lines[i]!.startsWith("-")) {
        dels.push(lines[i]!)
        i++
      }
      while (i < end && lines[i]!.startsWith("\\")) i++ // old side ended without a newline
      const adds: string[] = []
      while (i < end && lines[i]!.startsWith("+")) {
        adds.push(lines[i]!)
        i++
      }
      if (dels.length === 0 && adds.length === 0) {
        // unexpected content line inside a hunk: treat it as context
        rows.push({
          type: "line",
          left: { no: oldNo++, text: line.slice(1), kind: "ctx" },
          right: { no: newNo++, text: line.slice(1), kind: "ctx" },
        })
        oldLeft--
        newLeft--
        i++
        continue
      }
      for (let j = 0; j < Math.max(dels.length, adds.length); j++) {
        const left: SplitCell = j < dels.length ? { no: oldNo++, text: dels[j]!.slice(1), kind: "del" } : undefined
        const right: SplitCell = j < adds.length ? { no: newNo++, text: adds[j]!.slice(1), kind: "add" } : undefined
        rows.push({ type: "line", left, right })
      }
      oldLeft -= dels.length
      newLeft -= adds.length
    } else {
      rows.push({ type: "file", text: line })
      i++
    }
  }
  return { rows, hunks }
}
