import type { SessionMessageAssistantTool } from "@opencode/client"

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

/** $1.23 for normal values, $0.0042 for tiny ones so cost is never invisible. */
export function formatMoney(value: number): string {
  if (value > 0 && value < 0.01) return `$${value.toFixed(4)}`
  return usd.format(value)
}

/** 123 -> "123", 45_000 -> "45k", 1_200_000 -> "1m". */
export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`
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

/** Compact ASCII/unicode context bar, e.g. "██████░░░░". */
export function formatBar(ratio: number, width = 10): string {
  const clamped = Math.max(0, Math.min(1, ratio))
  const filled = Math.round(clamped * width)
  return "█".repeat(filled) + "░".repeat(width - filled)
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
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

/** One-line "tool arg" summary of a tool call, secret-masked and truncated. */
export function toolSummary(part: SessionMessageAssistantTool, max = 30): string {
  const input: Record<string, unknown> = part.state.status === "streaming" ? {} : (part.state.input ?? {})
  let detail = ""
  for (const key of DETAIL_KEYS) {
    const value = input[key]
    if (typeof value === "string" && value.length > 0) {
      detail = value
      break
    }
  }
  const text = detail ? `${part.name} ${maskSecrets(detail)}` : part.name
  return truncate(text.replace(/\s+/g, " ").trim(), max)
}
