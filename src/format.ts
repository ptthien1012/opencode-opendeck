import type { SessionMessageAssistantTool } from "@opencode/client"
import { executeTarget } from "./metrics.js"
import { fixed1 } from "./num.js"

/** 123 -> "123", 45_000 -> "45k", 1_200_000 -> "1m". */
export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${fixed1(value / 1_000_000)}m`
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`
  return `${value}`
}

/** mm:ss under one hour, then 1h05m. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

/** Fit `text` into exactly `width` cells: truncate, then pad (left or right). */
export function fit(text: string, width: number, alignRight = false): string {
  const w = Math.max(0, Math.floor(width))
  const cut = truncate(text, w)
  const pad = " ".repeat(Math.max(0, w - cut.length))
  return alignRight ? pad + cut : cut + pad
}

/**
 * Fit one-line key hints into `w` columns without losing the actionable tail.
 * The rendered width of a hint list is `Σ(key + " " + label) + 3·(n − 1)` for
 * the " · " separators; a dropped prefix costs one extra " · …" (+4).
 *
 * All hints fit → returned whole with `dropped: false`. Otherwise the last
 * `keep` hints (the `q back`-style tail) are always kept and hints are added
 * from the front, in order, while the list plus the ellipsis still fits. If
 * even the kept tail does not fit, only the tail is returned (`dropped: true`)
 * and the caller clips the overflow.
 */
export function fitHints(
  items: readonly [string, string][],
  w: number,
  keep = 2,
): { items: [string, string][]; dropped: boolean } {
  const width = (list: readonly [string, string][]) =>
    list.reduce((sum, [key, label]) => sum + key.length + 1 + label.length, 0) + 3 * Math.max(0, list.length - 1)
  if (width(items) <= w) return { items: [...items], dropped: false }
  const tail = items.slice(Math.max(0, items.length - Math.max(0, keep)))
  if (tail.length === 0) return { items: [], dropped: false }
  const front: [string, string][] = []
  if (width(tail) + 4 > w) return { items: tail, dropped: true }
  for (const item of items.slice(0, items.length - tail.length)) {
    if (width([...front, item, ...tail]) + 4 > w) break
    front.push(item)
  }
  return { items: [...front, ...tail], dropped: true }
}

/** Short display name for a model id: drops provider prefix and vendor noise. */
export function shortModel(id: string | undefined, max = 14): string {
  if (!id) return "?"
  const tail = id.split("/").pop() ?? id
  return truncate(tail.replace(/^claude-/, ""), max)
}

/** HH:MM:SS wall clock for a ms timestamp ("--:--:--" when unknown). */
export function formatClock(ms: number): string {
  if (ms <= 0) return "--:--:--"
  return new Date(ms).toTimeString().slice(0, 8)
}

const SECRET_PATTERNS: RegExp[] = [
  // well-known token prefixes (github, gitlab, slack, anthropic/openai style, aws)
  /\b(?:sk|pk|ghp|gho|ghu|ghs|ghr|glpat|xox[baprs]|hf|AKIA)[-_][A-Za-z0-9_-]{6,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{10,}/g,
  // JWTs
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
  // bearer headers
  /(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
  // key=value style secrets
  /\b(api[-_]?key|access[-_]?token|auth[-_]?token|secret|password|passwd|authorization)(["']?\s*[:=]\s*["']?)[^\s"']{4,}/gi,
  // long hex strings (sha256, api keys, session ids)
  /\b[0-9a-f]{32,}\b/gi,
  // long base64 blobs
  /\b[A-Za-z0-9+/]{48,}={0,2}\b/g,
]

/** Mask anything that looks like a credential before it reaches the screen. */
export function maskSecrets(text: string): string {
  let out = text
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match: string, ...args: unknown[]) => {
      // replace callback args: (...captures, offset, fullString) — captures are args minus the last two
      const captures = args.slice(0, -2).filter((a): a is string => typeof a === "string")
      // keep captured prefixes readable ("api_key=", "Bearer "), mask only the secret value
      const prefix = captures.join("")
      if (prefix && match.startsWith(prefix)) return `${prefix}***`
      return "***"
    })
  }
  return out
}

const DETAIL_KEYS = ["command", "description", "filePath", "path", "pattern", "query", "url"] as const

/** Shorten an absolute path for display: drop a `cwd` prefix to "./", the home
 *  directory to "~", /private/var/folders/… (and /var/folders/…) to "$TMP".
 *  When still longer than `max` (default 60), keep the first segment, "…/" and
 *  the last two segments; if that still overflows, "…/" + the last segment
 *  truncated. Non-absolute or short paths come back unchanged. Never longer
 *  than max. */
export function shortPath(path: string, opts: { cwd?: string; home?: string; max?: number } = {}): string {
  if (!path.startsWith("/")) return path
  // strip exactly one trailing "/"
  let result = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path
  const { cwd, home } = opts
  if (cwd && result.startsWith(`${cwd}/`)) result = `./${result.slice(cwd.length + 1)}`
  else if (home && (result === home || result.startsWith(`${home}/`))) result = `~${result.slice(home.length)}`
  result = result.replace(/^\/(?:private\/)?var\/folders\/[^/]+\/[^/]+\/T\//, "$TMP/")
  const max = opts.max ?? 60
  if (result.length <= max) return result
  const segments = result.split("/")
  const elided = `${segments[0]}/…/${segments.slice(-2).join("/")}`
  if (elided.length <= max) return elided
  const last = segments[segments.length - 1] ?? ""
  const tail = `…/${truncate(last, Math.max(1, max - 2))}`
  return tail.length <= max ? tail : tail.slice(0, max)
}

const CMD_ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/
const CMD_PREFIX_WORDS = new Set(["set", "exec", "time", "nohup", "sudo"])
const CMD_SPLIT = /\s*(?:&&|\|\||\||;)\s*/

/** Command head of a shell invocation: first real token after leading env
 *  assignments, `set …`, `exec`, `time` and `cd x &&` chains; basename only,
 *  max 12 chars; "" for empty input. */
export function cmdVerb(command: string): string {
  const segments = command.trim().split(CMD_SPLIT).filter((segment) => segment.length > 0)
  for (let s = 0; s < segments.length; s++) {
    const tokens = segments[s]!.split(/\s+/).filter((token) => token.length > 0)
    let i = 0
    while (i < tokens.length) {
      const token = tokens[i]!
      if (CMD_ENV_ASSIGN.test(token)) {
        i++
        continue
      }
      if (CMD_PREFIX_WORDS.has(token)) {
        i++
        // `set -e` / `set -x` style flag directly after `set`
        if (token === "set" && /^-[A-Za-z]/.test(tokens[i] ?? "")) i++
        continue
      }
      break
    }
    const first = tokens[i]
    if (first === undefined) continue
    // `cd x &&` chain: the real command starts in the next segment
    if (first === "cd" && s + 1 < segments.length) continue
    const base = first.includes("/") ? (first.split("/").pop() ?? first) : first
    return base.length > 12 ? base.slice(0, 12) : base
  }
  return ""
}

/** One-line "tool arg" summary of a tool call, secret-masked and truncated. */
/** Command heads worth showing verbatim in the activity row. */
const SHELL_VERBS = new Set([
  "git", "bun", "bunx", "npm", "pnpm", "yarn", "flutter", "dart", "rg", "grep", "find", "ls",
  "cat", "tail", "head", "sed", "awk", "jq", "xargs", "python", "python3", "node", "deno",
  "opencode", "gh", "make", "cmake", "swift", "pod", "xcodebuild", "docker", "kubectl",
  "curl", "rm", "cp", "mv", "mkdir", "touch", "chmod", "cd", "echo", "printf", "zip", "unzip",
  "tar", "sh", "zsh", "bash", "open", "defaults", "plutil", "simctl", "fastlane",
])

export function toolSummary(
  part: SessionMessageAssistantTool,
  max = 30,
  opts: { cwd?: string; home?: string; pathMax?: number } = {},
): string {
  const pathMax = opts.pathMax ?? 40
  const input: Record<string, unknown> = part.state.status === "streaming" ? {} : (part.state.input ?? {})
  let detail = ""
  for (const key of DETAIL_KEYS) {
    const value = input[key]
    if (typeof value === "string" && value.length > 0) {
      detail = value
      break
    }
  }
  // code-mode MCP calls: show the server.tool they hit instead of the JS body
  const target = executeTarget(part)
  if (target) detail = target
  // shell: lead with a KNOWN command head (git/bun/flutter…) and shorten the
  // first absolute path so the informative part survives truncation; anything
  // else (a description, an odd script) keeps its own words.
  if (part.name === "shell") {
    const verb = cmdVerb(detail)
    const path = detail.split(/\s+/).find((token) => token.startsWith("/"))
    if (SHELL_VERBS.has(verb)) {
      const tail = path ? ` ${shortPath(path, { cwd: opts.cwd, home: opts.home, max: pathMax })}` : ""
      detail = `${verb}${tail}`
    } else if (path) {
      // script-ish command: show the path it works on instead of the preamble
      detail = shortPath(path, { cwd: opts.cwd, home: opts.home, max: pathMax })
    }
  } else if (detail.startsWith("/")) {
    detail = shortPath(detail, { cwd: opts.cwd, home: opts.home, max: pathMax })
  } else {
    // a path somewhere inside the args (grep/path tools): shorten the first one
    const token = detail.split(/\s+/).find((word) => word.startsWith("/"))
    if (token) detail = detail.replace(token, shortPath(token, { cwd: opts.cwd, home: opts.home, max: pathMax }))
  }
  const text = detail ? `${part.name} ${maskSecrets(detail)}` : part.name
  return truncate(text.replace(/\s+/g, " ").trim(), max)
}
