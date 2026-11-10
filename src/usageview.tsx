/** @jsxImportSource @opentui/solid */
// Usage page (plugin route "opendeck-usage"): token/cache/model/tool totals
// over 30d / 90d / 1y from client.session.stats, all projects or the current
// one, with a GitHub-style activity heatmap and a braille line chart of steps
// per day. 1/2/3 range, p scope, j/k (or wheel) scroll models, r reload,
// esc back. Borderless Grok-CLI style; no timers.

import type { SessionStatsInfo } from "@opencode/client"
import { usePlugin } from "@opencode/plugin/tui"
import type { BoxRenderable, RGBA } from "@opentui/core"
import { createMemo, createResource, createSignal, For, onMount, Show } from "solid-js"
import { fit, maskSecrets, truncate } from "./format.js"
import type { Deck } from "./state.js"
import { Gauge, KeyHints, Rule, ScrollList, Section, TabBar, glyph } from "./ui.js"
import {
  RANGE_DAYS,
  brailleChart,
  bucket,
  cacheHit,
  compact,
  dailySeries,
  heatmapGrid,
  modelRows,
  type ModelRow,
  type UsageRange,
} from "./usage.js"

const HEAT = [" ", "·", "▪", "■", "■"] as const
const DAYS = ["Mon", "   ", "Wed", "   ", "Fri", "   ", "Sun"] as const

export function UsageView(props: { deck: Deck; sessionID?: string }) {
  const context = usePlugin()
  const theme = () => context.theme
  const deck = props.deck

  let rootRef: BoxRenderable | undefined
  const [measured, setMeasured] = createSignal(0)
  onMount(() => setMeasured(rootRef?.width ?? context.renderer.terminalWidth ?? 120))
  const W = createMemo(() => Math.max(48, (measured() || context.renderer.terminalWidth || 120) - 2))
  const H = createMemo(() => context.renderer.terminalHeight ?? 40)

  const projectID = createMemo(() => {
    const id = props.sessionID
    if (!id) return undefined
    try {
      return context.data.session.get(id)?.projectID
    } catch {
      return undefined
    }
  })

  const [stats] = createResource(
    () => ({
      range: deck.usageRange(),
      project: deck.usageScope() === "project" ? projectID() : undefined,
      scope: deck.usageScope(),
      tick: deck.usageTick(),
    }),
    async (key): Promise<{ data?: SessionStatsInfo; error?: string; at: number }> => {
      const now = Date.now()
      try {
        let timezone: string | undefined
        try {
          timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
        } catch {
          timezone = undefined
        }
        const data = await context.client.session.stats({
          from: now - RANGE_DAYS[key.range] * 86_400_000,
          to: now,
          tools: "detail",
          ...(key.project ? { project: key.project } : {}),
          ...(timezone ? { timezone } : {}),
        })
        return { data, at: now }
      } catch (error) {
        const message = (error as { message?: unknown })?.message ?? error
        return { error: String(message), at: now }
      }
    },
  )
  const data = createMemo(() => stats()?.data)

  // --- layout ---------------------------------------------------------------
  const colW = createMemo(() => Math.floor((W() - 2) / 2))
  const inner = createMemo(() => colW() - 2)

  // --- activity ---------------------------------------------------------------
  const series = createMemo(() => dailySeries(data()?.activity ?? [], RANGE_DAYS[deck.usageRange()], stats()?.at ?? Date.now()))
  const grid = createMemo(() => heatmapGrid(series()))
  const maxDay = createMemo(() => Math.max(0, ...series().map((item) => item.value)))
  const avgDay = createMemo(() => {
    const active = series().filter((item) => item.value > 0)
    return active.length > 0 ? active.reduce((sum, item) => sum + item.value, 0) / active.length : 0
  })
  const heatW = createMemo(() => Math.max(1, W() - 2 - 4))
  // A heatmap column is 2 chars ("■ "), so show the newest weeks that fit.
  const heatCols = createMemo(() => Math.max(1, Math.floor(heatW() / 2)))
  const chartW = createMemo(() => Math.max(4, W() - 2 - 10 - 1))
  // Fixed width: bucket long ranges down, repeat short ones so 30d still
  // spans the panel (each day becomes a few dot columns).
  const chart = createMemo(() => {
    const values = series().map((item) => item.value)
    const cols = chartW() * 2
    const fitted =
      values.length >= cols
        ? bucket(values, cols)
        : Array.from({ length: cols }, (_, i) => values[Math.floor((i * values.length) / cols)] ?? 0)
    return brailleChart(fitted, 4)
  })

  function heatColor(value: number): RGBA {
    if (value <= 0) return theme().text.faint
    if (value === 1) return theme().hue.accent[500]
    if (value === 2) return theme().hue.accent[400]
    return theme().hue.accent[200]
  }

  // --- models -------------------------------------------------------------------
  const models = createMemo(() => modelRows(data()?.models ?? []))
  const maxModel = createMemo(() => Math.max(0, ...models().map((row) => row.total)))
  // header 3 · overview 7 · activity 13 · models title 1 · tools 9 · hints 1
  const fixedH = 3 + 7 + 13 + 1 + 9 + 1
  const modelH = createMemo(() => Math.max(3, H() - fixedH - 4))
  const modelTop = createMemo(() => Math.max(0, Math.min(Math.max(0, models().length - modelH()), deck.usageTop())))

  // Name column and bar shrink on narrow terminals; numbers keep 8 cols.
  const NUM_W = 8
  const nameW = createMemo(() => Math.min(30, Math.max(12, W() - 3 - NUM_W * 5 - 4 - 4)))
  function renderModel(row: ModelRow) {
    const barW = Math.max(0, Math.min(30, W() - 3 - 2 - nameW() - NUM_W * 5 - 2))
    const filled = maxModel() > 0 ? Math.max(row.total > 0 ? 1 : 0, Math.round((row.total / maxModel()) * barW)) : 0
    const name = `${row.id}${row.variant ? ` #${row.variant}` : ""} · ${row.provider}`
    return (
      <box flexDirection="row" width={W() - 3}>
        <text wrapMode="none" flexShrink={0} fg={theme().text.base}>{`  ${fit(name, nameW())}`}</text>
        <text wrapMode="none" flexShrink={0} fg={theme().text.muted}>{fit(compact(row.steps), NUM_W, true)}</text>
        <text wrapMode="none" flexShrink={0} fg={theme().text.base}>{fit(compact(row.input), NUM_W, true)}</text>
        <text wrapMode="none" flexShrink={0} fg={theme().hue.accent[200]}>{fit(compact(row.cacheRead), NUM_W, true)}</text>
        <text wrapMode="none" flexShrink={0} fg={theme().text.feedback.success.base}>{fit(compact(row.output + row.reasoning), NUM_W, true)}</text>
        <text wrapMode="none" flexShrink={0} fg={theme().text.muted}>{fit(compact(row.total), NUM_W, true)}</text>
        <text wrapMode="none" flexShrink={0} fg={theme().hue.accent[200]}>{`  ${"█".repeat(Math.max(0, filled))}`}</text>
        <text wrapMode="none" flexShrink={0} fg={theme().text.faint}>{"░".repeat(Math.max(0, barW - filled))}</text>
      </box>
    )
  }

  // --- tools ---------------------------------------------------------------------
  const tools = createMemo(() => {
    const t = data()?.tools
    return t && t.mode === "detail" ? [...t.usage].sort((a, b) => b.calls - a.calls).slice(0, 6) : []
  })
  const toolTotals = createMemo(() => {
    const t = data()?.tools
    return t && t.mode !== "none" ? t.totals : undefined
  })
  const maxTool = createMemo(() => Math.max(0, ...tools().map((tool) => tool.calls)))

  // --- header --------------------------------------------------------------------
  const ranges: UsageRange[] = ["30d", "90d", "1y"]
  const updated = createMemo(() => {
    const at = stats()?.at
    return at ? new Date(at).toTimeString().slice(0, 5) : ""
  })

  // --- header budget -------------------------------------------------------------
  // Title + tab strip + the scope/updated tail must all fit the measured width.
  // The tab strip takes its shortened form first, then `updated` is dropped,
  // then the scope label is cut to whatever cells remain.
  const TITLE_W = 18 // `${glyph.main} opendeck · usage`
  const tabW = createMemo(() => Math.max(19, Math.min(22, W() - TITLE_W - 12)))
  const headerBudget = createMemo(() => Math.max(0, W() - TITLE_W - tabW() - 4))
  const scopeFull = createMemo(() => (deck.usageScope() === "all" ? "· [all] project" : "· all [project]"))
  const updatedFull = createMemo(() => (updated() ? `updated ${updated()}` : ""))
  // The loading hint counts as taken space so it never pushes the strip over.
  const loadingW = createMemo(() => (stats.loading ? 8 : 0))
  const showUpdated = createMemo(
    () => updatedFull() !== "" && headerBudget() >= scopeFull().length + 1 + updatedFull().length + loadingW(),
  )
  const scopeShown = createMemo(() =>
    truncate(scopeFull(), Math.max(0, headerBudget() - (showUpdated() ? updatedFull().length + 1 : 0) - loadingW())),
  )
  const updatedShown = createMemo(() => (showUpdated() ? updatedFull() : ""))

  // 10 label + 9 value + 1 + gauge + 5 pct; the gauge absorbs narrow widths.
  const gaugeCells = createMemo(() => Math.max(0, Math.min(10, inner() - 25)))
  function tokenRow(label: string, value: number, share: number, color: RGBA) {
    return (
      <box flexDirection="row" width={inner()}>
        <text wrapMode="none" flexShrink={0} fg={theme().text.muted}>{fit(label, 10)}</text>
        <text wrapMode="none" flexShrink={0} fg={color}>{fit(compact(value), 9, true)}</text>
        <text wrapMode="none" flexShrink={0}>{" "}</text>
        <Gauge ratio={share} cells={gaugeCells()} />
        <text wrapMode="none" flexShrink={0} fg={theme().text.faint}>{fit(`${Math.round(share * 100)}%`, 5, true)}</text>
      </box>
    )
  }

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
      <box flexDirection="column" width="100%" marginBottom={1}>
        <box flexDirection="row" gap={1} width="100%">
          <text wrapMode="none" flexShrink={0} fg={theme().hue.accent[200]}>
            <b>{`${glyph.main} opendeck · usage`}</b>
          </text>
          <TabBar
            items={ranges.map((range) => ({ key: range, label: range }))}
            active={deck.usageRange()}
            w={tabW()}
            onSelect={(key) => deck.setUsageRange(key as UsageRange)}
          />
          <Show when={scopeShown()}>
            <box onMouseDown={() => deck.toggleUsageScope()}>
              <text wrapMode="none" flexShrink={0} fg={theme().text.muted}>{scopeShown()}</text>
            </box>
          </Show>
          <Show when={stats.loading}>
            <text wrapMode="none" flexShrink={0} fg={theme().text.faint}>loading…</text>
          </Show>
          <Show when={updatedShown()}>
            <text wrapMode="none" flexShrink={0} fg={theme().text.faint}>{updatedShown()}</text>
          </Show>
        </box>
        <Rule w={W()} />
      </box>
      <Show
        when={stats()?.error === undefined}
        fallback={<text wrapMode="none" flexShrink={0} fg={theme().text.muted}>{`usage: ${truncate(maskSecrets(stats()?.error ?? ""), 100)}`}</text>}
      >
        <Show when={data()} keyed fallback={<text wrapMode="none" flexShrink={0} fg={theme().text.muted}>loading usage…</text>}>
          {(d: SessionStatsInfo) => (
            <>
              <Show when={d.sessions === 0}>
                <text wrapMode="none" flexShrink={0} fg={theme().text.muted}>no usage recorded for this range</text>
              </Show>
              <box flexDirection="row" gap={2} width={W()}>
                <Section title="overview" w={colW()}>
                  <text wrapMode="none" flexShrink={0} fg={theme().text.base}>{fit(`${compact(d.sessions)} sessions · ${compact(d.subagents)} subagents`, inner())}</text>
                  <text wrapMode="none" flexShrink={0} fg={theme().text.base}>{fit(`${compact(d.prompts)} prompts · ${compact(d.steps)} steps`, inner())}</text>
                  <text wrapMode="none" flexShrink={0} fg={theme().text.muted}>{fit(`${d.activeDays} active days · streak ${d.streak}`, inner())}</text>
                  <Show when={toolTotals()}>
                    <text wrapMode="none" flexShrink={0} fg={theme().text.muted}>
                      {fit(`${compact(toolTotals()?.calls ?? 0)} tool calls · ${compact(toolTotals()?.failed ?? 0)} failed`, inner())}
                    </text>
                  </Show>
                  <text wrapMode="none" flexShrink={0} fg={theme().text.faint}>{fit(`cache hit ${Math.round(cacheHit(d.tokens) * 100)}%`, inner())}</text>
                </Section>
                <Section title="tokens" right={compact(d.tokens.input + d.tokens.output + d.tokens.reasoning + (d.tokens.cache?.read ?? 0) + (d.tokens.cache?.write ?? 0))} w={colW()}>
                  {(() => {
                    const total = Math.max(1, d.tokens.input + d.tokens.output + d.tokens.reasoning + (d.tokens.cache?.read ?? 0) + (d.tokens.cache?.write ?? 0))
                    return (
                      <>
                        {tokenRow("input", d.tokens.input, d.tokens.input / total, theme().text.base)}
                        {tokenRow("cache read", d.tokens.cache?.read ?? 0, (d.tokens.cache?.read ?? 0) / total, theme().hue.accent[200])}
                        {tokenRow("cache write", d.tokens.cache?.write ?? 0, (d.tokens.cache?.write ?? 0) / total, theme().text.muted)}
                        {tokenRow("output", d.tokens.output, d.tokens.output / total, theme().text.feedback.success.base)}
                        {tokenRow("reasoning", d.tokens.reasoning, d.tokens.reasoning / total, theme().text.muted)}
                      </>
                    )
                  })()}
                </Section>
              </box>
              <Section title="activity · steps/day" right={`max ${compact(maxDay())} · avg ${compact(avgDay())}`} w={W()}>
                <For each={grid()}>
                  {(row, dow) => (
                    <box flexDirection="row" width={W() - 2}>
                      <text wrapMode="none" flexShrink={0} fg={theme().text.faint}>{`${DAYS[dow()] ?? "   "} `}</text>
                      <For each={row.slice(-heatCols())}>
                        {(value) => (
                          <text wrapMode="none" flexShrink={0} fg={heatColor(value)}>
                            {value < 0 ? "  " : `${HEAT[value] ?? "■"} `}
                          </text>
                        )}
                      </For>
                    </box>
                  )}
                </For>
                <For each={chart()}>
                  {(line, index) => (
                    <box flexDirection="row" width={W() - 2}>
                      <text wrapMode="none" flexShrink={0} fg={theme().text.faint}>{fit(index() === 0 ? compact(maxDay()) : index() === chart().length - 1 ? "0" : "", 8, true)}</text>
                      <text wrapMode="none" flexShrink={0}>{"  "}</text>
                      <text wrapMode="none" flexShrink={0} fg={theme().hue.accent[200]}>{line}</text>
                    </box>
                  )}
                </For>
              </Section>
              <box flexDirection="row" width={W()}>
                <text wrapMode="none" flexShrink={0} fg={theme().text.base}>
                  <b>{`── models (${models().length}) `}</b>
                </text>
                <text wrapMode="none" flexShrink={0} fg={theme().text.faint}>
                  {fit(`${fit("", Math.max(0, nameW() - 15 + 2))}${fit("steps", NUM_W, true)}${fit("input", NUM_W, true)}${fit("cache r", NUM_W, true)}${fit("out", NUM_W, true)}${fit("total", NUM_W, true)}`, W() - 16)}
                </text>
              </box>
              <ScrollList
                items={models()}
                top={modelTop()}
                height={Math.min(modelH(), Math.max(1, models().length))}
                width={W() - 1}
                scrollbar
                onScroll={(next) => deck.setUsageTop(next)}
                render={(row) => renderModel(row)}
              />
              <Show when={tools().length > 0}>
                <box flexDirection="column" marginTop={1}>
                  <Section title="tools" right={toolTotals() ? `${compact(toolTotals()!.calls)} calls` : undefined} w={W()}>
                    <For each={tools()}>
                      {(tool) => {
                        const barW = Math.max(4, Math.min(40, W() - 2 - 14 - 8 - 8 - 10 - 2))
                        const filled = maxTool() > 0 ? Math.max(1, Math.round((tool.calls / maxTool()) * barW)) : 0
                        return (
                          <box flexDirection="row" width={W() - 2}>
                            <text wrapMode="none" flexShrink={0} fg={theme().text.base}>{fit(tool.name, 14)}</text>
                            <text wrapMode="none" flexShrink={0} fg={theme().text.muted}>{fit(compact(tool.calls), 8, true)}</text>
                            <text wrapMode="none" flexShrink={0} fg={tool.failed > 0 ? theme().text.feedback.error.base : theme().text.faint}>
                              {fit(`${compact(tool.failed)} fail`, 8, true)}
                            </text>
                            <text wrapMode="none" flexShrink={0} fg={theme().text.faint}>
                              {fit(tool.durationP50 !== undefined ? `p50 ${Math.round(tool.durationP50)}ms` : "", 10, true)}
                            </text>
                            <text wrapMode="none" flexShrink={0} fg={theme().hue.accent[200]}>{`  ${"█".repeat(Math.max(0, filled))}`}</text>
                            <text wrapMode="none" flexShrink={0} fg={theme().text.faint}>{"░".repeat(Math.max(0, barW - filled))}</text>
                          </box>
                        )
                      }}
                    </For>
                  </Section>
                </box>
              </Show>
            </>
          )}
        </Show>
      </Show>
      <KeyHints
        items={[
          ["1/2/3", "30d/90d/1y"],
          ["p", "all/project"],
          ["j/k", "models"],
          ["r", "reload"],
          ["esc", "back"],
        ]}
        w={W()}
      />
    </box>
  )
}
