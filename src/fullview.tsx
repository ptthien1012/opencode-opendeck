/** @jsxImportSource @opentui/solid */
// Full-screen Opendeck view (Part 2), registered as the plugin route
// "opendeck" — the widest surface the v2 TUI API offers (a whole page).
// Layout follows claude-flightdeck's terminal look: a bordered main panel
// (model · ctx gauge · tokens), a permission gate as a filling cell strip, an
// activity timeline, and agents as a hierarchy: the orchestrator card on
// top, a fan-out rail (┬, packets marching while anything runs) to the
// running subagent cards, finished subagents as compact done rows below, or
// swimlanes on one shared time axis. `t` / clicking toggles cards ⇄ lanes.
//
// Everything animates off the deck's single shared 120ms ticker — this file
// creates no timers of its own.

import type { SessionInfo } from "@opencode/client"
import { usePlugin } from "@opencode/plugin/tui"
import type { BoxRenderable, RGBA } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, onMount, Show } from "solid-js"
import { railRuns, spinner } from "./anim.js"
import {
  formatBar,
  formatClock,
  formatElapsed,
  formatTokens,
  maskSecrets,
  shortModel,
  toolSummary,
  truncate,
} from "./format.js"
import type { Deck } from "./state.js"
import { cacheShare, formatDuration, hbar, toolState } from "./metrics.js"
import { AgentTokensPanel, ChartsPanel, ErrorsPanel, FilesPanel, StatsPanel } from "./panels.js"
import { agentDesc, agentName, assistantMessages, collectToolParts, collapseRows, openSessionSafe, sessionTokens, toolCallCounts, useAgentState, useContextStats, usePermRecords } from "./shared.js"
import type { MergedPerm } from "./shared.js"

const MAX_CARDS = 6
const LANE_LIMIT = 10
const DONE_ROWS = 8
const PENDING_ROWS = 3
const TOOL_ROWS = 6

type Width = () => number

/** --- Connector rail ------------------------------------------------------ */

function Rail(props: { deck: Deck; width: number; marks: readonly number[]; merge: boolean; active: boolean }) {
  const context = usePlugin()
  const theme = () => context.theme
  const runs = createMemo(() => railRuns(props.deck.tick(), props.width, props.marks, props.merge, props.active))
  return (
    <box flexDirection="row" height={1} overflow="hidden">
      <For each={runs()}>
        {(run) => (
          <text wrapMode="none" fg={run.lit ? theme().hue.accent[200] : theme().text.faint}>
            {run.text}
          </text>
        )}
      </For>
    </box>
  )
}

/** --- Panels -------------------------------------------------------------- */

function TitleRow(props: { deck: Deck; sessionID: string; w: Width }) {
  const context = usePlugin()
  const theme = () => context.theme
  const title = createMemo(() => maskSecrets(context.data.session.get(props.sessionID)?.title ?? ""))
  return (
    <box flexDirection="row" justifyContent="space-between" width="100%" marginBottom={1}>
      <text wrapMode="none" fg={theme().text.base}>
        <b>Opendeck</b>
        {title() ? `  ${truncate(title(), Math.max(10, props.w() - 44))}` : ""}
      </text>
      <box flexDirection="row" gap={1} flexShrink={0}>
        <box onMouseDown={() => props.deck.setLanes(!(props.deck.lanesPref() ?? false))}>
          <text wrapMode="none" fg={theme().hue.interactive[200]}>
            [t] cards⇄lanes
          </text>
        </box>
        <box onMouseDown={() => props.deck.closeFullview()}>
          <text wrapMode="none" fg={theme().hue.interactive[200]}>
            [q/esc] close
          </text>
        </box>
      </box>
    </box>
  )
}

function MainPanel(props: { deck: Deck; sessionID: string; w: number }) {
  const context = usePlugin()
  const theme = () => context.theme

  const { stats, ratio } = useContextStats(props.deck, () => props.sessionID)
  const tokens = createMemo(() => sessionTokens(context, props.sessionID))
  const cached = createMemo(() => Math.round(cacheShare(assistantMessages(context.data.session.message.list(props.sessionID))) * 100))
  const running = createMemo(() => context.data.session.status(props.sessionID) === "running")
  const model = createMemo(() => stats()?.modelID ?? context.data.session.get(props.sessionID)?.model?.id)
  const barColor = createMemo(() => {
    const value = ratio()
    if (value === undefined) return theme().hue.accent[200]
    if (value > 0.85) return theme().text.feedback.error.base
    if (value >= 0.7) return theme().text.feedback.warning.base
    return theme().hue.accent[200]
  })
  const barW = createMemo(() => Math.max(6, Math.min(24, props.w - 30)))
  const inner = createMemo(() => Math.max(10, props.w - 4))

  return (
    <box flexDirection="column" border borderStyle="rounded" borderColor={theme().hue.accent[400]} paddingX={1} width={props.w} marginBottom={1}>
      <box flexDirection="row" justifyContent="space-between" width="100%">
        <text wrapMode="none" fg={theme().hue.accent[200]}>
          <b>{truncate(`${shortModel(model(), 24)} · main`, inner() - 12)}</b>
        </text>
        <text wrapMode="none" fg={running() ? theme().hue.accent[200] : theme().text.muted} flexShrink={0}>
          {running() ? `${spinner(props.deck.tick())} working` : "○ idle"}
        </text>
      </box>
      <Show when={stats()} keyed fallback={<text wrapMode="none" fg={theme().text.muted}>ctx · no usage yet</text>}>
        {(s: NonNullable<ReturnType<typeof stats>>) => (
          <>
            <box flexDirection="row" gap={1}>
              <text wrapMode="none" fg={theme().text.muted}>ctx</text>
              <Show when={ratio() !== undefined}>
                <text wrapMode="none" fg={barColor()}>{formatBar(ratio() ?? 0, barW())}</text>
                <text wrapMode="none" fg={barColor()}>{Math.round((ratio() ?? 0) * 100)}%</text>
              </Show>
              <text wrapMode="none" fg={theme().text.muted}>
                {formatTokens(s.used)}/{s.limit ? formatTokens(s.limit) : "?"}
              </text>
            </box>
            <text wrapMode="none" fg={theme().text.faint}>
              {truncate(`in ${formatTokens(s.tokens.input)} · out ${formatTokens(s.tokens.output)} · cache ${formatTokens((s.tokens.cache?.read ?? 0) + (s.tokens.cache?.write ?? 0))}`, inner())}
            </text>
          </>
        )}
      </Show>
      <text wrapMode="none" fg={theme().text.base}>
        {truncate(`total in ${formatTokens(tokens().input)} (cache ${cached()}%) · out ${formatTokens(tokens().output)}`, inner())}
      </text>
      <Show when={(ratio() ?? 0) >= 0.7}>
        <text wrapMode="none" fg={barColor()}>
          {truncate(`⚠ ctx ${Math.round((ratio() ?? 0) * 100)}% — compaction soon`, inner())}
        </text>
      </Show>
    </box>
  )
}

function GatePanel(props: { deck: Deck; sessionID: string; w: number }) {
  const context = usePlugin()
  const theme = () => context.theme

  createEffect(() => {
    for (const id of props.deck.familyIds(props.sessionID)) props.deck.hydratePermissions(id)
  })

  const { records, pending, totals } = usePermRecords(props.deck, () => props.sessionID)
  const pulse = createMemo(() => Math.floor(props.deck.tick() / 4) % 2 === 0)
  const cells = createMemo(() => records().slice(-Math.max(8, props.w - 4)))
  const inner = createMemo(() => Math.max(10, props.w - 4))

  const cellColor = (record: MergedPerm): RGBA => {
    const feedback = theme().text.feedback
    if (record.pending) return pulse() ? feedback.warning.base : feedback.warning.muted
    if (record.reply === "reject") return record.inSubagent ? feedback.error.muted : feedback.error.base
    return record.inSubagent ? feedback.success.muted : feedback.success.base
  }

  return (
    <Show when={records().length > 0}>
      <box flexDirection="column" border borderStyle="rounded" borderColor={theme().text.feedback.success.muted} paddingX={1} width={props.w} marginBottom={1}>
        <box flexDirection="row" justifyContent="space-between" width="100%">
          <text wrapMode="none" fg={theme().text.base}>
            <b>gate · permissions</b>
          </text>
          <text wrapMode="none" fg={theme().text.muted} flexShrink={0}>
            {totals().total} checks
          </text>
        </box>
        <box flexDirection="row" height={1} overflow="hidden">
          <For each={cells()}>
            {(record) => (
              <text wrapMode="none" fg={cellColor(record)}>
                {record.pending ? "■" : record.reply === "reject" ? "✗" : "■"}
              </text>
            )}
          </For>
        </box>
        <box flexDirection="row" justifyContent="space-between" width="100%">
          <box flexDirection="row" gap={2}>
            <text wrapMode="none" fg={theme().text.feedback.success.base}>■ {totals().allowed} allowed</text>
            <Show when={totals().pending > 0}>
              <text wrapMode="none" fg={pulse() ? theme().text.feedback.warning.base : theme().text.feedback.warning.muted}>
                ■ {totals().pending} pending
              </text>
            </Show>
            <text wrapMode="none" fg={totals().denied > 0 ? theme().text.feedback.error.base : theme().text.faint}>
              ✗ {totals().denied} denied
            </text>
          </box>
          <Show when={props.w >= 60 && records().some((record) => record.inSubagent)}>
            <text wrapMode="none" fg={theme().text.faint} flexShrink={0}>dim: in subagents</text>
          </Show>
        </box>
        <For each={pending().slice(0, PENDING_ROWS)}>
          {(record) => (
            <text wrapMode="none" fg={theme().text.feedback.warning.base}>
              {truncate(`! ${maskSecrets(`${record.action} ${record.resources[0] ?? record.message ?? ""}`.trim())}`, inner())}
            </text>
          )}
        </For>
      </box>
    </Show>
  )
}

/** Per-tool / per-MCP call counts over the session family (main + subagents). */
function ToolsPanel(props: { deck: Deck; sessionID: string; w: number }) {
  const context = usePlugin()
  const theme = () => context.theme

  const counts = createMemo(() => toolCallCounts(collectToolParts(context, props.deck.familyIds(props.sessionID))))
  // MCP server keys first; each group keeps the count-desc order.
  const rows = createMemo(() => [...counts()].sort((a, b) => Number(b.mcp) - Number(a.mcp)))
  const total = createMemo(() => counts().reduce((sum, row) => sum + row.count, 0))
  const max = createMemo(() => Math.max(0, ...counts().map((row) => row.count)))
  const labelW = 14
  const barW = createMemo(() => Math.max(6, props.w - 4 - labelW - 7))

  return (
    <Show when={total() > 0}>
      <box flexDirection="column" border borderStyle="rounded" borderColor={theme().text.faint} paddingX={1} width={props.w} marginBottom={1}>
        <text wrapMode="none" fg={theme().text.base}>
          <b>tools · {total()} calls</b>
        </text>
        <For each={rows().slice(0, TOOL_ROWS)}>
          {(row) => (
            <box flexDirection="row" gap={1}>
              <text wrapMode="none" fg={row.mcp ? theme().hue.accent[200] : theme().text.muted} width={labelW} flexShrink={0}>
                {truncate(row.key, labelW - 1)}
              </text>
              <text wrapMode="none" fg={row.mcp ? theme().hue.accent[200] : theme().text.faint}>{hbar(row.count, max(), barW())}</text>
              <text wrapMode="none" fg={theme().text.muted} flexShrink={0}>×{row.count}</text>
            </box>
          )}
        </For>
        <Show when={rows().length > TOOL_ROWS}>
          <text wrapMode="none" fg={theme().text.faint}>+{rows().length - TOOL_ROWS} more</text>
        </Show>
      </box>
    </Show>
  )
}

function Timeline(props: { deck: Deck; sessionID: string; w: number; rows: number }) {
  const context = usePlugin()
  const theme = () => context.theme

  const rows = createMemo(() => {
    const ids = props.deck.familyIds(props.sessionID)
    const byID = new Map<string, { title?: string; agent?: string }>()
    for (const child of props.deck.children(props.sessionID)) byID.set(child.id, child)
    const items = collectToolParts(context, ids).map((entry) => {
      const main = entry.sessionID === props.sessionID
      return {
        ...entry,
        main,
        who: main ? "main" : agentName(byID.get(entry.sessionID) ?? {}, 10),
        summary: toolSummary(entry.part, 90),
      }
    })
    return collapseRows(items, (item) => `${item.who}|${item.part.name}|${item.summary}`).slice(0, props.rows)
  })

  const clockW = 9
  const whoW = 11
  const summaryW = createMemo(() => Math.max(8, props.w - clockW - whoW - 8))

  return (
    <Show when={rows().length > 0}>
      <box flexDirection="column" border borderStyle="rounded" borderColor={theme().text.faint} paddingX={1} width={props.w} marginBottom={1}>
        <text wrapMode="none" fg={theme().text.muted}>activity</text>
        <For each={rows()}>
          {(row) => {
            const part = row.item.part
            // cut-off calls (session no longer running) show ⚠, not a spinner
            const state = createMemo(() => toolState(part, context.data.session.status(row.item.sessionID) === "running"))
            const iconGlyph = createMemo(() => {
              if (state() === "running") return spinner(props.deck.tick())
              if (state() === "interrupted") return "⚠"
              return state() === "error" ? "✗" : "✓"
            })
            const iconColor = createMemo(() => {
              if (state() === "running") return theme().text.feedback.warning.base
              if (state() === "interrupted") return theme().text.feedback.warning.muted
              return state() === "error" ? theme().text.feedback.error.base : theme().text.muted
            })
            return (
              <box flexDirection="row" gap={1}>
                <text wrapMode="none" fg={theme().text.faint} width={clockW} flexShrink={0}>
                  {formatClock(part.time.created)}
                </text>
                <text wrapMode="none" fg={row.item.main ? theme().hue.accent[200] : theme().text.base} width={whoW} flexShrink={0}>
                  {truncate(row.item.who, whoW - 1)}
                </text>
                <text wrapMode="none" fg={iconColor()}>{iconGlyph()}</text>
                <text wrapMode="none" fg={part.state.status === "completed" ? theme().text.muted : theme().text.base}>
                  {truncate(`${row.item.summary}${row.count > 1 ? ` ×${row.count}` : ""}`, summaryW())}
                </text>
              </box>
            )
          }}
        </For>
      </box>
    </Show>
  )
}

/** --- Agents: orchestrator tree (running cards, done rows) or swimlanes --- */

function AgentCard(props: { deck: Deck; session: SessionInfo; w: number }) {
  const context = usePlugin()
  const theme = () => context.theme
  const agent = useAgentState(props.deck, props.session)
  const inner = createMemo(() => Math.max(8, props.w - 4))
  // Main sessions carry no "(@name subagent)" title suffix: lead with the
  // main agent name (e.g. "orchestrator") instead of the session title.
  const name = createMemo(() =>
    truncate(props.session.parentID ? agentName(props.session, 12) : (props.session.agent ?? "main"), Math.max(4, inner() - 2)),
  )
  const borderColor = createMemo(() => {
    if (agent.status() === "error") return theme().text.feedback.error.base
    if (agent.running()) return theme().hue.accent[400]
    return theme().border.base
  })
  const ctxLabel = createMemo(() => {
    const pct = agent.ctxRatio()
    if (pct !== undefined) return `ctx ${Math.round(pct * 100)}%`
    const ctx = agent.ctx()
    return ctx !== undefined ? `ctx ${formatTokens(ctx)}` : "starting…"
  })
  // Top tools/MCP servers this agent called, e.g. "finder×4 shell×2".
  const toolsLine = createMemo(() =>
    toolCallCounts(collectToolParts(context, [props.session.id]))
      .slice(0, 3)
      .map((row) => `${row.key}×${row.count}`)
      .join(" "),
  )

  return (
    <box
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={borderColor()}
      paddingX={1}
      width={props.w}
      onMouseDown={() => openSessionSafe(context, props.session.id)}
    >
      <box flexDirection="row" gap={1}>
        <text wrapMode="none" fg={agent.statusColor()}>{agent.indicator()}</text>
        <text wrapMode="none" fg={theme().text.base}>
          <b>{name()}</b>
        </text>
      </box>
      <Show when={agentDesc(props.session)}>
        <text wrapMode="none" fg={theme().text.muted}>{truncate(agentDesc(props.session), inner())}</text>
      </Show>
      <text wrapMode="none" fg={theme().text.faint}>
        {truncate(`${props.session.agent ?? "agent"} · ${shortModel(agent.model()?.id, 12)}`, inner())}
      </text>
      <text wrapMode="none" fg={theme().text.faint}>
        {truncate(`${ctxLabel()} · ↑${formatTokens(agent.tokens().input)} ↓${formatTokens(agent.tokens().output)}`, inner())}
      </text>
      <Show when={toolsLine()}>
        <text wrapMode="none" fg={theme().text.faint}>{truncate(toolsLine(), inner())}</text>
      </Show>
      <box flexDirection="row" justifyContent="space-between" width="100%">
        <text wrapMode="none" fg={agent.statusColor()}>{agent.status()}</text>
        <text wrapMode="none" fg={theme().text.muted} flexShrink={0}>
          {agent.elapsedMs() !== undefined ? formatElapsed(agent.elapsedMs()!) : "-"}
        </text>
      </box>
    </box>
  )
}

/**
 * Orchestrator (main session) as a compact 2-line card: name · model and
 * working/idle with session age, then its top tools. The main panel on the
 * left already shows ctx and tokens, so they are not repeated here.
 */
function MainCard(props: { deck: Deck; session: SessionInfo; w: number }) {
  const context = usePlugin()
  const theme = () => context.theme
  const agent = useAgentState(props.deck, props.session)
  const inner = createMemo(() => Math.max(8, props.w - 4))
  const running = createMemo(() => context.data.session.status(props.session.id) === "running")
  const age = createMemo(() => formatDuration(Math.max(0, props.deck.now() - props.session.time.created)))
  const right = createMemo(() => (running() ? `${spinner(props.deck.tick())} working · ${age()}` : `○ idle · ${age()}`))
  const toolsLine = createMemo(() =>
    toolCallCounts(collectToolParts(context, [props.session.id]))
      .slice(0, 4)
      .map((row) => `${row.key}×${row.count}`)
      .join(" "),
  )

  return (
    <box
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={running() ? theme().hue.accent[400] : theme().border.base}
      paddingX={1}
      width={props.w}
      onMouseDown={() => openSessionSafe(context, props.session.id)}
    >
      <box flexDirection="row" justifyContent="space-between" width="100%">
        <text wrapMode="none" fg={theme().hue.accent[200]}>
          <b>{truncate(`◆ ${props.session.agent ?? "main"} · ${shortModel(agent.model()?.id, 14)}`, Math.max(8, inner() - right().length - 1))}</b>
        </text>
        <text wrapMode="none" fg={running() ? theme().hue.accent[200] : theme().text.muted} flexShrink={0}>
          {right()}
        </text>
      </box>
      <text wrapMode="none" fg={theme().text.faint}>{truncate(toolsLine() || "no tool calls yet", inner())}</text>
    </box>
  )
}

/** Compact one-line row for a finished (done/errored) subagent. */
function DoneRow(props: { deck: Deck; session: SessionInfo; w: number }) {
  const context = usePlugin()
  const theme = () => context.theme
  const agent = useAgentState(props.deck, props.session)
  const failed = createMemo(() => agent.status() === "error")
  const line = createMemo(() => {
    const glyph = failed() ? "✗" : "✓"
    const duration = agent.elapsedMs() !== undefined ? formatElapsed(agent.elapsedMs()!) : "-"
    return truncate(
      `${glyph} ${agentName(props.session, 12)} · ${shortModel(agent.model()?.id, 12)} · ↑${formatTokens(agent.tokens().input)} ↓${formatTokens(agent.tokens().output)} · ${duration}`,
      Math.max(8, props.w - 2),
    )
  })
  return (
    <box onMouseDown={() => openSessionSafe(context, props.session.id)}>
      <text wrapMode="none" fg={failed() ? theme().text.feedback.error.base : theme().text.muted}>
        {line()}
      </text>
    </box>
  )
}

function LaneRow(props: { deck: Deck; session: SessionInfo; labelW: number; barW: number; geo: () => { before: number; len: number; after: number } }) {
  const context = usePlugin()
  const theme = () => context.theme
  const agent = useAgentState(props.deck, props.session)
  // Live head: the bar's rightmost cell pulses while the agent runs.
  const pulse = createMemo(() => Math.floor(props.deck.tick() / 4) % 2 === 0)
  const barColor = createMemo(() => {
    if (agent.status() === "error") return theme().text.feedback.error.base
    if (agent.status() === "done") return theme().text.feedback.success.base
    if (agent.running()) return theme().hue.accent[200]
    return theme().text.faint
  })

  return (
    <box
      flexDirection="row"
      gap={1}
      onMouseDown={() => openSessionSafe(context, props.session.id)}
    >
      <text wrapMode="none" fg={agent.statusColor()}>{agent.indicator()}</text>
      <text wrapMode="none" fg={theme().text.base} width={props.labelW} flexShrink={0}>
        {truncate(agentName(props.session, props.labelW), props.labelW)}
      </text>
      <box flexDirection="row" flexShrink={0}>
        <text wrapMode="none" fg={theme().text.faint}>{"·".repeat(props.geo().before)}</text>
        <Show
          when={agent.running()}
          fallback={<text wrapMode="none" fg={barColor()}>{(agent.status() === "idle" ? "·" : "━").repeat(Math.max(1, props.geo().len))}</text>}
        >
          <text wrapMode="none" fg={barColor()}>{"━".repeat(Math.max(0, props.geo().len - 1))}</text>
          <text wrapMode="none" fg={pulse() ? theme().hue.accent[200] : theme().hue.accent[500]}>●</text>
        </Show>
        <text wrapMode="none" fg={theme().text.faint}>{"·".repeat(props.geo().after)}</text>
      </box>
      <text wrapMode="none" fg={theme().text.muted} flexShrink={0}>
        {agent.elapsedMs() !== undefined ? formatElapsed(agent.elapsedMs()!) : "-"}
      </text>
    </box>
  )
}

function AgentsArea(props: { deck: Deck; sessionID: string; w: number }) {
  const context = usePlugin()
  const theme = () => context.theme

  const children = createMemo(() => props.deck.children(props.sessionID))
  // The main (orchestrator) session always leads the area — cards, lanes and
  // counts — once the host store knows it.
  const main = createMemo(() => context.data.session.get(props.sessionID))
  const all = createMemo(() => (main() ? [main()!, ...children()] : children()))

  // Children waiting on a permission reply count as running: they resume as
  // soon as the gate clears.
  const pendingChildIds = createMemo(() => {
    const ids = new Set<string>()
    for (const request of props.deck.pendingPermissions(props.sessionID)) {
      if (request.sessionID !== props.sessionID) ids.add(request.sessionID)
    }
    return ids
  })
  const runningChildren = createMemo(() =>
    children().filter((child) => context.data.session.status(child.id) === "running" || pendingChildIds().has(child.id)),
  )
  // Finished children (done or errored), newest first.
  const doneChildren = createMemo(() => {
    const running = new Set(runningChildren().map((child) => child.id))
    const endOf = (session: SessionInfo) => props.deck.run(session.id)?.end ?? session.time.updated
    return children().filter((child) => !running.has(child.id)).sort((a, b) => endOf(b) - endOf(a))
  })
  const runningCount = createMemo(() => runningChildren().length)
  const doneCount = createMemo(() => doneChildren().length)

  // Running cards sit 2 cols in — the tree indent under the orchestrator.
  const innerW = createMemo(() => Math.max(10, props.w - 2))
  const fit = createMemo(() => Math.max(1, Math.min(MAX_CARDS, Math.floor((innerW() + 1) / 21))))
  // Cards ⇄ lanes: explicit pref wins; otherwise lanes take over past the fit.
  const useLanes = createMemo(() => props.deck.lanesPref() ?? runningChildren().length > fit())

  // Restore context/elapsed for subagents that predate this TUI.
  createEffect(() => {
    for (const child of children()) {
      if (context.data.session.status(child.id) !== "running") {
        if ((context.data.session.message.list(child.id) ?? []).length === 0) props.deck.hydrateMessages(child.id)
      }
    }
  })

  // Newest running cards that fit under the orchestrator.
  const shownCards = createMemo(() => runningChildren().slice(-fit()))
  const cardW = createMemo(() => {
    const n = Math.max(1, shownCards().length)
    return Math.max(20, Math.floor((innerW() - (n - 1)) / n))
  })
  const centers = createMemo(() => shownCards().map((_, i) => i * (cardW() + 1) + Math.floor(cardW() / 2)))

  const labelW = createMemo(() => Math.min(16, Math.max(8, Math.floor(props.w * 0.22))))
  const barW = createMemo(() => Math.max(6, props.w - labelW() - 14))
  const shownLanes = createMemo(() => {
    const kids = children()
    const mainSession = main()
    if (!mainSession) return kids.slice(-LANE_LIMIT)
    const room = Math.max(0, LANE_LIMIT - 1)
    return [mainSession, ...kids.slice(Math.max(0, kids.length - room))]
  })
  const laneGeo = createMemo(() => {
    const now = props.deck.now()
    const shown = shownLanes()
    const start = Math.min(...shown.map((child) => child.time.created), now)
    const span = Math.max(1, now - start)
    const width = barW()
    return shown.map((child) => {
      const run = props.deck.run(child.id)
      const running = context.data.session.status(child.id) === "running"
      const end = run?.end ?? (running || child.outcome === undefined ? now : child.time.updated)
      const from = Math.min(width, Math.max(0, Math.floor(((child.time.created - start) / span) * width)))
      const to = Math.min(width, Math.max(from + 1, Math.ceil(((Math.max(end, child.time.created) - start) / span) * width)))
      return { before: from, len: to - from, after: width - to }
    })
  })

  return (
    <box flexDirection="column" width={props.w} marginBottom={1}>
      <box flexDirection="row" justifyContent="space-between" width="100%">
        <text wrapMode="none" fg={theme().text.base}>
          <b>{`agents · ${runningCount()} running · ${doneCount()} done`}</b>
        </text>
        <Show when={children().length > 0}>
          <box onMouseDown={() => props.deck.setLanes(!useLanes())}>
            <text wrapMode="none" fg={theme().hue.interactive[200]} flexShrink={0}>
              [{useLanes() ? "cards" : "lanes"} t]
            </text>
          </box>
        </Show>
      </box>
      <Show when={all().length > 0} fallback={<text wrapMode="none" fg={theme().text.faint}>no subagents yet</text>}>
        <Show
          when={!useLanes()}
          fallback={
            <box flexDirection="column">
              <For each={shownLanes()}>
                {(child, index) => (
                  <LaneRow deck={props.deck} session={child} labelW={labelW()} barW={barW()} geo={() => laneGeo()[index() ?? 0] ?? { before: 0, len: 1, after: 0 }} />
                )}
              </For>
              <Show when={all().length > shownLanes().length}>
                <text wrapMode="none" fg={theme().text.faint}>+{all().length - shownLanes().length} earlier</text>
              </Show>
            </box>
          }
        >
          <box flexDirection="column">
            <Show when={main()} keyed>
              {(session: SessionInfo) => <MainCard deck={props.deck} session={session} w={props.w} />}
            </Show>
            <box paddingLeft={2} flexDirection="column">
              <text wrapMode="none" fg={theme().text.faint}>{`├ running (${runningCount()})`}</text>
              <Show
                when={runningChildren().length > 0}
                fallback={<text wrapMode="none" fg={theme().text.faint}>└ no running agents</text>}
              >
                <Rail deck={props.deck} width={innerW()} marks={centers()} merge={false} active={true} />
                <box flexDirection="row" gap={1}>
                  <For each={shownCards()}>{(child) => <AgentCard deck={props.deck} session={child} w={cardW()} />}</For>
                </box>
                <Show when={runningChildren().length > shownCards().length}>
                  <text wrapMode="none" fg={theme().text.faint}>+{runningChildren().length - shownCards().length} more</text>
                </Show>
              </Show>
            </box>
            <Show when={doneChildren().length > 0}>
              <box flexDirection="column" marginTop={1}>
                <text wrapMode="none" fg={theme().text.faint}>{`done (${doneCount()})`}</text>
                <For each={doneChildren().slice(0, DONE_ROWS)}>
                  {(child) => <DoneRow deck={props.deck} session={child} w={props.w} />}
                </For>
                <Show when={doneChildren().length > DONE_ROWS}>
                  <text wrapMode="none" fg={theme().text.faint}>+{doneChildren().length - DONE_ROWS} earlier</text>
                </Show>
              </box>
            </Show>
          </box>
        </Show>
      </Show>
    </box>
  )
}

/** --- Root ---------------------------------------------------------------- */

export function FullView(props: { deck: Deck; sessionID?: string }) {
  const context = usePlugin()
  const theme = () => context.theme

  // Plugin routes publish no width: fill the page area and measure our own
  // root box. Never force width from terminalWidth — that clips narrow terms.
  let rootRef: BoxRenderable | undefined
  const [measured, setMeasured] = createSignal(0)
  onMount(() => setMeasured(rootRef?.width ?? context.renderer.terminalWidth ?? 120))
  const W = createMemo(() => Math.max(48, measured() || context.renderer.terminalWidth || 120))
  const wide = createMemo(() => W() >= 110)
  const colW = createMemo(() => (wide() ? Math.floor((W() - 2) / 2) : W()))

  const sid = createMemo(() => props.sessionID ?? props.deck.fullSessionID())

  return (
    <box
      flexDirection="column"
      width="100%"
      ref={(r: BoxRenderable) => {
        rootRef = r
      }}
      onSizeChange={() => {
        const next = rootRef?.width ?? 0
        if (next > 0 && next !== measured()) setMeasured(next)
      }}
    >
      <Show when={sid()} keyed fallback={<text wrapMode="none" fg={theme().text.muted}>opendeck: no session</text>}>
        {(id: string) => (
          <>
            <TitleRow deck={props.deck} sessionID={id} w={W} />
            <Show
              when={wide()}
              fallback={
                <box flexDirection="column" width={colW()}>
                  <MainPanel deck={props.deck} sessionID={id} w={colW()} />
                  <AgentsArea deck={props.deck} sessionID={id} w={colW()} />
                  <ErrorsPanel deck={props.deck} sessionID={id} w={colW()} />
                  <GatePanel deck={props.deck} sessionID={id} w={colW()} />
                  <StatsPanel deck={props.deck} sessionID={id} w={colW()} />
                  <ChartsPanel deck={props.deck} sessionID={id} w={colW()} />
                  <ToolsPanel deck={props.deck} sessionID={id} w={colW()} />
                  <AgentTokensPanel deck={props.deck} sessionID={id} w={colW()} />
                  <Timeline deck={props.deck} sessionID={id} w={colW()} rows={8} />
                  <FilesPanel deck={props.deck} sessionID={id} w={colW()} />
                </box>
              }
            >
              <box flexDirection="row" gap={2} width={W()}>
                <box flexDirection="column" width={colW()}>
                  <MainPanel deck={props.deck} sessionID={id} w={colW()} />
                  <StatsPanel deck={props.deck} sessionID={id} w={colW()} />
                  <ChartsPanel deck={props.deck} sessionID={id} w={colW()} />
                  <ErrorsPanel deck={props.deck} sessionID={id} w={colW()} />
                  <GatePanel deck={props.deck} sessionID={id} w={colW()} />
                  <Timeline deck={props.deck} sessionID={id} w={colW()} rows={12} />
                </box>
                <box flexDirection="column" width={colW()}>
                  <AgentsArea deck={props.deck} sessionID={id} w={colW()} />
                  <AgentTokensPanel deck={props.deck} sessionID={id} w={colW()} />
                  <ToolsPanel deck={props.deck} sessionID={id} w={colW()} />
                  <FilesPanel deck={props.deck} sessionID={id} w={colW()} />
                </box>
              </box>
            </Show>
          </>
        )}
      </Show>
    </box>
  )
}
