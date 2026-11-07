/** @jsxImportSource @opentui/solid */
// Smart compact sidebar (Part 1): Active agents with live rows, a Done
// block collapsed to one header line inside the agents section, activity
// collapsed to unique rows, a tool-calls section with per-server MCP
// counts, and a permission strip — every section hidden when it has
// nothing to say.
// Borderless Grok-CLI style (see ui.tsx): rule-headed sections, ▰▱ ctx
// gauges, ▌ markers, one accent. All rows are truncated to the measured
// slot width and never wrap.

import type { SessionInfo } from "@opencode/client"
import { usePlugin } from "@opencode/plugin/tui"
import type { BoxRenderable } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, Index, onMount, Show } from "solid-js"
import { mixColor, pulseLevel, spinner, treeRail } from "./anim.js"
import { formatElapsed, formatTokens, maskSecrets, shortModel, toolSummary, truncate } from "./format.js"
import { cacheShare, formatDuration, formatRate, sparkline, toolState, turnSeries } from "./metrics.js"
import type { Deck } from "./state.js"
import {
  agentDesc,
  agentName,
  assistantMessages,
  collectToolParts,
  collapseRows,
  doneGlyph,
  openSessionSafe,
  sessionTokens,
  toolCallCounts,
  useAgentState,
  useContextStats,
  usePermRecords,
} from "./shared.js"
import { AgentCard, Gauge, Marker, Section, agentColor, cardInner } from "./ui.js"

const DONE_LIMIT = 12
const ACTIVITY_LIMIT = 6
const PERMISSION_LIMIT = 4
const MCP_LIMIT = 8

type Width = () => number

/** --- Context & tokens -------------------------------------------------- */

function ContextLines(props: { deck: Deck; sessionID: string; w: Width }) {
  const context = usePlugin()
  const theme = () => context.theme

  const { stats, ratio } = useContextStats(props.deck, () => props.sessionID)
  const tokens = createMemo(() => sessionTokens(context, props.sessionID))
  const messages = createMemo(() => assistantMessages(context.data.session.message.list(props.sessionID)))
  const cached = createMemo(() => Math.round(cacheShare(messages()) * 100))
  // Output tokens per turn; the host sidebar already shows Context, so the
  // ctx gauge only appears once it is worth a warning (>= 70%).
  const spark = createMemo(() => sparkline(turnSeries(messages()).map((turn) => turn.output), Math.max(4, props.w() - 25)))
  const warn = createMemo(() => (ratio() ?? 0) >= 0.7)
  const mainRunning = createMemo(() => context.data.session.status(props.sessionID) === "running")

  return (
    <box marginBottom={1}>
      <Show when={warn()}>
        <box flexDirection="row" gap={1} width="100%">
          <text wrapMode="none" fg={theme().text.feedback.warning.base}>
            ⚠
          </text>
          <text wrapMode="none" fg={theme().text.muted}>ctx</text>
          <Gauge ratio={ratio()} cells={8} />
          <text wrapMode="none" fg={theme().text.muted}>{`${Math.round((ratio() ?? 0) * 100)}%`}</text>
        </box>
      </Show>
      <box flexDirection="row" justifyContent="space-between" width="100%">
        <text wrapMode="none" fg={mainRunning() ? theme().hue.accent[200] : theme().text.base}>
          {truncate(
            `${mainRunning() ? `${spinner(props.deck.tick())} ` : ""}in ${formatTokens(tokens().input)} · out ${formatTokens(tokens().output)}`,
            props.w() - (stats()?.modelID && props.w() < 34 ? 14 : 1),
          )}
        </text>
        <Show when={stats()?.modelID && props.w() < 34}>
          <text wrapMode="none" fg={theme().text.faint} flexShrink={0}>
            {shortModel(stats()?.modelID, 12)}
          </text>
        </Show>
      </box>
      <Show when={spark().trim().length > 0}>
        <box flexDirection="row" gap={1}>
          <text wrapMode="none" fg={theme().text.faint}>tokens/turn</text>
          <text wrapMode="none" fg={theme().text.feedback.success.base}>{spark()}</text>
          <text wrapMode="none" fg={theme().text.faint} flexShrink={0}>{`cache ${cached()}%`}</text>
        </box>
      </Show>
    </box>
  )
}

/** --- MCP servers -------------------------------------------------------- */

/**
 * One row per MCP server with its call count across the whole family
 * (main + subagents). Max 8 servers shown, the rest collapsed into a
 * `+K more` line; hidden entirely when no MCP calls exist.
 */
function McpSection(props: { deck: Deck; sessionID: string; w: Width }) {
  const context = usePlugin()
  const theme = () => context.theme

  const rows = createMemo(() =>
    toolCallCounts(collectToolParts(context, props.deck.familyIds(props.sessionID))).filter((row) => row.mcp),
  )
  const total = createMemo(() => rows().reduce((sum, row) => sum + row.count, 0))

  return (
    <Show when={rows().length > 0}>
      <Section title="tool calls" right={`${total()} ${total() === 1 ? "call" : "calls"}`} w={props.w()} gap={1}>
        <For each={rows().slice(0, MCP_LIMIT)}>
          {(row) => {
            const label = createMemo(() => truncate(row.key, Math.max(6, props.w() - 2 - `×${row.count}`.length - 1)))
            return (
              <box flexDirection="row" justifyContent="space-between" width="100%">
                <text wrapMode="none" fg={theme().hue.accent[200]}>
                  {label()}
                </text>
                <text wrapMode="none" fg={theme().text.muted} flexShrink={0}>
                  {`×${row.count}`}
                </text>
              </box>
            )
          }}
        </For>
        <Show when={rows().length > MCP_LIMIT}>
          <text wrapMode="none" fg={theme().text.faint}>
            {`+${rows().length - MCP_LIMIT} more`}
          </text>
        </Show>
      </Section>
    </Show>
  )
}

/** --- Agents: Active + Done --------------------------------------------- */

function ActiveRow(props: {
  deck: Deck
  session: SessionInfo
  w: Width
  last: boolean
  pending: { action: string; resources: string[] } | undefined
}) {
  const context = usePlugin()
  const theme = () => context.theme
  const agent = useAgentState(props.deck, props.session)

  const running = createMemo(() => context.data.session.status(props.session.id) === "running")
  const cw = () => cardInner(props.w() - 2)
  const clock = createMemo(() => (agent.elapsedMs() !== undefined ? formatElapsed(agent.elapsedMs()!) : "-"))
  // 2-col tree rail: ancestor bars, the join row, then the sibling tail.
  const rail = createMemo(() =>
    treeRail({ rows: 5, join: 2, last: props.last, active: running(), phase: props.deck.tick(), w: 2 }),
  )
  // Line 1 leads with a status marker (full-view style): ▌ name · model.
  // The shared indicator (launch glyph → spinner → status glyph) sits before the name.
  const title = createMemo(() => {
    const warn = props.pending ? "⚠ " : ""
    return truncate(
      ` ${warn}${agent.indicator()} ${agentName(props.session)} · ${shortModel(agent.model()?.id, 10)}`,
      Math.max(1, cw() - clock().length - 2 - warn.length),
    )
  })
  const ctxLabel = createMemo(() => {
    const pct = agent.ctxRatio()
    if (pct !== undefined) return `${Math.round(pct * 100)}%`
    const ctx = agent.ctx()
    return ctx !== undefined ? formatTokens(ctx) : "-"
  })
  const tokenLabel = createMemo(() => {
    const total = agent.tokens()
    return `in ${formatTokens(total.input)} · out ${formatTokens(total.output)}`
  })
  const cwd = createMemo((): string | undefined => {
    try {
      return context.location?.directory || undefined
    } catch {
      return undefined
    }
  })
  const detail = createMemo(() => {
    const pend = props.pending
    const base = pend
      ? `! ${maskSecrets(`${pend.action} ${pend.resources[0] ?? ""}`.trim())}`
      : agent.lastTool()
        ? toolSummary(agent.lastTool()!, 60, { cwd: cwd() })
        : agent.status()
    return truncate(base, Math.max(6, cw() - 2))
  })

  return (
    <box flexDirection="row" width={props.w()} onMouseDown={() => openSessionSafe(context, props.session.id)}>
      <box flexDirection="column" width={2} flexShrink={0}>
        <Index each={rail()}>
          {(row) => (
            <text wrapMode="none" fg={row().lit ? agentColor(theme(), props.session.id) : theme().text.faint}>
              {row().text}
            </text>
          )}
        </Index>
      </box>
      <AgentCard
        w={props.w() - 2}
        color={
          props.pending
            ? theme().text.feedback.warning.base
            : agent.status() === "error"
              ? theme().text.feedback.error.base
              : running()
                ? mixColor(agent.statusColor(), theme().hue.accent[200], pulseLevel(props.deck.tick()))
                : agent.statusColor()
        }
      >
        <box flexDirection="row" justifyContent="space-between" width="100%">
          <box flexDirection="row">
            <Marker color={agent.statusColor()} />
            <text wrapMode="none" fg={theme().text.base}>
              <b>{title()}</b>
            </text>
          </box>
          <text wrapMode="none" fg={theme().text.muted} flexShrink={0}>
            {clock()}
          </text>
        </box>
        <text wrapMode="none" fg={props.pending ? theme().text.feedback.warning.base : theme().text.muted}>
          {`  ${detail()}`}
        </text>
        <text wrapMode="none" fg={theme().text.faint}>
          {truncate(`  ctx ${ctxLabel()} · ${tokenLabel()} · ${formatRate(agent.rate().last ?? agent.rate().avg)}t/s`, cw())}
        </text>
      </AgentCard>
    </box>
  )
}

/**
 * One active agent card plus its running grandchildren nested underneath
 * (depth 2 max, no deeper recursion). Each grandchild row is prefixed by a
 * 2-col continuation rail so the tree reads as one branch.
 */
function AgentBranch(props: {
  deck: Deck
  session: SessionInfo
  w: Width
  pendingByAgent: () => Map<string, { action: string; resources: string[] }>
  last: boolean
}) {
  const context = usePlugin()
  const theme = () => context.theme

  const grandchildren = createMemo(() =>
    props.deck
      .children(props.session.id)
      .filter(
        (child) => context.data.session.status(child.id) === "running" || props.pendingByAgent().has(child.id),
      ),
  )

  return (
    <box flexDirection="column">
      <ActiveRow
        deck={props.deck}
        session={props.session}
        w={props.w}
        last={props.last}
        pending={props.pendingByAgent().get(props.session.id)}
      />
      <For each={grandchildren()}>
        {(child, index) => (
          <box flexDirection="row" width={props.w()}>
            <box flexDirection="column" width={2} flexShrink={0}>
              <For each={[0, 1, 2, 3, 4]}>
                {() => (
                  <text wrapMode="none" fg={theme().text.faint}>
                    {props.last ? "  " : "│ "}
                  </text>
                )}
              </For>
            </box>
            <ActiveRow
              deck={props.deck}
              session={child}
              w={() => props.w() - 2}
              last={index() === grandchildren().length - 1}
              pending={props.pendingByAgent().get(child.id)}
            />
          </box>
        )}
      </For>
    </box>
  )
}

function DoneRow(props: { deck: Deck; session: SessionInfo; w: Width }) {
  const context = usePlugin()
  const theme = () => context.theme
  const state = createMemo(() => doneGlyph(props.session))
  const duration = createMemo(() => {
    const run = props.deck.run(props.session.id)
    if (run) return formatDuration((run.end ?? props.deck.now()) - run.start)
    const span = props.session.time.updated - props.session.time.created
    return span > 0 ? formatDuration(span) : "-"
  })
  const tokens = createMemo(() => sessionTokens(context, props.session.id))
  const right = createMemo(() => `${duration()} · in ${formatTokens(tokens().input)} · out ${formatTokens(tokens().output)}`)
  // Name plus the first 24 chars of the task, so done rows stay distinguishable.
  const label = createMemo(() => {
    const name = agentName(props.session)
    const desc = agentDesc(props.session)
    return desc ? `${name} · ${truncate(desc, 24)}` : name
  })

  return (
    <box
      flexDirection="row"
      justifyContent="space-between"
      width="100%"
      onMouseDown={() => openSessionSafe(context, props.session.id)}
    >
      <text wrapMode="none" fg={state().failed ? theme().text.feedback.error.base : theme().text.muted}>
        {truncate(`${state().glyph} ${label()}`, Math.max(6, props.w() - right().length - 1))}
      </text>
      <text wrapMode="none" fg={theme().text.faint} flexShrink={0}>
        {right()}
      </text>
    </box>
  )
}

/**
 * Done header (`▸ Done N ✓x ✗y`, click toggles) plus, when open, the compact
 * rows and a `+K more` overflow line. Faint — it is history, not live state.
 */
function DoneBlock(props: { deck: Deck; done: SessionInfo[]; ok: number; failed: number; w: Width }) {
  const context = usePlugin()
  const theme = () => context.theme

  return (
    <>
      <box flexDirection="row" gap={1} onMouseDown={() => props.deck.toggleDone()}>
        <text wrapMode="none" fg={theme().text.faint}>
          {`${props.deck.doneOpen() ? "▾" : "▸"} Done ${props.done.length}`}
        </text>
        <text wrapMode="none" fg={theme().text.feedback.success.base}>
          {`✓${props.ok}`}
        </text>
        <Show when={props.failed > 0}>
          <text wrapMode="none" fg={theme().text.feedback.error.base}>
            {`✗${props.failed}`}
          </text>
        </Show>
      </box>
      <Show when={props.deck.doneOpen()}>
        <For each={props.done.slice(0, DONE_LIMIT)}>
          {(child) => <DoneRow deck={props.deck} session={child} w={props.w} />}
        </For>
        <Show when={props.done.length > DONE_LIMIT}>
          <text wrapMode="none" fg={theme().text.faint}>
            {`+${props.done.length - DONE_LIMIT} more`}
          </text>
        </Show>
      </Show>
    </>
  )
}

/**
 * Active: running agents, agents waiting on a permission reply, and agents
 * finished within the last ~30s. Done: everything else, collapsed to one
 * header line (`▸ Done 5  ✓4 ✗1`) until clicked — always inside the agents
 * section, after the active rows, so the section hides only when there are
 * no children at all.
 */
function AgentsArea(props: { deck: Deck; sessionID: string; w: Width }) {
  const context = usePlugin()
  const theme = () => context.theme

  const pendingByAgent = createMemo(() => {
    const map = new Map<string, { action: string; resources: string[] }>()
    for (const request of props.deck.pendingPermissions(props.sessionID)) {
      if (request.sessionID !== props.sessionID && !map.has(request.sessionID)) map.set(request.sessionID, request)
    }
    return map
  })

  const partition = createMemo(() => {
    const now = props.deck.now()
    const active: SessionInfo[] = []
    const done: SessionInfo[] = []
    for (const child of props.deck.children(props.sessionID)) {
      const running = context.data.session.status(child.id) === "running"
      const run = props.deck.run(child.id)
      const end = run?.end ?? (child.outcome !== undefined ? child.time.updated : undefined)
      const fresh = end !== undefined ? now - end < 30_000 : now - child.time.created < 30_000
      if (running || pendingByAgent().has(child.id) || fresh) active.push(child)
      else done.push(child)
    }
    const startOf = (s: SessionInfo) => props.deck.run(s.id)?.start ?? s.time.created
    const endOf = (s: SessionInfo) => props.deck.run(s.id)?.end ?? s.time.updated
    active.sort((a, b) => {
      const pend = Number(pendingByAgent().has(b.id)) - Number(pendingByAgent().has(a.id))
      if (pend !== 0) return pend
      const runA = context.data.session.status(a.id) === "running"
      const runB = context.data.session.status(b.id) === "running"
      if (runA !== runB) return runA ? -1 : 1
      return runA ? startOf(a) - startOf(b) : endOf(b) - endOf(a)
    })
    done.sort((a, b) => endOf(b) - endOf(a))
    return { active, done }
  })

  const doneCounts = createMemo(() => {
    let ok = 0
    let failed = 0
    for (const child of partition().done) {
      if (doneGlyph(child).failed) failed++
      else ok++
    }
    return { ok, failed }
  })

  // Restore context/elapsed for subagents that predate this TUI.
  createEffect(() => {
    for (const child of props.deck.children(props.sessionID)) {
      if (context.data.session.status(child.id) !== "running") {
        if ((context.data.session.message.list(child.id) ?? []).length === 0) props.deck.hydrateMessages(child.id)
      }
    }
  })

  // Content width inside the section's 2-space indent.
  const inner: Width = () => Math.max(10, props.w() - 2)

  return (
    <Show when={partition().active.length > 0 || partition().done.length > 0}>
      <Section
        title="agents"
        right={partition().active.length > 0 ? `${partition().active.length} active` : undefined}
        w={props.w()}
        gap={1}
      >
        <box flexDirection="column">
          <For each={partition().active}>
            {(child, index) => (
              <AgentBranch
                deck={props.deck}
                session={child}
                w={inner}
                pendingByAgent={pendingByAgent}
                last={index() === partition().active.length - 1}
              />
            )}
          </For>
        </box>
        <Show when={partition().done.length > 0}>
          <DoneBlock deck={props.deck} done={partition().done} ok={doneCounts().ok} failed={doneCounts().failed} w={inner} />
        </Show>
      </Section>
    </Show>
  )
}

/** --- Activity timeline ------------------------------------------------- */

function ActivitySection(props: { deck: Deck; sessionID: string; w: Width; active: () => SessionInfo[] }) {
  const context = usePlugin()
  const theme = () => context.theme

  // Host working directory, so absolute paths in tool rows can render as "./…".
  const activityCwd = createMemo((): string | undefined => {
    try {
      return context.location?.directory || undefined
    } catch {
      return undefined
    }
  })

  // Only the main session + currently active agents, newest first, with
  // consecutive identical rows collapsed into one `×n` row. Max 6 shown.
  const rows = createMemo(() => {
    const live = props.active()
    const ids = [props.sessionID, ...live.map((session) => session.id)]
    const items = collectToolParts(context, ids).map((entry) => ({
      ...entry,
      who:
        entry.sessionID === props.sessionID
          ? undefined
          : agentName(
              live.find((session) => session.id === entry.sessionID) ??
                context.data.session.get(entry.sessionID) ??
                {},
              8,
            ),
      summary: toolSummary(entry.part, 80, { cwd: activityCwd() }),
    }))
    return collapseRows(items, (item) => `${item.who ?? "main"}|${item.part.name}|${item.summary}`).slice(0, ACTIVITY_LIMIT)
  })

  // Flash newly appeared rows (accent → normal over ~1.5s). The first pass
  // only primes the seen set so attaching the TUI doesn't flash history.
  const seenActivity = new Set<string>()
  let activityPrimed = false
  createEffect(() => {
    for (const row of rows()) {
      if (seenActivity.has(row.item.part.id)) continue
      seenActivity.add(row.item.part.id)
      if (activityPrimed) props.deck.flash(row.item.part.id)
    }
    activityPrimed = true
  })

  return (
    <Show when={rows().length > 0}>
      <Section title="activity" w={props.w()} gap={1}>
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
            const label = createMemo(() => {
              const prefix = row.item.who ? `[${row.item.who}] ` : ""
              const suffix = row.count > 1 ? ` ×${row.count}` : ""
              return truncate(`${prefix}${row.item.summary}${suffix}`, Math.max(6, props.w() - 2))
            })
            // Subagent rows read text.base; the session's own rows recede to
            // text.muted so the main-session noise stays in the background.
            const labelColor = createMemo(() => {
              const normal = row.item.who ? theme().text.base : theme().text.muted
              const level = props.deck.flashLevel(part.id)
              if (level <= 0) return normal
              return mixColor(theme().hue.accent[200], normal, 1 - level)
            })
            return (
              <box flexDirection="row" gap={1}>
                <text wrapMode="none" fg={iconColor()}>
                  {iconGlyph()}
                </text>
                <text wrapMode="none" fg={labelColor()}>
                  {label()}
                </text>
              </box>
            )
          }}
        </For>
      </Section>
    </Show>
  )
}

/** --- Permission gate --------------------------------------------------- */

function PermissionsSection(props: { deck: Deck; sessionID: string; w: Width }) {
  const context = usePlugin()
  const theme = () => context.theme

  // Ask the host store once per family session so pending requests made before
  // this TUI attached still show up.
  createEffect(() => {
    for (const id of props.deck.familyIds(props.sessionID)) props.deck.hydratePermissions(id)
  })

  const { records, pending } = usePermRecords(props.deck, () => props.sessionID)
  const shown = createMemo(() => [...records()].reverse().slice(0, PERMISSION_LIMIT))
  // Pending requests pulse between warning base/muted (~0.5s per phase).
  const pulse = createMemo(() => Math.floor(props.deck.tick() / 4) % 2 === 0)

  return (
    <Show when={records().length > 0}>
      <Section
        title="permissions"
        right={pending().length > 0 ? `${pending().length} pending` : undefined}
        w={props.w()}
        gap={1}
      >
        <For each={shown()}>
          {(record) => {
            const glyph = record.pending ? "!" : record.reply === "reject" ? "✗" : "✓"
            const normalColor = record.pending
              ? theme().text.feedback.warning.base
              : record.reply === "reject"
                ? theme().text.feedback.error.base
                : theme().text.muted
            const glyphColor = createMemo(() =>
              record.pending && !pulse() ? theme().text.feedback.warning.muted : normalColor,
            )
            const label = createMemo(() => {
              const resource = record.resources[0] ?? record.message ?? ""
              return truncate(maskSecrets(`${record.action}${resource ? ` ${resource}` : ""}`), Math.max(6, props.w() - 2))
            })
            const labelColor = createMemo(() => {
              const normal = record.pending ? theme().text.base : theme().text.muted
              const level = props.deck.flashLevel(record.id)
              if (level <= 0) return normal
              return mixColor(theme().hue.accent[200], normal, 1 - level)
            })
            return (
              <box flexDirection="row" gap={1}>
                <text wrapMode="none" fg={glyphColor()}>
                  {glyph}
                </text>
                <text wrapMode="none" fg={labelColor()}>
                  {label()}
                </text>
              </box>
            )
          }}
        </For>
      </Section>
    </Show>
  )
}

/** --- Root -------------------------------------------------------------- */

export function Sidebar(props: { deck: Deck; sessionID: string }) {
  const context = usePlugin()
  const theme = () => context.theme

  // The sidebar slot publishes no width, so measure our own root box and
  // truncate every row to fit. Falls back to a sane narrow default pre-layout.
  let rootRef: BoxRenderable | undefined
  const [measured, setMeasured] = createSignal(0)
  onMount(() => setMeasured(rootRef?.width ?? 0))
  const w = createMemo(() => Math.max(20, measured() || 30))
  // Model for the opendeck header line once the slot is wide enough; below
  // that it stays at the end of the in/out row (ContextLines).
  const { stats } = useContextStats(props.deck, () => props.sessionID)
  const model = createMemo(() => stats()?.modelID)

  const children = createMemo(() => props.deck.children(props.sessionID))
  const activeAgents = createMemo(() => {
    // re-derives the same "active" set AgentsArea shows, for Activity scoping
    const now = props.deck.now()
    const pending = new Set(
      props.deck.pendingPermissions(props.sessionID).map((request) => request.sessionID),
    )
    return children().filter((child) => {
      if (context.data.session.status(child.id) === "running") return true
      if (pending.has(child.id)) return true
      const run = props.deck.run(child.id)
      const end = run?.end ?? (child.outcome !== undefined ? child.time.updated : undefined)
      return end !== undefined ? now - end < 30_000 : now - child.time.created < 30_000
    })
  })

  const mainRunning = createMemo(() => context.data.session.status(props.sessionID) === "running")
  const pendingCount = createMemo(() => props.deck.pendingPermissions(props.sessionID).length)
  const hasActivity = createMemo(() =>
    (context.data.session.message.list(props.sessionID) ?? []).some(
      (msg) => msg.type === "assistant" && msg.content.some((part) => part.type === "tool"),
    ),
  )
  // Nothing happening at all → just the context line plus a dim idle hint.
  const idle = createMemo(
    () =>
      !mainRunning() &&
      children().length === 0 &&
      activeAgents().length === 0 &&
      pendingCount() === 0 &&
      !hasActivity(),
  )

  return (
    <box
      width="100%"
      marginBottom={1}
      ref={(r: BoxRenderable) => {
        rootRef = r
      }}
      onSizeChange={() => {
        const next = rootRef?.width ?? 0
        if (next > 0 && next !== measured()) setMeasured(next)
      }}
    >
      <box flexDirection="row" justifyContent="space-between" width="100%">
        <box flexDirection="row" onMouseDown={() => props.deck.toggleCollapsed()}>
          <text wrapMode="none" fg={theme().hue.accent[200]}>
            <b>{props.deck.collapsed() ? "▸ opendeck" : "▾ opendeck"}</b>
          </text>
        </box>
        <Show when={!props.deck.collapsed() && w() >= 34 && model()}>
          <text wrapMode="none" fg={theme().text.faint} flexShrink={0}>
            {shortModel(model(), 12)}
          </text>
        </Show>
      </box>
      <Show when={!props.deck.collapsed()}>
        <ContextLines deck={props.deck} sessionID={props.sessionID} w={w} />
        <Show when={idle()}>
          <text wrapMode="none" fg={theme().text.faint}>
            {"  "}· idle
          </text>
        </Show>
        <McpSection deck={props.deck} sessionID={props.sessionID} w={w} />
        <AgentsArea deck={props.deck} sessionID={props.sessionID} w={w} />
        <ActivitySection deck={props.deck} sessionID={props.sessionID} w={w} active={activeAgents} />
        <PermissionsSection deck={props.deck} sessionID={props.sessionID} w={w} />
        <Show when={props.deck.returnPending()}>
          <box onMouseDown={() => props.deck.openFullview()}>
            <text wrapMode="none" fg={theme().hue.accent[200]}>
              ⤺ back to Opendeck
            </text>
          </box>
        </Show>
      </Show>
      <box flexDirection="row" gap={1} onMouseDown={() => props.deck.openFullview()}>
        <text wrapMode="none" fg={theme().hue.accent[200]}>
          ⤢ open
        </text>
        <text wrapMode="none" fg={theme().text.faint}>
          {truncate("· /opendeck", Math.max(0, w() - 8))}
        </text>
      </box>
    </box>
  )
}
