/** @jsxImportSource @opentui/solid */
// Extra full-view panels: terminal charts (tokens per turn, ctx % per turn,
// tokens per agent), session stats, recent tool errors and files touched.
// Read-only memos over the host store; no timers, no writes. All numbers come
// from the pure helpers in metrics.ts.

import { usePlugin } from "@opencode/plugin/tui"
import { createMemo, For, Show } from "solid-js"
import { formatClock, formatTokens, maskSecrets, shortPath } from "./format.js"
import { cacheShare, diffFromTools, filesTouched, formatDuration, recentErrors, sessionStats, sparkline, turnSeries } from "./metrics.js"
import { agentName, assistantMessages, collectToolParts, sessionTokens } from "./shared.js"
import type { Deck } from "./state.js"
import { agentColor, AgentCard, bar, cardInner, Section } from "./ui.js"

const ERROR_ROWS = 4
const FILE_ROWS = 6
const AGENT_BARS = 6

type PanelProps = { deck: Deck; sessionID: string; w: number }

/** Sparklines of input/output tokens and ctx % per assistant turn (main session). */
export function ChartsPanel(props: PanelProps) {
  const context = usePlugin()
  const theme = () => context.theme
  const messages = createMemo(() => assistantMessages(context.data.session.message.list(props.sessionID)))
  const turns = createMemo(() => turnSeries(messages()))
  const limit = createMemo(() => {
    const model = messages().at(-1)?.model ?? context.data.session.get(props.sessionID)?.model
    return props.deck.modelLimit(model ? { id: model.id, providerID: model.providerID } : undefined)
  })
  const labelW = 7
  // the numeric tail is right-aligned in a fixed slot at the end of the row,
  // so the sparkline stretches across everything left of it
  const tailW = 7
  const chartW = createMemo(() => Math.max(8, props.w - 2 - labelW - 1 - tailW - 1))
  const last = createMemo(() => turns().at(-1))
  const ctxPct = createMemo(() => {
    const max = limit()
    return max ? turns().map((turn) => (turn.ctx / max) * 100) : []
  })

  return (
    <Show when={turns().length > 0}>
      <Section title="charts" right={`${turns().length} turns`} w={props.w}>
        <box flexDirection="row" gap={1} width="100%" justifyContent="space-between">
          <box flexDirection="row" gap={1} flexShrink={0}>
            <text wrapMode="none" fg={theme().text.muted} width={labelW} flexShrink={0}>in</text>
            <text wrapMode="none" fg={theme().hue.accent[200]}>{sparkline(turns().map((turn) => turn.input), chartW())}</text>
          </box>
          <text wrapMode="none" fg={theme().text.faint} flexShrink={0}>{formatTokens(last()?.input ?? 0).padStart(tailW)}</text>
        </box>
        <box flexDirection="row" gap={1} width="100%" justifyContent="space-between">
          <box flexDirection="row" gap={1} flexShrink={0}>
            <text wrapMode="none" fg={theme().text.muted} width={labelW} flexShrink={0}>out</text>
            <text wrapMode="none" fg={theme().text.feedback.success.base}>{sparkline(turns().map((turn) => turn.output), chartW())}</text>
          </box>
          <text wrapMode="none" fg={theme().text.faint} flexShrink={0}>{formatTokens(last()?.output ?? 0).padStart(tailW)}</text>
        </box>
        <Show when={ctxPct().length > 0}>
          <box flexDirection="row" gap={1} width="100%" justifyContent="space-between">
            <box flexDirection="row" gap={1} flexShrink={0}>
              <text wrapMode="none" fg={theme().text.muted} width={labelW} flexShrink={0}>ctx %</text>
              <text wrapMode="none" fg={(ctxPct().at(-1) ?? 0) >= 70 ? theme().text.feedback.warning.base : theme().hue.accent[200]}>
                {sparkline(ctxPct(), chartW(), 100)}
              </text>
            </box>
            <text wrapMode="none" fg={theme().text.faint} flexShrink={0}>{`${Math.round(ctxPct().at(-1) ?? 0)}%`.padStart(tailW)}</text>
          </box>
        </Show>
      </Section>
    </Show>
  )
}

/** Horizontal bars of total tokens (in + out) per agent: main first, then subagents. */
export function AgentTokensPanel(props: PanelProps) {
  const context = usePlugin()
  const theme = () => context.theme
  const rows = createMemo(() => {
    const main = context.data.session.get(props.sessionID)
    const out: { id: string; label: string; total: number }[] = []
    const mainTokens = sessionTokens(context, props.sessionID)
    out.push({ id: props.sessionID, label: main?.agent ?? "main", total: mainTokens.input + mainTokens.output })
    for (const child of props.deck.children(props.sessionID)) {
      const tokens = sessionTokens(context, child.id)
      out.push({ id: child.id, label: agentName(child, 10_000), total: tokens.input + tokens.output })
    }
    const [first, ...rest] = out
    rest.sort((a, b) => b.total - a.total)
    return first ? [first, ...rest] : rest
  })
  const max = createMemo(() => Math.max(0, ...rows().map((row) => row.total)))
  const inner = createMemo(() => cardInner(props.w - 2))

  return (
    <Show when={rows().length > 1 && max() > 0}>
      <Section title="tokens by agent" w={props.w}>
        <AgentCard w={props.w - 2} color={theme().text.faint}>
          <box flexDirection="column" gap={1}>
            <For each={rows().slice(0, AGENT_BARS)}>
              {(row) => (
                <box flexDirection="column" onMouseDown={() => props.deck.diveInto(row.id)}>
                  <box flexDirection="row" justifyContent="space-between" width="100%">
                    <text wrapMode="word" fg={agentColor(theme(), row.id)} flexGrow={1} flexShrink={1}>
                      <b>{row.label}</b>
                    </text>
                    <text wrapMode="none" fg={theme().text.muted} flexShrink={0}>
                      {formatTokens(row.total)}
                    </text>
                  </box>
                  {bar(
                    row.total,
                    max(),
                    inner(),
                    agentColor(theme(), row.id),
                    theme().text.faint,
                    Number.POSITIVE_INFINITY,
                  )}
                </box>
              )}
            </For>
            <Show when={rows().length > AGENT_BARS}>
              <text wrapMode="none" fg={theme().text.faint}>+{rows().length - AGENT_BARS} more</text>
            </Show>
          </box>
        </AgentCard>
      </Section>
    </Show>
  )
}

/** Session numbers: duration, prompts/replies, tok/s, cache hit, compactions. */
export function StatsPanel(props: PanelProps) {
  const context = usePlugin()
  const theme = () => context.theme
  const stats = createMemo(() => sessionStats(context.data.session.message.list(props.sessionID)))
  const cache = createMemo(() => cacheShare(assistantMessages(context.data.session.message.list(props.sessionID))))
  const line1 = createMemo(() => {
    const s = stats()
    return `${formatDuration(s.durationMs)} · ${s.prompts} prompts · ${s.replies} replies`
  })
  const line2 = createMemo(() => {
    const s = stats()
    const tps = s.tps !== undefined ? `${s.tps.toFixed(1)} tok/s` : "- tok/s"
    const read = Math.round(s.cacheHit * 100)
    const write = Math.max(0, Math.round(cache() * 100) - read)
    return `${tps} · cache read ${read}% · write ${write}%`
  })

  return (
    <Show when={stats().replies > 0}>
      <Section title="session" right={stats().compactions > 0 ? `${stats().compactions} compactions` : undefined} w={props.w}>
        <text wrapMode="word" fg={theme().text.base}>{line1()}</text>
        <text wrapMode="word" fg={theme().text.muted}>{line2()}</text>
      </Section>
    </Show>
  )
}

/** Newest errored tool calls across the family; click a row to open its session. */
export function ErrorsPanel(props: PanelProps) {
  const context = usePlugin()
  const theme = () => context.theme
  const errors = createMemo(() => recentErrors(collectToolParts(context, props.deck.familyIds(props.sessionID)), ERROR_ROWS))
  const who = (sessionID: string) => {
    if (sessionID === props.sessionID) return "main"
    const session = context.data.session.get(sessionID)
    return session ? agentName(session, 10_000) : "agent"
  }

  return (
    <Show when={errors().length > 0}>
      <Section title="errors" titleColor={theme().text.feedback.error.base} w={props.w}>
        <For each={errors()}>
          {(error) => (
            <box onMouseDown={() => props.deck.diveInto(error.sessionID)}>
              <text wrapMode="word" fg={theme().text.feedback.error.base}>
                {`✗ ${formatClock(error.created)} ${who(error.sessionID)} · ${error.name}: ${maskSecrets(error.message)}`}
              </text>
            </box>
          )}
        </For>
      </Section>
    </Show>
  )
}

/** Files changed per agent (assistant snapshot.files), main first. */
export function FilesPanel(props: PanelProps) {
  const context = usePlugin()
  const theme = () => context.theme
  // Per agent: files from snapshot.files, with +/- counts from that agent's
  // edit tool metadata when available. Click a file to open the diff page.
  const groups = createMemo(() => {
    const ids = props.deck.familyIds(props.sessionID)
    const out: { id: string; who: string; files: { file: string; status: string; adds?: number; dels?: number }[] }[] = []
    for (const id of ids) {
      const stats = new Map(diffFromTools(collectToolParts(context, [id])).map((diff) => [diff.file, diff]))
      const names = filesTouched(assistantMessages(context.data.session.message.list(id)))
      for (const file of stats.keys()) if (!names.includes(file)) names.push(file)
      if (names.length === 0) continue
      const session = context.data.session.get(id)
      out.push({
        id,
        who: id === props.sessionID ? (session?.agent ?? "main") : session ? agentName(session, 10_000) : "agent",
        files: names.map((file) => {
          const hit = stats.get(file)
          return { file, status: hit?.status ?? "modified", adds: hit?.additions, dels: hit?.deletions }
        }),
      })
    }
    return out
  })
  const total = createMemo(() => groups().reduce((sum, group) => sum + group.files.length, 0))
  const glyph = (status: string) => (status === "added" ? "A" : status === "deleted" ? "D" : "M")

  return (
    <Show when={total() > 0}>
      <Section title="files changed" right={`${total()} · f diff`} w={props.w}>
        <For each={groups()}>
          {(group) => (
            <box flexDirection="column">
              <text wrapMode="word" fg={agentColor(theme(), group.id)}>{`${group.who} (${group.files.length})`}</text>
              <For each={group.files.slice(-FILE_ROWS)}>
                {(entry) => {
                  const counts = entry.adds !== undefined ? ` +${entry.adds} -${entry.dels ?? 0}` : ""
                  return (
                    <box flexDirection="row" justifyContent="space-between" width="100%" onMouseDown={() => props.deck.openDiff(entry.file, props.sessionID)}>
                      <text wrapMode="word" fg={theme().text.muted} flexGrow={1} flexShrink={1}>
                        {`  ${glyph(entry.status)} ${maskSecrets(shortPath(entry.file, { max: 10_000 }))}`}
                      </text>
                      <Show when={counts}>
                        <box flexDirection="row" flexShrink={0}>
                          <text wrapMode="none" fg={theme().text.feedback.success.base}>{` +${entry.adds}`}</text>
                          <text wrapMode="none" fg={theme().text.feedback.error.base}>{` -${entry.dels ?? 0}`}</text>
                        </box>
                      </Show>
                    </box>
                  )
                }}
              </For>
              <Show when={group.files.length > FILE_ROWS}>
                <text wrapMode="none" fg={theme().text.faint}>{`  +${group.files.length - FILE_ROWS} earlier`}</text>
              </Show>
            </box>
          )}
        </For>
      </Section>
    </Show>
  )
}
