// Shared live-state hooks and helpers used by both the sidebar and the
// full-screen view. Everything here is view-agnostic: Solid memos over the
// host's data store plus the deck's run/tick state. No timers, no writes.

import type {
  SessionInfo,
  SessionMessageAssistant,
  SessionMessageAssistantTool,
  SessionMessageInfo,
  TokenUsageInfo,
} from "@opencode/client"
import { usePlugin } from "@opencode/plugin/tui"
import type { RGBA } from "@opentui/core"
import { createEffect, createMemo } from "solid-js"
import { spinner } from "./anim.js"
import { maskSecrets, truncate } from "./format.js"
import type { Deck, PermRecord } from "./state.js"

/** Navigate into a session from a click handler; never throw into the host. */
export function openSessionSafe(context: ReturnType<typeof usePlugin>, sessionID: string): void {
  try {
    context.ui.router.navigate({ type: "session", sessionID })
  } catch {
    // host rejected the route — ignore the click
  }
}

/** --- Agents ------------------------------------------------------------ */

export type AgentStatus = "thinking" | "tool" | "done" | "idle" | "error"

export function agentStatusColor(theme: ReturnType<typeof usePlugin>["theme"], status: AgentStatus): RGBA {
  switch (status) {
    case "tool":
      return theme.text.feedback.warning.base
    case "thinking":
      return theme.hue.accent[200]
    case "done":
      return theme.text.feedback.success.base
    case "error":
      return theme.text.feedback.error.base
    default:
      return theme.text.muted
  }
}

/** Short agent label from the session title's "(@name subagent)" suffix. */
export function agentName(session: { title?: string; agent?: string }, max = 10): string {
  const hit = (session.title ?? "").match(/\(@([^\s()]+)\s+subagent\)\s*$/)
  return truncate(maskSecrets(hit?.[1] ?? session.agent ?? "agent"), max)
}

/** Task description (title minus the agent suffix); masked, caller truncates. */
export function agentDesc(session: { title?: string }): string {
  return maskSecrets((session.title ?? "").replace(/\s*\(@[^\s()]+\s+subagent\)\s*$/, ""))
}

/** --- Activity timeline -------------------------------------------------- */

export type ToolPartEntry = { part: SessionMessageAssistantTool; sessionID: string }

/** Tool calls across the given sessions, newest first. Read-only. */
export function collectToolParts(
  context: ReturnType<typeof usePlugin>,
  ids: readonly string[],
): ToolPartEntry[] {
  const out: ToolPartEntry[] = []
  for (const id of ids) {
    for (const message of assistantMessages(context.data.session.message.list(id))) {
      for (const part of message.content) {
        if (part.type === "tool") out.push({ part, sessionID: id })
      }
    }
  }
  out.sort((a, b) => b.part.time.created - a.part.time.created)
  return out
}

/** Collapse runs of consecutive items with the same signature into `×n`. */
export function collapseRows<T>(items: readonly T[], sig: (item: T) => string): { item: T; count: number }[] {
  const out: { item: T; count: number; key: string }[] = []
  for (const item of items) {
    const key = sig(item)
    const last = out[out.length - 1]
    if (last && last.key === key) last.count++
    else out.push({ item, count: 1, key })
  }
  return out
}

export function assistantMessages(list: SessionMessageInfo[] | undefined): SessionMessageAssistant[] {
  return (list ?? []).filter((item): item is SessionMessageAssistant => item.type === "assistant")
}

/** --- Tool call counts -------------------------------------------------- */

export type ToolCallCount = { key: string; count: number; mcp: boolean }

/** MCP server namespaces in a code-mode `execute` body: dot access
 * (`tools.finder`) or bracket access (`tools["context7"]`). */
const EXECUTE_NS_RE = /tools\.([A-Za-z0-9_-]+)|tools\[["']([A-Za-z0-9_-]+)["']\]/g

/**
 * Tool/MCP call counts over collected tool parts. Keys: MCP server
 * namespaces for `execute` calls (1 per distinct namespace per call, falling
 * back to `execute` when the code references none), the server segment for
 * `mcp__server__tool` names, the raw name otherwise. Sorted count-desc.
 */
export function toolCallCounts(entries: readonly ToolPartEntry[]): ToolCallCount[] {
  const counts = new Map<string, ToolCallCount>()
  const bump = (key: string, mcp: boolean) => {
    const hit = counts.get(key)
    if (hit) hit.count++
    else counts.set(key, { key, count: 1, mcp })
  }
  for (const { part } of entries) {
    if (part.name === "execute") {
      // args are partial/absent while streaming — guard every input access
      const state = part.state
      const input: unknown = state.status === "streaming" ? undefined : state.input
      const code = input !== null && typeof input === "object" ? (input as Record<string, unknown>).code : undefined
      if (typeof code === "string") {
        const namespaces = new Set<string>()
        for (const match of code.matchAll(EXECUTE_NS_RE)) {
          const ns = match[1] ?? match[2]
          if (ns) namespaces.add(ns)
        }
        if (namespaces.size > 0) {
          for (const ns of namespaces) bump(ns, true)
          continue
        }
      }
      bump("execute", false)
      continue
    }
    if (part.name.startsWith("mcp__")) {
      const server = part.name.split("__")[1]
      bump(server && server.length > 0 ? server : part.name, true)
      continue
    }
    bump(part.name, false)
  }
  return [...counts.values()].sort((a, b) => b.count - a.count)
}

export function lastAssistantOf(messages: SessionMessageAssistant[]): SessionMessageAssistant | undefined {
  return messages.findLast((message) => (message.tokens?.output ?? 0) > 0)
}

/** Live per-agent state shared by the card, lane and row renderings. */
export function useAgentState(deck: Deck, session: SessionInfo) {
  const context = usePlugin()

  const messages = createMemo(() => assistantMessages(context.data.session.message.list(session.id)))
  const lastAssistant = createMemo(() => messages().at(-1))
  const runningTool = createMemo(() =>
    (lastAssistant()?.content ?? []).some(
      (item) => item.type === "tool" && (item.state.status === "running" || item.state.status === "streaming"),
    ),
  )
  const lastTool = createMemo(() =>
    lastAssistant()?.content.findLast((item): item is SessionMessageAssistantTool => item.type === "tool"),
  )
  const status = createMemo((): AgentStatus => {
    if (context.data.session.status(session.id) === "running") {
      return runningTool() ? "tool" : "thinking"
    }
    if (lastAssistant()?.error || session.outcome === "failed") return "error"
    if (lastAssistant()?.finish) return "done"
    const run = deck.run(session.id)
    if (run?.end !== undefined) return "done"
    if (deck.now() - session.time.created >= 30_000) return "done"
    return "idle"
  })
  const running = createMemo(() => status() === "thinking" || status() === "tool")
  const statusColor = createMemo(() => agentStatusColor(context.theme, status()))
  // Launch frames (fan-out) win over the spinner; braille spinner while running.
  const indicator = createMemo(() => {
    const launch = deck.launchGlyph(session.id)
    if (launch !== undefined) return launch
    if (running()) return spinner(deck.tick())
    if (status() === "error") return "✗"
    if (status() === "done") return "✓"
    return "-"
  })
  const ctx = createMemo(() => {
    const item = lastAssistantOf(messages())
    const tokens = item?.tokens
    if (!tokens) return undefined
    return tokens.input + tokens.output + tokens.reasoning + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0)
  })
  const model = createMemo(() => lastAssistant()?.model ?? session.model)
  const ctxRatio = createMemo(() => {
    const used = ctx()
    const info = model()
    const limit = deck.modelLimit(info ? { id: info.id, providerID: info.providerID } : undefined)
    return used !== undefined && limit ? used / limit : undefined
  })
  const elapsedMs = createMemo(() => {
    const run = deck.run(session.id)
    if (run) return (run.end ?? deck.now()) - run.start
    const last = lastAssistant()
    const end = last?.time.completed ?? last?.time.created ?? session.time.updated
    return end > session.time.created ? end - session.time.created : undefined
  })

  // Whole-session token totals (input incl cache, output incl reasoning).
  const tokens = createMemo(() => sessionTokens(context, session.id))

  return { messages, lastAssistant, lastTool, status, running, statusColor, indicator, ctx, ctxRatio, model, elapsedMs, tokens }
}

/** Cheap non-hook outcome for rows in the collapsed Done section. */
export function doneGlyph(session: SessionInfo): { glyph: string; failed: boolean } {
  if (session.outcome === "failed") return { glyph: "✗", failed: true }
  if (session.outcome === "interrupted") return { glyph: "○", failed: false }
  return { glyph: "✓", failed: false }
}

/** --- Context & tokens -------------------------------------------------- */

/** Whole-session token totals over every assistant message: `input` folds
 *  in cache read+write, `output` folds in reasoning tokens. */
export function sessionTokens(
  context: ReturnType<typeof usePlugin>,
  sessionID: string,
): { input: number; output: number } {
  let input = 0
  let output = 0
  for (const message of assistantMessages(context.data.session.message.list(sessionID))) {
    const tokens = message.tokens
    if (!tokens) continue
    input += tokens.input + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0)
    output += tokens.output + tokens.reasoning
  }
  return { input, output }
}

export type ContextStats = {
  tokens: TokenUsageInfo
  used: number
  limit: number | undefined
  ratio: number | undefined
  modelID: string | undefined
}

/** Main-session context usage: latest assistant message with real output. */
export function useContextStats(deck: Deck, sessionID: () => string | undefined) {
  const context = usePlugin()
  const messages = createMemo(() => {
    const id = sessionID()
    return id ? assistantMessages(context.data.session.message.list(id)) : []
  })
  const usage = createMemo(() => lastAssistantOf(messages()))
  const stats = createMemo((): ContextStats | undefined => {
    const id = sessionID()
    if (!id) return undefined
    const tokens = usage()?.tokens
    if (!tokens) return undefined
    const used = tokens.input + tokens.output + tokens.reasoning + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0)
    const model = usage()?.model ?? context.data.session.get(id)?.model
    const limit = deck.modelLimit(model ? { id: model.id, providerID: model.providerID } : undefined)
    return { tokens, used, limit, ratio: limit ? used / limit : undefined, modelID: model?.id }
  })
  // Glide the bar toward the latest reading instead of jumping. Both views
  // share the deck's single tween; same session → same target → idempotent.
  createEffect(() => {
    deck.setCtxTarget(stats()?.ratio)
  })
  const ratio = createMemo(() => deck.ctxRatio() ?? stats()?.ratio)
  return { stats, ratio, usage }
}

/** --- Permissions ------------------------------------------------------- */

export type MergedPerm = PermRecord & { /** made inside a subagent session */ inSubagent: boolean }

/**
 * Permission gate records for the session family: observed asked/replied
 * history merged with live pending requests from the host store. Newest last
 * (a cell strip fills left→right, so the tail is what stays visible).
 */
export function usePermRecords(deck: Deck, sessionID: () => string | undefined) {
  const records = createMemo<MergedPerm[]>(() => {
    const id = sessionID()
    if (!id) return []
    const root = id
    const history = deck.permissionHistory(id)
    const known = new Set(history.map((record) => record.id))
    const merged: MergedPerm[] = history.map((record) => ({ ...record, inSubagent: record.sessionID !== root }))
    for (const request of deck.pendingPermissions(id)) {
      if (!known.has(request.id)) {
        merged.push({ ...request, time: Date.now(), pending: true, inSubagent: request.sessionID !== root })
      }
    }
    return merged.sort((a, b) => a.time - b.time)
  })
  const pending = createMemo(() => records().filter((record) => record.pending))
  const totals = createMemo(() => {
    let allowed = 0
    let denied = 0
    for (const record of records()) {
      if (record.pending) continue
      if (record.reply === "reject") denied++
      else allowed++
    }
    return { allowed, denied, pending: pending().length, total: records().length }
  })
  return { records, pending, totals }
}
