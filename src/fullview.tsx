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
import { createEffect, createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { mixColor, pulseLevel, spinner } from "./anim.js"
import { formatClock, formatElapsed, formatTokens, maskSecrets, shortModel, toolSummary } from "./format.js"
import type { Deck, FullTab } from "./state.js"
import { cacheShare, formatDuration, formatRate, hbar, toolState } from "./metrics.js"
import { AgentTokensPanel, ChartsPanel, ErrorsPanel, FilesPanel, StatsPanel } from "./panels.js"
import { agentLabel, agentName, assistantMessages, collectToolParts, collapseRows, lastActive, sessionTokens, toolCallCounts, useAgentState, useContextStats, usePermRecords } from "./shared.js"
import type { MergedPerm } from "./shared.js"
import { AgentCard, agentColor, Gauge, glyph, KeyHints, Marker, RailSpacer, Rule, Section, TabBar, TreeRail } from "./ui.js"

const MAX_CARDS = 6
const MAX_TREE_DEPTH = 3
const LANE_LIMIT = 10
const DONE_ROWS = 8
const PENDING_ROWS = 3
const TOOL_ROWS = 6

/** Tokens/sec text for an agent: latest turn plus the streaming average. */
const rateText = (rate: { last?: number; avg?: number }) =>
  rate.last === undefined && rate.avg === undefined
    ? "– tok/s"
    : `${formatRate(rate.last ?? rate.avg)} tok/s · avg ${formatRate(rate.avg)}`

/** Header tab row in key order (1–4); the TabBar prefixes each key number. */
const FULL_TABS: readonly { id: FullTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "agents", label: "Agents" },
  { id: "activity", label: "Activity" },
  { id: "files", label: "Files" },
]

/** --- Panels -------------------------------------------------------------- */

/** Header: `◆ opendeck  <title>` left, `ctx ▰▱ NN% · model` right, then a clickable tab row, then the rule. */
function TitleRow(props: { deck: Deck; sessionID: string; w: number }) {
  const context = usePlugin()
  const theme = () => context.theme
  const title = createMemo(() => maskSecrets(context.data.session.get(props.sessionID)?.title ?? ""))
  const { stats, ratio } = useContextStats(props.deck, () => props.sessionID)
  const model = createMemo(() => shortModel(stats()?.modelID, 10_000))
  const pct = createMemo(() => {
    const value = ratio()
    return value === undefined ? undefined : Math.round(value * 100)
  })
  return (
    <box flexDirection="column" width={props.w} marginBottom={1}>
      <box flexDirection="row" justifyContent="space-between" width="100%">
        <box flexDirection="row" flexShrink={1}>
          <text wrapMode="none" flexShrink={0} fg={theme().hue.accent[200]}>
            <b>{`${glyph.main} opendeck`}</b>
          </text>
          <Show when={title()}>
            <text wrapMode="word" flexGrow={1} flexShrink={1} fg={theme().text.muted}>
              {`  ${title()}`}
            </text>
          </Show>
        </box>
        {/* Narrow terminals drop the ctx block and keep only "· model". */}
        <box flexDirection="row" gap={1} flexShrink={0}>
          <Show when={props.w >= 56}>
            <text wrapMode="none" fg={theme().text.muted}>ctx</text>
            <Show when={pct() !== undefined} fallback={<text wrapMode="none" fg={theme().text.faint}>—</text>}>
              <Gauge ratio={ratio()} cells={10} />
              <text wrapMode="none" fg={theme().text.muted}>{`${pct()}%`}</text>
            </Show>
          </Show>
          <text wrapMode="none" fg={theme().text.faint}>{`· ${model()}`}</text>
        </box>
      </box>
      <box flexDirection="row" width="100%">
        <TabBar
          items={FULL_TABS.map((tab) => ({ key: tab.id, label: tab.label }))}
          active={props.deck.fullTab()}
          w={props.w}
          wrap
          onSelect={(key) => props.deck.setFullTab(key as FullTab)}
        />
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
            <text wrapMode="word" fg={theme().text.faint}>
              {`in ${formatTokens(s.tokens.input)} · out ${formatTokens(s.tokens.output)} · cache ${formatTokens((s.tokens.cache?.read ?? 0) + (s.tokens.cache?.write ?? 0))}`}
            </text>
          </>
        )}
      </Show>
      <text wrapMode="word" fg={theme().text.base}>
        {`total in ${formatTokens(tokens().input)} (cache ${cached()}%) · out ${formatTokens(tokens().output)}`}
      </text>
      <Show when={(ratio() ?? 0) >= 0.7}>
        <text wrapMode="word" fg={warnColor()}>
          {`⚠ ctx ${Math.round((ratio() ?? 0) * 100)}% — compaction soon`}
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
                {record.pending ? "!" : record.reply === "reject" ? "✗" : "✓"}
              </text>
            )}
          </For>
        </box>
        <box flexDirection="row" justifyContent="space-between" width="100%">
          <box flexDirection="row" gap={2}>
            <text wrapMode="none" fg={theme().text.feedback.success.base}>✓ {totals().allowed} allowed</text>
            <Show when={totals().pending > 0}>
              <text wrapMode="none" fg={pulse() ? theme().text.feedback.warning.base : theme().text.feedback.warning.muted}>
                ! {totals().pending} pending
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
            <text wrapMode="word" fg={theme().text.feedback.warning.base}>
              {`! ${maskSecrets(`${record.action} ${record.resources[0] ?? record.message ?? ""}`.trim())}`}
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
              <text wrapMode="word" fg={row.mcp ? theme().hue.accent[200] : theme().text.muted} width={labelW} flexShrink={0}>
                {row.key}
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
        who: main ? "main" : agentName(byID.get(entry.sessionID) ?? {}, 10_000),
        summary: toolSummary(entry.part, 10_000, { cwd: cwd(), pathMax: 10_000 }),
      }
    })
    return collapseRows(items, (item) => `${item.who}|${item.part.name}|${item.summary}`).slice(0, props.rows)
  })

  const clockW = 9
  const whoW = 11

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
                <text wrapMode="word" fg={row.item.main ? theme().hue.accent[200] : agentColor(theme(), row.item.sessionID)} width={whoW} flexShrink={0}>
                  {row.item.who}
                </text>
                <text wrapMode="none" fg={iconColor()}>{iconGlyph()}</text>
                <text wrapMode="word" flexGrow={1} flexShrink={1} fg={part.state.status === "completed" ? theme().text.muted : theme().text.base}>
                  {`${row.item.summary}${row.count > 1 ? ` ×${row.count}` : ""}`}
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
 * Orchestrator (main session) as an agent card: ▌ indicator name · model with
 * working with session age / idle with activity recency, then its top tools and
 * a ctx / tokens stats line. Lines wrap instead of being cut.
 */
function MainCard(props: { deck: Deck; session: SessionInfo; w: number }) {
  const context = usePlugin()
  const theme = () => context.theme
  const agent = useAgentState(props.deck, props.session)
  const selected = () => props.deck.agentSel() === props.session.id
  const running = createMemo(() => context.data.session.status(props.session.id) === "running")
  const age = createMemo(() => formatDuration(Math.max(0, props.deck.now() - props.session.time.created)))
  // Idle shows activity recency (time since the last update), not session age.
  const right = createMemo(() =>
    running()
      ? `${spinner(props.deck.tick())} working · ${age()}`
      : `${glyph.idle} idle · ${lastActive(props.session, props.deck.now())}`,
  )
  // Running cards breathe: the agent colour is pulled toward the accent each
  // tick, the same pulse the tree rail uses.
  const color = createMemo(() =>
    running()
      ? mixColor(agentColor(theme(), props.session.id), theme().hue.accent[200], pulseLevel(props.deck.tick()))
      : theme().text.faint,
  )
  const toolsLine = createMemo(() =>
    toolCallCounts(collectToolParts(context, [props.session.id]))
      .slice(0, 4)
      .map((row) => `${row.key}×${row.count}`)
      .join(" "),
  )
  const ctxLabel = createMemo(() => {
    const pct = agent.ctxRatio()
    if (pct !== undefined) return `ctx ${Math.round(pct * 100)}%`
    const ctx = agent.ctx()
    return ctx !== undefined ? `ctx ${formatTokens(ctx)}` : "starting"
  })
  const statsLine = createMemo(
    () =>
      `${ctxLabel()} · in ${formatTokens(agent.tokens().input)} · out ${formatTokens(agent.tokens().output)} · ${rateText(agent.rate())}`,
  )

  return (
    <AgentCard
      w={props.w}
      color={color()}
      selected={selected()}
      onMouseDown={() => props.deck.diveInto(props.session.id)}
    >
      <box flexDirection="row" justifyContent="space-between" width="100%">
        <box flexDirection="row" flexShrink={1}>
          <Marker color={running() ? agentColor(theme(), props.session.id) : theme().text.faint} />
          <text wrapMode="word" flexGrow={1} flexShrink={1} fg={agentColor(theme(), props.session.id)}>
            <b>{` ${agent.indicator()} ${props.session.agent ?? "main"} · ${shortModel(agent.model()?.id, 10_000)}`}</b>
          </text>
        </box>
        <text wrapMode="none" fg={running() ? agentColor(theme(), props.session.id) : theme().text.muted} flexShrink={0}>
          {right()}
        </text>
      </box>
      <text wrapMode="word" fg={theme().text.faint}>{`  ${toolsLine() || "no tool calls yet"}`}</text>
      <text wrapMode="word" fg={theme().text.muted}>{`  ${statsLine()}`}</text>
    </AgentCard>
  )
}

/**
 * Running subagent as a 3-logical-line agent card: ▌ name · model with the
 * clock (or a `⚠ needs approval` label while a permission reply is pending) on
 * the right, the live tool (or the pending request), then a ctx / tokens /
 * top-tools stats line. Lines wrap instead of being cut, so the card grows
 * past three terminal rows when the text is long. Click opens the agent's
 * session.
 */
function TreeAgent(props: {
  deck: Deck
  session: SessionInfo
  w: number
  last: boolean
  pending?: { action: string; resources: string[] }
}) {
  const context = usePlugin()
  const theme = () => context.theme
  const agent = useAgentState(props.deck, props.session)
  const selected = () => props.deck.agentSel() === props.session.id
  const running = createMemo(() => context.data.session.status(props.session.id) === "running")
  const failed = createMemo(() => agent.status() === "error")
  const clock = createMemo(() => (agent.elapsedMs() !== undefined ? formatElapsed(agent.elapsedMs()!) : "-"))
  const model = createMemo(() => shortModel(agent.model()?.id, 10_000))
  // Right side of the header: the attention label while waiting on a reply,
  // otherwise the elapsed clock.
  const right = createMemo(() => (props.pending ? "⚠ needs approval" : clock()))
  // The header carries the task next to the name; the detail line keeps the
  // live tool so the task text is never shown twice. The header wraps, so the
  // label keeps the whole task.
  const label = createMemo(() => agentLabel(props.session, 10_000, 10_000))
  const color = createMemo(() => {
    if (props.pending) return theme().text.feedback.warning.base
    if (failed()) return theme().text.feedback.error.base
    return running()
      ? mixColor(agentColor(theme(), props.session.id), theme().hue.accent[200], pulseLevel(props.deck.tick()))
      : theme().text.faint
  })
  const cwd = createMemo((): string | undefined => {
    try {
      return context.location?.directory || undefined
    } catch {
      return undefined
    }
  })
  const detail = createMemo(() => {
    const tool = agent.lastTool()
    return tool ? toolSummary(tool, 10_000, { cwd: cwd(), pathMax: 10_000 }) : ""
  })
  const ctxLabel = createMemo(() => {
    const pct = agent.ctxRatio()
    if (pct !== undefined) return `ctx ${Math.round(pct * 100)}%`
    const ctx = agent.ctx()
    return ctx !== undefined ? `ctx ${formatTokens(ctx)}` : "starting"
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
    const line = toolsLine() ? `${base} · ${toolsLine()}` : base
    return `${line} · ${rateText(agent.rate())}`
  })

  return (
    <box flexDirection="row" width={props.w} alignItems="stretch">
      <TreeRail
        last={props.last}
        active={running()}
        phase={props.deck.tick()}
        color={agentColor(theme(), props.session.id)}
        w={3}
      />
      <AgentCard w={props.w - 3} color={color()} selected={selected()} onMouseDown={() => props.deck.diveInto(props.session.id)}>
        <box flexDirection="row" justifyContent="space-between" width="100%">
          <box flexDirection="row" flexShrink={1}>
            <Marker color={agentColor(theme(), props.session.id)} />
            <text wrapMode="word" flexGrow={1} flexShrink={1} fg={agentColor(theme(), props.session.id)}>
              <b>{` ${agent.indicator()} ${label()} · ${model()}`}</b>
            </text>
          </box>
          <Show
            when={props.pending}
            fallback={
              <text wrapMode="none" fg={theme().text.muted} flexShrink={0}>
                {clock()}
              </text>
            }
          >
            <text wrapMode="none" fg={theme().text.feedback.warning.base} flexShrink={0}>
              {right()}
            </text>
          </Show>
        </box>
        <Show
          when={props.pending}
          fallback={
            <text wrapMode="word" fg={detail() ? theme().text.muted : theme().text.faint}>
              {`  ${detail() || "waiting"}`}
            </text>
          }
        >
          <text wrapMode="word" fg={theme().text.feedback.warning.base}>
            {`  ! ${maskSecrets(`${props.pending!.action} ${props.pending!.resources[0] ?? ""}`.trim())}`}
          </text>
        </Show>
        <text wrapMode="word" fg={theme().text.faint}>{`  ${statsLine()}`}</text>
      </AgentCard>
    </box>
  )
}

/**
 * Running subagent past the full-card budget as one compact row: the same
 * `├──`/`└──` rail cell (lit head `├●─` while it runs, continuous down the
 * wrapped rows), then `▸ name · model`, with the clock — or a `⚠ needs
 * approval` / `✗ failed` label — on the right. Text wraps instead of being
 * cut. Click opens the agent's session.
 */
function TreeAgentCompact(props: {
  deck: Deck
  session: SessionInfo
  w: number
  last: boolean
  pending?: { action: string; resources: string[] }
}) {
  const context = usePlugin()
  const theme = () => context.theme
  const agent = useAgentState(props.deck, props.session)
  const selected = () => props.deck.agentSel() === props.session.id
  const running = createMemo(() => context.data.session.status(props.session.id) === "running")
  const failed = createMemo(() => agent.status() === "error")
  const clock = createMemo(() => (agent.elapsedMs() !== undefined ? formatElapsed(agent.elapsedMs()!) : "-"))
  const model = createMemo(() => shortModel(agent.model()?.id, 10_000))
  // Right side: the attention label first, then a fresh failure, then the clock.
  const right = createMemo(() => (props.pending ? "⚠ needs approval" : failed() ? "✗ failed" : clock()))
  const rightColor = createMemo(() => {
    if (props.pending) return theme().text.feedback.warning.base
    if (failed()) return theme().text.feedback.error.base
    return theme().text.muted
  })
  // The name wraps under the 3-cell rail, so the label keeps the whole task,
  // and carries the live tokens/sec rate.
  const label = createMemo(
    () => `${agentLabel(props.session, 10_000, 10_000)} · ${formatRate(agent.rate().last ?? agent.rate().avg)} tok/s`,
  )

  return (
    <box
      flexDirection="row"
      width={props.w}
      justifyContent="space-between"
      alignItems="stretch"
      onMouseDown={() => props.deck.diveInto(props.session.id)}
    >
      <TreeRail
        last={props.last}
        active={running()}
        phase={props.deck.tick()}
        color={agentColor(theme(), props.session.id)}
        w={3}
        join={0}
      />
      <box flexDirection="row" flexShrink={1}>
        <text wrapMode="none" flexShrink={0} fg={theme().hue.accent[200]}>{selected() ? "›" : " "}</text>
        <text wrapMode="word" flexGrow={1} flexShrink={1} fg={selected() ? theme().hue.accent[200] : agentColor(theme(), props.session.id)}>
          <b>{` ${agent.indicator()} ${label()} · ${model()}`}</b>
        </text>
      </box>
      <text wrapMode="none" fg={rightColor()} flexShrink={0}>
        {right()}
      </text>
    </box>
  )
}

/** Compact one-line row for a finished (done/errored) subagent:
 * `✓ name · task · model · in/out tokens · duration`; a long task label wraps
 * under the tail instead of being cut.
 * Mark + name carry the agent's colour; the model/tokens/duration tail stays
 * muted (all error.base for a failed agent). */
function DoneRow(props: { deck: Deck; session: SessionInfo; w: number }) {
  const context = usePlugin()
  const theme = () => context.theme
  const agent = useAgentState(props.deck, props.session)
  const failed = createMemo(() => agent.status() === "error")
  const parts = createMemo(() => {
    const mark = failed() ? "✗" : "✓"
    const duration = agent.elapsedMs() !== undefined ? formatDuration(agent.elapsedMs()!) : "-"
    const tail = ` · ${shortModel(agent.model()?.id, 10_000)} · in ${formatTokens(agent.tokens().input)} · out ${formatTokens(agent.tokens().output)} · ${formatRate(agent.rate().avg)} tok/s · ${duration}`
    // Label first so a long task never pushes the model/tokens/duration off.
    const label = agentLabel(props.session, 10_000, 10_000)
    return { mark, label, tail }
  })
  const color = createMemo(() => (failed() ? theme().text.feedback.error.base : agentColor(theme(), props.session.id)))
  return (
    <box flexDirection="row" flexWrap="wrap" onMouseDown={() => props.deck.diveInto(props.session.id)}>
      <text wrapMode="word" flexShrink={1} fg={color()}>
        {`${parts().mark} ${parts().label}`}
      </text>
      <text wrapMode="word" flexShrink={1} fg={failed() ? theme().text.feedback.error.base : theme().text.muted}>
        {parts().tail}
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
      <text wrapMode="word" fg={theme().text.base} width={props.labelW} flexShrink={0}>
        {agentName(props.session, 10_000)}
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

/**
 * One visible row of the Agents tree: depth 1 is a direct child, 2–3 are the
 * running descendants nested under it. `ancestorsLast` carries the `last` flag
 * of every ancestor from depth 1 down to the row's parent, so the render can
 * draw one continuation column per ancestor.
 */
type AgentTreeRow = {
  session: SessionInfo
  depth: number
  last: boolean
  ancestorsLast: boolean[]
}

function AgentsArea(props: { deck: Deck; sessionID: string; w: number; h: number }) {
  const context = usePlugin()
  const theme = () => context.theme

  const children = createMemo(() => props.deck.children(props.sessionID))
  // The main (orchestrator) session always leads the area — cards, lanes and
  // counts — once the host store knows it.
  const main = createMemo(() => context.data.session.get(props.sessionID))
  const all = createMemo(() => (main() ? [main()!, ...children()] : children()))

  // Children waiting on a permission reply count as running: they resume as
  // soon as the gate clears.
  const pendingByAgent = createMemo(() => {
    const map = new Map<string, { action: string; resources: string[] }>()
    for (const request of props.deck.pendingPermissions(props.sessionID)) {
      if (request.sessionID !== props.sessionID && !map.has(request.sessionID)) map.set(request.sessionID, request)
    }
    return map
  })
  const pendingChildIds = createMemo(() => new Set(pendingByAgent().keys()))
  // Failed children (outcome failed, or their last assistant message errored)
  // with the time their run ended. Keyed on session data only — no now(), so
  // the 120ms ticker never rescans message lists.
  const failedChildEnds = createMemo(() => {
    const ends = new Map<string, number>()
    for (const child of children()) {
      const errored =
        child.outcome === "failed" ||
        assistantMessages(context.data.session.message.list(child.id)).findLast((item) => item.error) !== undefined
      if (errored) ends.set(child.id, props.deck.run(child.id)?.end ?? child.time.updated)
    }
    return ends
  })
  // Failed children keep their card for ~30s so the error is visible; only the
  // (small) failed set is aged per tick.
  const recentErrorChildIds = createMemo(() => {
    const now = props.deck.now()
    const ids = new Set<string>()
    for (const [id, end] of failedChildEnds()) if (now - end < 30_000) ids.add(id)
    return ids
  })
  const runningChildren = createMemo(() =>
    children().filter(
      (child) =>
        context.data.session.status(child.id) === "running" ||
        pendingChildIds().has(child.id) ||
        recentErrorChildIds().has(child.id),
    ),
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

  // Pending approvals and fresh errors lead; the newest running branches fill
  // whatever room is left under the orchestrator.
  const shownRunning = createMemo(() => {
    const rank = (child: SessionInfo) =>
      pendingByAgent().has(child.id) ? 0 : recentErrorChildIds().has(child.id) ? 1 : 2
    const sorted = [...runningChildren()].sort((a, b) => rank(a) - rank(b))
    const lead = sorted.filter((child) => rank(child) < 2)
    const rest = sorted.slice(lead.length)
    const room = Math.max(0, MAX_CARDS - lead.length)
    return room === 0 ? lead : [...lead, ...rest.slice(-room)]
  })

  // Vertical budget: ~14 rows of tab chrome (header, tabs, rule, section title)
  // plus the MainCard leaves room for ⌊(h - 20) / 6⌋ cards. Cards wrap text onto
  // extra rows, so each is budgeted 6 rows instead of 5. Running branches past
  // that budget collapse to single wrapped rows, so a busy orchestrator fills
  // the terminal instead of overflowing it.
  const fullCards = createMemo(() => Math.max(1, Math.floor((props.h - 20) / 6)))

  // Flatten the running tree (direct children plus their running descendants,
  // depth 3 max) into display order, so the card budget and the keyboard order
  // both cover nested rows instead of only the first level.
  const flatRows = createMemo((): AgentTreeRow[] => {
    const shown = shownRunning()
    const branching = (session: SessionInfo) =>
      context.data.session.status(session.id) === "running" || pendingByAgent().has(session.id)
    const build = (
      session: SessionInfo,
      depth: number,
      siblingLast: boolean,
      ancestorsLast: boolean[],
    ): AgentTreeRow[] => {
      const kids = depth < MAX_TREE_DEPTH ? props.deck.children(session.id).filter(branching) : []
      // A parent with visible offspring keeps its rail open underneath it.
      const last = siblingLast && kids.length === 0
      const rows: AgentTreeRow[] = [{ session, depth, last, ancestorsLast }]
      kids.forEach((child, index) => {
        rows.push(...build(child, depth + 1, index === kids.length - 1, [...ancestorsLast, last]))
      })
      return rows
    }
    const rows: AgentTreeRow[] = []
    shown.forEach((child, index) => {
      const last = index === shown.length - 1 && shown.length === runningChildren().length
      rows.push(...build(child, 1, last, []))
    })
    return rows
  })
  const rowIds = createMemo(() => flatRows().map((row) => row.session.id))
  const rowsById = createMemo(() => new Map<string, AgentTreeRow>(flatRows().map((row) => [row.session.id, row] as const)))
  // Agents-tab row order, main card first: exposed for ↑/↓ row selection.
  const visibleIds = createMemo(() => {
    const mainSession = main()
    return [...(mainSession ? [mainSession.id] : []), ...flatRows().map((row) => row.session.id)]
  })
  // Publish that order for the keyboard bindings; lanes draw no selectable
  // rows, so they clear it. Unmount must not leave stale ids behind.
  createEffect(() => props.deck.setAgentIds(useLanes() ? [] : visibleIds()))
  onCleanup(() => props.deck.setAgentIds([]))

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
              fallback={<text wrapMode="none" fg={theme().text.faint}>{"   no running agents"}</text>}
            >
              <For each={rowIds()}>
                {(id, index) => {
                  const row = () => rowsById().get(id)!
                  // The budget counts every visible row, nested ones included.
                  const full = () => index() < fullCards()
                  const rowW = () => Math.max(8, inner() - 3 * (row().depth - 1))
                  return (
                    <box flexDirection="row" alignItems="stretch">
                      <For each={row().ancestorsLast}>
                        {(ancestorLast) => <RailSpacer open={!ancestorLast} w={3} />}
                      </For>
                      {full() ? (
                        <TreeAgent
                          deck={props.deck}
                          session={row().session}
                          w={rowW()}
                          pending={pendingByAgent().get(id)}
                          last={row().last}
                        />
                      ) : (
                        <TreeAgentCompact
                          deck={props.deck}
                          session={row().session}
                          w={rowW()}
                          pending={pendingByAgent().get(id)}
                          last={row().last}
                        />
                      )}
                    </box>
                  )
                }}
              </For>
              <Show when={runningChildren().length > shownRunning().length}>
                <text wrapMode="none" fg={theme().text.faint}>{`└─ +${runningChildren().length - shownRunning().length} more`}</text>
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

  // Footer hints: tabs first, then agents-tab selection, then the global
  // pages. `wrap` keeps every hint whole and wraps the row on narrow terms.
  const hintItems = createMemo<readonly [string, string][]>(() => {
    const items: [string, string][] = [["1-4", "tabs"]]
    if (props.deck.fullTab() === "agents") items.push(["j/k", "select"], ["enter", "open"], ["t", "cards/lanes"])
    items.push(["f", "diff"], ["l", "git"], ["u", "usage"], ["?", "help"], ["q", "back"])
    return items
  })

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
                  <AgentsArea deck={props.deck} sessionID={id} w={W()} h={H()} />
                  <AgentTokensPanel deck={props.deck} sessionID={id} w={W()} />
                  <ToolsPanel deck={props.deck} sessionID={id} w={W()} />
                  <GatePanel deck={props.deck} sessionID={id} w={W()} />
                </Match>
                {/* Timeline rows wrap to two terminal rows, so halve the height budget. */}
                <Match when={props.deck.fullTab() === "activity"}>
                  <Timeline deck={props.deck} sessionID={id} w={W()} rows={Math.max(4, Math.floor((H() - 12) / 2))} />
                </Match>
                <Match when={props.deck.fullTab() === "files"}>
                  <FilesPanel deck={props.deck} sessionID={id} w={W()} />
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
            <KeyHints items={hintItems()} w={W()} wrap />
          </>
        )}
      </Show>
    </box>
  )
}
