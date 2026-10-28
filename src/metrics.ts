// Pure metrics and terminal-chart helpers for Flightdeck. No Solid, no host
// access, no timers: every function takes plain data and returns plain data,
// so it is unit-tested with `bun test` (test/metrics.test.ts).

import type { SessionMessageAssistant, SessionMessageAssistantTool, SessionMessageInfo } from "@opencode/client"

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
  const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0
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

/** Files changed by the given assistant messages (snapshot.files), unique, first-seen order. */
export function filesTouched(messages: readonly SessionMessageAssistant[]): string[] {
  const seen = new Set<string>()
  for (const message of messages) {
    for (const file of message.snapshot?.files ?? []) seen.add(file)
  }
  return [...seen]
}
