// Shared numeric helpers for Opendeck. No imports, no Solid, no host access:
// pure functions, unit-tested in test/num.test.ts.

/** Clamp to the closed range 0..1. */
export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

/** One decimal place with a trailing ".0" dropped: 1 → "1", 1.25 → "1.3". */
export function fixed1(value: number): string {
  return value.toFixed(1).replace(/\.0$/, "")
}
