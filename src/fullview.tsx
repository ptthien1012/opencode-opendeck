/** @jsxImportSource @opentui/solid */
// Full-screen Opendeck view (Part 2), registered as the plugin route
// "opendeck" — the widest surface the v2 TUI API offers (a whole page).
// Borderless Grok-CLI style (see ui.tsx): a `◆ opendeck` header with a live
// ctx gauge, a clickable tab row (1 Overview · 2 Agents · 3 Activity ·
// 4 Files), then one full-width stack per tab — overview: main, stats,
// charts, errors (plus the permissions gate while requests are pending);
// agents: the orchestrator tree or swimlanes, agent tokens, tools, gate;
// activity: the tool timeline sized to the terminal height; files: the
// changed-files panel. `t` toggles cards ⇄ lanes; key hints sit at the
// bottom.
//
// Everything animates off the deck's single shared 120ms ticker — this file
// creates no timers of its own.

import type { SessionInfo } from "@opencode/client"
import { usePlugin } from "@opencode/plugin/tui"
import type { BoxRenderable, RGBA } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, Match, onMount, Show, Switch } from "solid-js"
import { spinner } from "./anim.js"
import { formatClock, formatElapsed, formatTokens, maskSecrets, shortModel, toolSummary, truncate } from "./format.js"
import type { Deck, FullTab } from "./state.js"
import { cacheShare, formatDuration, hbar, toolState } from "./metrics.js"
import { AgentTokensPanel, ChartsPanel, ErrorsPanel, FilesPanel, StatsPanel } from "./panels.js"
import { agentLabel, agentName, assistantMessages, collectToolParts, collapseRows, lastActive, sessionTokens, toolCallCounts, useAgentState, useContextStats, usePermRecords } from "./shared.js"
import type { MergedPerm } from "./shared.js"
import { Gauge, glyph, KeyHints, Marker, Rule, Section } from "./ui.js"

const MAX_CARDS = 6
const LANE_LIMIT = 10
const DONE_ROWS = 8
const PENDING_ROWS = 3
const TOOL_ROWS = 6

/** Header tab row in key order (1–4); each label carries its key number. */
const FULL_TABS: readonly { id: FullTab; label: string }[] = [
  { id: "overview", label: "1 Overview" },
  { id: "agents", label: "2 Agents" },
  { id: "activity", label: "3 Activity" },
  { id: "files", label: "4 Files" },
]

/** --- Panels -------------------------------------------------------------- */

/** Header: `◆ opendeck  <title>` left, `ctx ▰▱ NN% · model` right, then a clickable tab row, then the rule. */
function TitleRow(props: { deck: Deck; sessionID: string; w: number }) {
  const context = usePlugin()
  const theme = () => context.theme
  const title = createMemo(() => maskSecrets(context.data.session.get(props.sessionID)?.title ?? ""))
  const { stats, ratio } = useContextStats(props.deck, () => props.sessionID)
  const model = createMemo(() => shortModel(stats()?.modelID, 14))
  const pct = createMemo(() => {
    const value = ratio()
    return value === undefined ? undefined : Math.round(value * 100)
  })
  // Right side width: "ctx " + 10 cells + " NN%"/" —" + " · " + model.
  const rightW = createMemo(() => 4 + 10 + 1 + (pct() === undefined ? 1 : `${pct()}%`.length) + 3 + model().length)
  return (
    <box flexDirection="column" width={props.w} marginBottom={1}>
      <box flexDirection="row" justifyContent="space-between" width="100%">
        <box flexDirection="row">
          <text wrapMode="none" fg={theme().hue.accent[200]}>
            <b>{`${glyph.main} opendeck`}</b>
          </text>
          <Show when={title()}>
            <text wrapMode="none" fg={theme().text.muted}>
              {`  ${truncate(title(), Math.max(8, props.w - 11 - 2 - rightW() - 1))}`}
            </text>
          </Show>
        </box>
        <box flexDirection="row" gap={1} flexShrink={0}>
          <text wrapMode="none" fg={theme().text.muted}>ctx</text>
          <Show when={pct() !== undefined} fallback={<text wrapMode="none" fg={theme().text.faint}>—</text>}>
            <Gauge ratio={ratio()} cells={10} />
            <text wrapMode="none" fg={theme().text.muted}>{`${pct()}%`}</text>
          </Show>
          <text wrapMode="none" fg={theme().text.faint}>{`· ${model()}`}</text>
        </box>
      </box>
      <box flexDirection="row" width="100%">
        <For each={FULL_TABS}>
          {(tab, index) => (
            <>
              <Show when={index() > 0}>
                <text wrapMode="none" fg={theme().text.faint}>{" · "}</text>
              </Show>
              <box flexDirection="row" onMouseDown={() => props.deck.setFullTab(tab.id)}>
                <text wrapMode="none" fg={props.deck.fullTab() === tab.id ? theme().hue.accent[200] : theme().text.faint}>
                  {props.deck.fullTab() === tab.id ? <b>{tab.label}</b> : tab.label}
                </text>
              </box>
            </>
          )}
        </For>
      </box>
      <Rule w={props.w} />
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
  const cells = createMemo(() => Math.max(6, Math.min(24, props.w - 2 - 24)))
  const inner = createMemo(() => Math.max(10, props.w - 2))
  const warnColor = createMemo(() =>
    (ratio() ?? 0) > 0.85 ? theme().text.feedback.error.base : theme().text.feedback.warning.base,
  )

  return (
    <Section title="main" accent right={running() ? `${glyph.running} working` : `${glyph.idle} idle`} w={props.w}>
      <Show when={stats()} keyed fallback={<text wrapMode="none" fg={theme().text.muted}>ctx · no usage yet</text>}>
        {(s: NonNullable<ReturnType<typeof stats>>) => (
          <>
            <box flexDirection="row" gap={1}>
              <text wrapMode="none" fg={theme().text.muted}>ctx</text>
              <Show when={ratio() !== undefined}>
                <Gauge ratio={ratio()} cells={cells()} />
                <text wrapMode="none" fg={theme().text.muted}>{Math.round((ratio() ?? 0) * 100)}%</text>
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
        <text wrapMode="none" fg={warnColor()}>
          {truncate(`⚠ ctx ${Math.round((ratio() ?? 0) * 100)}% — compaction soon`, inner())}
        </text>
      </Show>
    </Section>
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
  const cells = createMemo(() => records().slice(-Math.max(8, props.w - 2)))
  const inner = createMemo(() => Math.max(10, props.w - 2))

  const cellColor = (record: MergedPerm): RGBA => {
    const feedback = theme().text.feedback
    if (record.pending) return pulse() ? feedback.warning.base : feedback.warning.muted
    if (record.reply === "reject") return record.inSubagent ? feedback.error.muted : feedback.error.base
    return record.inSubagent ? feedback.success.muted : feedback.success.base
  }

  return (
    <Show when={records().length > 0}>
      <Section title="permissions" right={`${totals().total} checks`} w={props.w}>
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
      </Section>
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
  const barW = createMemo(() => Math.max(6, props.w - 2 - labelW - 7))

  return (
    <Show when={total() > 0}>
      <Section title="tools" right={`${total()} calls`} w={props.w}>
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
      </Section>
    </Show>
  )
}

function Timeline(props: { deck: Deck; sessionID: string; w: number; rows: number }) {
  const context = usePlugin()
  const theme = () => context.theme
  // Host working directory, so absolute paths in tool rows can render as "./…".
  const cwd = createMemo((): string | undefined => {
    try {
      return context.location?.directory || undefined
    } catch {
      return undefined
    }
  })

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
        summary: toolSummary(entry.part, 90, { cwd: cwd() }),
      }
    })
    return collapseRows(items, (item) => `${item.who}|${item.part.name}|${item.summary}`).slice(0, props.rows)
  })

  const clockW = 9
  const whoW = 11
  const summaryW = createMemo(() => Math.max(8, props.w - 2 - clockW - whoW - 6))

  return (
    <Show when={rows().length > 0}>
      <Section title="activity" w={props.w}>
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
      </Section>
    </Show>
  )
}

/** --- Agents: orchestrator tree (running branches, done rows) or swimlanes - */

/**
 * Orchestrator (main session) as a compact 2-line card: ▌ ◆ name · model and
 * working with session age / idle with activity recency, then its top tools.
 * The main section already shows ctx and tokens, so they are not repeated here.
 */
function MainCard(props: { deck: Deck; session: SessionInfo; w: number }) {
  const context = usePlugin()
  const theme = () => context.theme
  const agent = useAgentState(props.deck, props.session)
  const inner = createMemo(() => Math.max(8, props.w - 2))
  const running = createMemo(() => context.data.session.status(props.session.id) === "running")
  const age = createMemo(() => formatDuration(Math.max(0, props.deck.now() - props.session.time.created)))
  // Idle shows activity recency (time since the last update), not session age.
  const right = createMemo(() =>
    running() ? `${glyph.running} working · ${age()}` : `${glyph.idle} idle · ${lastActive(props.session, props.deck.now())}`,
  )
  const toolsLine = createMemo(() =>
    toolCallCounts(collectToolParts(context, [props.session.id]))
      .slice(0, 4)
      .map((row) => `${row.key}×${row.count}`)
      .join(" "),
  )

  return (
    <box flexDirection="column" width={props.w} onMouseDown={() => props.deck.diveInto(props.session.id)}>
      <box flexDirection="row" justifyContent="space-between" width="100%">
        <box flexDirection="row">
          <Marker color={running() ? theme().hue.accent[200] : theme().text.faint} />
          <text wrapMode="none" fg={theme().hue.accent[200]}>
            <b>{truncate(` ${glyph.main} ${props.session.agent ?? "main"} · ${shortModel(agent.model()?.id, 14)}`, Math.max(8, inner() - right().length - 2))}</b>
          </text>
        </box>
        <text wrapMode="none" fg={running() ? theme().hue.accent[200] : theme().text.muted} flexShrink={0}>
          {right()}
        </text>
      </box>
      <text wrapMode="none" fg={theme().text.faint}>{truncate(`  ${toolsLine() || "no tool calls yet"}`, inner())}</text>
    </box>
  )
}

/**
 * Running subagent as a tree branch: `├─ ▌ name · task · model … clock`, then
 * a `│  ` detail line (last tool) and a `│  ` stats line (ctx, tokens, top
 * tools). Click opens the agent's session.
 */
function TreeAgent(props: { deck: Deck; session: SessionInfo; w: number; last: boolean }) {
  const context = usePlugin()
  const theme = () => context.theme
  const agent = useAgentState(props.deck, props.session)
  const branch = () => (props.last ? "└─ " : "├─ ")
  const stem = () => (props.last ? "   " : "│  ")
  const clock = createMemo(() => (agent.elapsedMs() !== undefined ? formatElapsed(agent.elapsedMs()!) : "-"))
  const model = createMemo(() => shortModel(agent.model()?.id, 12))
  // The header carries the task next to the name; the detail line keeps the
  // live tool so the task text is never shown twice.
  const label = createMemo(() =>
    agentLabel(props.session, Math.max(8, props.w - 3 - clock().length - 1 - model().length - 3)),
  )
  const detail = createMemo(() => {
    const tool = agent.lastTool()
    return tool ? toolSummary(tool, 60) : ""
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
  const statsLine = createMemo(() => {
    const base = `${ctxLabel()} · in ${formatTokens(agent.tokens().input)} · out ${formatTokens(agent.tokens().output)}`
    return toolsLine() ? `${base} · ${toolsLine()}` : base
  })

  return (
    <box flexDirection="column" width={props.w} onMouseDown={() => props.deck.diveInto(props.session.id)}>
      <box flexDirection="row" justifyContent="space-between" width="100%">
        <box flexDirection="row">
          <text wrapMode="none" fg={theme().text.faint}>{branch()}</text>
          <Marker color={agent.statusColor()} />
          <text wrapMode="none" fg={theme().text.base}>
            {truncate(` ${label()} · ${model()}`, Math.max(8, props.w - 3 - clock().length - 1))}
          </text>
        </box>
        <text wrapMode="none" fg={theme().text.muted} flexShrink={0}>{clock()}</text>
      </box>
      <Show when={detail()}>
        <text wrapMode="none" fg={theme().text.faint}>{truncate(`${stem()} ${detail()}`, props.w)}</text>
      </Show>
      <text wrapMode="none" fg={theme().text.faint}>{truncate(`${stem()} ${statsLine()}`, props.w)}</text>
    </box>
  )
}

/** Compact one-line row for a finished (done/errored) subagent:
 * `✓ name · task · model · in/out tokens · duration`, truncated to fit. */
function DoneRow(props: { deck: Deck; session: SessionInfo; w: number }) {
  const context = usePlugin()
  const theme = () => context.theme
  const agent = useAgentState(props.deck, props.session)
  const failed = createMemo(() => agent.status() === "error")
  const line = createMemo(() => {
    const mark = failed() ? "✗" : "✓"
    const duration = agent.elapsedMs() !== undefined ? formatDuration(agent.elapsedMs()!) : "-"
    const tail = ` · ${shortModel(agent.model()?.id, 12)} · in ${formatTokens(agent.tokens().input)} · out ${formatTokens(agent.tokens().output)} · ${duration}`
    // Label first so a long task never pushes the model/tokens/duration off.
    const label = agentLabel(props.session, Math.max(8, props.w - 2 - mark.length - 1 - tail.length))
    return truncate(`${mark} ${label}${tail}`, Math.max(8, props.w - 2))
  })
  return (
    <box onMouseDown={() => props.deck.diveInto(props.session.id)}>
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
  // Running lanes keep the live mm:ss clock; finished lanes read "22m".
  const clock = createMemo(() => {
    const ms = agent.elapsedMs()
    if (ms === undefined) return "-"
    return agent.running() ? formatElapsed(ms) : formatDuration(ms)
  })
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
      onMouseDown={() => props.deck.diveInto(props.session.id)}
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
        {clock()}
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

  // Content width inside the section's 2-space indent.
  const inner = createMemo(() => Math.max(10, props.w - 2))
  // Cards ⇄ lanes: explicit pref (the `t` key) wins; default is cards.
  const useLanes = createMemo(() => props.deck.lanesPref() ?? false)

  // Restore context/elapsed for subagents that predate this TUI.
  createEffect(() => {
    for (const child of children()) {
      if (context.data.session.status(child.id) !== "running") {
        if ((context.data.session.message.list(child.id) ?? []).length === 0) props.deck.hydrateMessages(child.id)
      }
    }
  })

  // Newest running branches that fit under the orchestrator.
  const shownRunning = createMemo(() => runningChildren().slice(-MAX_CARDS))

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
    <Section title="agents" right={`${runningCount()} running · ${doneCount()} done`} w={props.w}>
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
              {(session: SessionInfo) => <MainCard deck={props.deck} session={session} w={inner()} />}
            </Show>
            <Show
              when={runningChildren().length > 0}
              fallback={<text wrapMode="none" fg={theme().text.faint}>└─ no running agents</text>}
            >
              <For each={shownRunning()}>
                {(child, index) => (
                  <TreeAgent
                    deck={props.deck}
                    session={child}
                    w={inner()}
                    last={index() === shownRunning().length - 1 && runningChildren().length <= MAX_CARDS}
                  />
                )}
              </For>
              <Show when={runningChildren().length > shownRunning().length}>
                <text wrapMode="none" fg={theme().text.faint}>{`   +${runningChildren().length - shownRunning().length} more`}</text>
              </Show>
            </Show>
            <Show when={doneChildren().length > 0}>
              <box flexDirection="column" marginTop={1}>
                <text wrapMode="none" fg={theme().text.faint}>{`done (${doneCount()})`}</text>
                <For each={doneChildren().slice(0, DONE_ROWS)}>
                  {(child) => <DoneRow deck={props.deck} session={child} w={inner()} />}
                </For>
                <Show when={doneChildren().length > DONE_ROWS}>
                  <text wrapMode="none" fg={theme().text.faint}>+{doneChildren().length - DONE_ROWS} earlier</text>
                </Show>
              </box>
            </Show>
          </box>
        </Show>
      </Show>
    </Section>
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
  // The activity tab sizes its timeline off the full terminal height (same
  // pattern as the diff/git/usage pages).
  const H = createMemo(() => context.renderer.terminalHeight ?? 40)

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
            <TitleRow deck={props.deck} sessionID={id} w={W()} />
            <box flexDirection="column" width={W()}>
              <Switch>
                <Match when={props.deck.fullTab() === "agents"}>
                  <AgentsArea deck={props.deck} sessionID={id} w={W()} />
                  <AgentTokensPanel deck={props.deck} sessionID={id} w={W()} />
                  <ToolsPanel deck={props.deck} sessionID={id} w={W()} />
                  <GatePanel deck={props.deck} sessionID={id} w={W()} />
                </Match>
                <Match when={props.deck.fullTab() === "activity"}>
                  <Timeline deck={props.deck} sessionID={id} w={W()} rows={Math.max(8, H() - 12)} />
                </Match>
                <Match when={props.deck.fullTab() === "files"}>
                  <FilesPanel deck={props.deck} sessionID={id} w={W()} />
                  <text wrapMode="none" fg={theme().text.faint}>press f for the full diff page</text>
                </Match>
                <Match when={props.deck.fullTab() === "overview"}>
                  <MainPanel deck={props.deck} sessionID={id} w={W()} />
                  <StatsPanel deck={props.deck} sessionID={id} w={W()} />
                  <ChartsPanel deck={props.deck} sessionID={id} w={W()} />
                  <ErrorsPanel deck={props.deck} sessionID={id} w={W()} />
                  <Show when={props.deck.pendingPermissions(id).length > 0}>
                    <GatePanel deck={props.deck} sessionID={id} w={W()} />
                  </Show>
                </Match>
              </Switch>
            </box>
            <KeyHints
              items={[["1-4", "tabs"], ["t", "cards/lanes"], ["f", "files"], ["l", "log"], ["u", "usage"], ["q", "back"]]}
              w={W()}
            />
          </>
        )}
      </Show>
    </box>
  )
}
