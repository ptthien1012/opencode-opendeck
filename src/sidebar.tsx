/** @jsxImportSource @opentui/solid */
// Smart compact sidebar (Part 1): Active agents with live rows, a Done
// section collapsed to one header line, activity collapsed to unique rows,
// an MCP section with per-server call counts, and a permission strip —
// every section hidden when it has nothing to say.
// Borderless Grok-CLI style (see ui.tsx): rule-headed sections, ▰▱ ctx
// gauges, ▌ markers, one accent. All rows are truncated to the measured
// slot width and never wrap.

import type { SessionInfo } from "@opencode/client"
import { usePlugin } from "@opencode/plugin/tui"
import type { BoxRenderable } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, onMount, Show } from "solid-js"
import { mixColor, spinner } from "./anim.js"
import { formatElapsed, formatTokens, maskSecrets, shortModel, toolSummary, truncate } from "./format.js"
import { cacheShare, sparkline, toolState, turnSeries } from "./metrics.js"
import type { Deck } from "./state.js"
import {
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
import { Gauge, Marker, Section, glyph } from "./ui.js"

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
  const spark = createMemo(() => sparkline(turnSeries(messages()).map((turn) => turn.output), Math.max(4, props.w() - 17)))
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
          {truncate(`${mainRunning() ? `${spinner(props.deck.tick())} ` : ""}↑${formatTokens(tokens().input)} ↓${formatTokens(tokens().output)}`, props.w() - 14)}
        </text>
        <Show when={stats()?.modelID}>
          <text wrapMode="none" fg={theme().text.faint} flexShrink={0}>
            {shortModel(stats()?.modelID, 12)}
          </text>
        </Show>
      </box>
      <Show when={spark().trim().length > 0}>
        <box flexDirection="row" gap={1}>
          <text wrapMode="none" fg={theme().text.faint}>out</text>
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
      <Section title="mcp" right={`${total()} ${total() === 1 ? "call" : "calls"}`} w={props.w()}>
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
  pending: { action: string; resources: string[] } | undefined
}) {
  const context = usePlugin()
  const theme = () => context.theme
  const agent = useAgentState(props.deck, props.session)

  const clock = createMemo(() => (agent.elapsedMs() !== undefined ? formatElapsed(agent.elapsedMs()!) : "-"))
  // Line 1 leads with a status marker (full-view style): ▌ name · model.
  const title = createMemo(() =>
    truncate(` ${agentName(props.session)} · ${shortModel(agent.model()?.id, 10)}`, Math.max(8, props.w() - clock().length - 2)),
  )
  const ctxLabel = createMemo(() => {
    const pct = agent.ctxRatio()
    if (pct !== undefined) return `${Math.round(pct * 100)}%`
    const ctx = agent.ctx()
    return ctx !== undefined ? formatTokens(ctx) : "-"
  })
  const tokenLabel = createMemo(() => {
    const total = agent.tokens()
    return `↑${formatTokens(total.input)} ↓${formatTokens(total.output)}`
  })
  const detail = createMemo(() => {
    const pend = props.pending
    const base = pend
      ? `! ${maskSecrets(`${pend.action} ${pend.resources[0] ?? ""}`.trim())}`
      : agent.lastTool()
        ? toolSummary(agent.lastTool()!, 60)
        : agent.status()
    const rightW = ctxLabel().length + tokenLabel().length + 1
    return truncate(base, Math.max(6, props.w() - rightW - 3))
  })

  return (
    <box onMouseDown={() => openSessionSafe(context, props.session.id)}>
      <box flexDirection="row" justifyContent="space-between" width="100%">
        <box flexDirection="row">
          <Marker color={agent.statusColor()} />
          <text wrapMode="none" fg={theme().text.base}>
            {title()}
          </text>
        </box>
        <text wrapMode="none" fg={theme().text.muted} flexShrink={0}>
          {clock()}
        </text>
      </box>
      <box flexDirection="row" justifyContent="space-between" width="100%">
        <text wrapMode="none" fg={props.pending ? theme().text.feedback.warning.base : theme().text.muted}>
          {"  "}
          {detail()}
        </text>
        <text wrapMode="none" fg={theme().text.faint} flexShrink={0}>
          {ctxLabel()} {tokenLabel()}
        </text>
      </box>
    </box>
  )
}

function DoneRow(props: { deck: Deck; session: SessionInfo; w: Width }) {
  const context = usePlugin()
  const theme = () => context.theme
  const state = createMemo(() => doneGlyph(props.session))
  const duration = createMemo(() => {
    const run = props.deck.run(props.session.id)
    if (run) return formatElapsed((run.end ?? props.deck.now()) - run.start)
    const span = props.session.time.updated - props.session.time.created
    return span > 0 ? formatElapsed(span) : "-"
  })
  const tokens = createMemo(() => sessionTokens(context, props.session.id))
  const right = createMemo(() => `${duration()} ↑${formatTokens(tokens().input)} ↓${formatTokens(tokens().output)}`)

  return (
    <box
      flexDirection="row"
      justifyContent="space-between"
      width="100%"
      onMouseDown={() => openSessionSafe(context, props.session.id)}
    >
      <text wrapMode="none" fg={state().failed ? theme().text.feedback.error.base : theme().text.muted}>
        {truncate(`${state().glyph} ${agentName(props.session)}`, Math.max(6, props.w() - right().length - 1))}
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
 * header line (`▸ Done 5  ✓4 ✗1`) until clicked. Both hide when empty.
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
    <>
      <Show when={partition().active.length > 0}>
        <Section title="agents" right={`${partition().active.length} active`} w={props.w()}>
          <For each={partition().active}>
            {(child) => <ActiveRow deck={props.deck} session={child} w={inner} pending={pendingByAgent().get(child.id)} />}
          </For>
          <Show when={partition().done.length > 0}>
            <DoneBlock deck={props.deck} done={partition().done} ok={doneCounts().ok} failed={doneCounts().failed} w={inner} />
          </Show>
        </Section>
      </Show>
      <Show when={partition().active.length === 0 && partition().done.length > 0}>
        <box marginTop={1}>
          <DoneBlock deck={props.deck} done={partition().done} ok={doneCounts().ok} failed={doneCounts().failed} w={props.w} />
        </box>
      </Show>
    </>
  )
}

/** --- Activity timeline ------------------------------------------------- */

function ActivitySection(props: { deck: Deck; sessionID: string; w: Width; active: () => SessionInfo[] }) {
  const context = usePlugin()
  const theme = () => context.theme

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
      summary: toolSummary(entry.part, 80),
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
      <Section title="activity" w={props.w()}>
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
            const labelColor = createMemo(() => {
              const normal = part.state.status === "completed" ? theme().text.muted : theme().text.base
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

  const shortcut = createMemo(() => {
    try {
      return context.keymap.shortcuts("opendeck.open")[0] ?? ""
    } catch {
      return ""
    }
  })

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
      <box flexDirection="row" gap={1} onMouseDown={() => props.deck.toggleCollapsed()}>
        <text wrapMode="none" fg={theme().text.faint}>
          {props.deck.collapsed() ? "▶" : "▼"}
        </text>
        <text wrapMode="none" fg={theme().hue.accent[200]}>
          <b>{`${glyph.main} opendeck`}</b>
        </text>
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
          <box marginTop={1} onMouseDown={() => props.deck.openFullview()}>
            <text wrapMode="none" fg={theme().hue.accent[200]}>
              ⤺ back to Opendeck
            </text>
          </box>
        </Show>
        <box flexDirection="row" gap={1} marginTop={1} onMouseDown={() => props.deck.openFullview()}>
          <text wrapMode="none" fg={theme().hue.accent[200]}>
            ⤢ open
          </text>
          <text wrapMode="none" fg={theme().text.faint}>
            {truncate(`· /opendeck${shortcut() ? ` · ${shortcut()}` : ""}`, Math.max(0, w() - 8))}
          </text>
        </box>
      </Show>
    </box>
  )
}
