// Plugin options, parsed from cli.json `plugins[].options` (README "Options").
// Total by design: any missing or invalid field falls back to its default, so a
// bad config can never crash the plugin. No imports, no I/O (test/config.test.ts).

/** Everything the user can tune without patching the plugin. */
export type DeckConfig = {
  /** Animate spinners, pulses, flashes, the context tween and launch frames. */
  animations: boolean
  /** Inactive agents listed under "Done" in the sidebar (1..100). */
  doneLimit: number
  /** Commits fetched for the git log page (50..2000). */
  gitLogLimit: number
  /** Allow stage/unstage/discard/commit from the diff page's git tab (off by default). */
  gitWrite: boolean
  /** Agents-tab panels that can be hidden. */
  panels: { stats: boolean; charts: boolean; errors: boolean; files: boolean }
}

export const DEFAULT_CONFIG: DeckConfig = {
  animations: true,
  doneLimit: 12,
  gitLogLimit: 300,
  gitWrite: false,
  panels: { stats: true, charts: true, errors: true, files: true },
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const bool = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback)

const int = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fallback

/** Turn raw plugin options into a complete config; never throws. */
export function parseConfig(raw: unknown): DeckConfig {
  if (!isObject(raw)) {
    return { ...DEFAULT_CONFIG, panels: { ...DEFAULT_CONFIG.panels } }
  }
  const panels = isObject(raw.panels) ? raw.panels : {}
  return {
    animations: bool(raw.animations, DEFAULT_CONFIG.animations),
    doneLimit: int(raw.doneLimit, 1, 100, DEFAULT_CONFIG.doneLimit),
    gitLogLimit: int(raw.gitLogLimit, 50, 2000, DEFAULT_CONFIG.gitLogLimit),
    gitWrite: bool(raw.gitWrite, DEFAULT_CONFIG.gitWrite),
    panels: {
      stats: bool(panels.stats, DEFAULT_CONFIG.panels.stats),
      charts: bool(panels.charts, DEFAULT_CONFIG.panels.charts),
      errors: bool(panels.errors, DEFAULT_CONFIG.panels.errors),
      files: bool(panels.files, DEFAULT_CONFIG.panels.files),
    },
  }
}
