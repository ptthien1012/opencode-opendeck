/** @jsxImportSource @opentui/solid */
// Smart compact sidebar: header, one ctx line, pending approvals, active
// agents (Done collapsed to one header line inside that section), back
// link, footer — every section hidden when it has nothing to say.
// Borderless Grok-CLI style (see ui.tsx): rule-headed sections, ▰▱ ctx
// gauges, ▌ markers, one accent. All rows are truncated to the measured
// slot width and never wrap.

import type { SessionInfo } from "@opencode/client"
import { usePlugin } from "@opencode/plugin/tui"
import type { BoxRenderable } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, Index, onMount, Show } from "solid-js"
import { mixColor, pulseLevel, spinner, treeRail } from "./anim.js"
import { formatElapsed, formatTokens, maskSecrets, shortModel, toolSummary, truncate } from "./format.js"
import { formatDuration } from "./metrics.js"
import type { Deck } from "./state.js"
import {
  agentDesc,
  agentName,
  doneGlyph,
  openSessionSafe,
  sessionTokens,
  useAgentState,
  useContextStats,
  usePermRecords,
} from "./shared.js"
import { AgentCard, Gauge, Marker, Section, agentColor, cardInner } from "./ui.js"

const DONE_LIMIT = 12

type Width = () => number

/** --- Context & tokens -------------------------------------------------- */

function ContextLines(props: { deck: Deck; sessionID: string; w: Width }) {
  const context = usePlugin()
  const theme = () => context.theme

  const { stats, ratio } = useContextStats(props.deck, () => props.sessionID)
  const tokens = createMemo(() => sessionTokens(context, props.sessionID))
  const mainRunning = createMemo(() => context.data.session.status(props.sessionID) === "running")
  const pct = createMemo(() => `${Math.round((ratio() ?? 0) * 100)}%`)
  // One colour for the whole ctx cluster: accent while healthy, warning near
  // the limit, error past it.
  const ctxColor = createMemo(() => {
    const value = ratio() ?? 0
    if (value > 0.85) return theme().text.feedback.error.base
    if (value >= 0.7) return theme().text.feedback.warning.base
    return theme().hue.accent[200]
  })
  // Room left for `· in X · out Y` after spinner + ctx + gauge + pct, and the
  // model slot on the right when the sidebar is too narrow for the header.
  const ioWidth = createMemo(() => {
    const reserve = stats()?.modelID && props.w() < 34 ? 14 : 1
    return Math.max(6, props.w() - reserve - pct().length - 9 - (mainRunning() ? 5 : 3))
  })

  return (
    <box marginBottom={1}>
      <box flexDirection="row" justifyContent="space-between" width="100%">
        <box flexDirection="row" gap={1}>
          <Show when={mainRunning()}>
            <text wrapMode="none" fg={theme().hue.accent[200]}>
              {spinner(props.deck.tick())}
            </text>
          </Show>
          <text wrapMode="none" fg={ctxColor()}>
            ctx
          </text>
          <Gauge ratio={ratio()} cells={6} />
          <text wrapMode="none" fg={ctxColor()}>
            {pct()}
          </text>
          <text wrapMode="none" fg={theme().text.base}>
            {truncate(`· in ${formatTokens(tokens().input)} · out ${formatTokens(tokens().output)}`, ioWidth())}
          </text>
        </box>
        <Show when={stats()?.modelID && props.w() < 34}>
          <text wrapMode="none" fg={theme().text.faint} flexShrink={0}>
            {shortModel(stats()?.modelID, 12)}
          </text>
        </Show>
      </box>
    </box>
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

/** --- Permission gate --------------------------------------------------- */

function PermissionsSection(props: { deck: Deck; sessionID: string; w: Width }) {
  const context = usePlugin()
  const theme = () => context.theme

  // Ask the host store once per family session so pending requests made before
  // this TUI attached still show up.
  createEffect(() => {
    for (const id of props.deck.familyIds(props.sessionID)) props.deck.hydratePermissions(id)
  })

  const { pending } = usePermRecords(props.deck, () => props.sessionID)
  // Pending requests pulse between warning base/muted (~0.5s per phase).
  const pulse = createMemo(() => Math.floor(props.deck.tick() / 4) % 2 === 0)

  return (
    <Show when={pending().length > 0}>
      <Section
        title="needs approval"
        right={`${pending().length} pending`}
        titleColor={theme().text.feedback.warning.base}
        w={props.w()}
        gap={1}
      >
        <For each={pending()}>
          {(record) => {
            // Pending rows pulse between warning base/muted, same beat as the title.
            const glyphColor = createMemo(() =>
              pulse() ? theme().text.feedback.warning.base : theme().text.feedback.warning.muted,
            )
            const label = createMemo(() => {
              const resource = record.resources[0] ?? record.message ?? ""
              return truncate(maskSecrets(`${record.action}${resource ? ` ${resource}` : ""}`), Math.max(6, props.w() - 2))
            })
            const labelColor = createMemo(() => {
              const normal = theme().text.base
              const level = props.deck.flashLevel(record.id)
              if (level <= 0) return normal
              return mixColor(theme().hue.accent[200], normal, 1 - level)
            })
            return (
              <box flexDirection="row" gap={1}>
                <text wrapMode="none" fg={glyphColor()}>
                  !
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
        <PermissionsSection deck={props.deck} sessionID={props.sessionID} w={w} />
        <AgentsArea deck={props.deck} sessionID={props.sessionID} w={w} />
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
