# Contributing

Thanks for helping! opendeck is small on purpose, so a few rules keep it that way.

## Setup

```bash
git clone https://github.com/ptthien1012/opencode-opendeck.git
cd opencode-opendeck
bun install
bun run check      # typecheck + tests + bundle
```

Point OpenCode at your checkout by adding its absolute path to `plugins` in
`~/.config/opencode/cli.json`, then restart OpenCode.

## Before you open a PR

- Run `bun run bundle` and commit `dist/` — users install the committed build, and CI fails if it is stale.
- Keep it read-only: no network calls, no session mutation. Git writes stay behind the `gitWrite` option.
- Keep it light: no new timers (use the shared ticker in `src/state.ts`), no per-frame git or fs calls.
- Pure logic goes in `src/*.ts` with a test in `test/`; views stay in `src/*.tsx`.
- Every row must fit its width and never wrap; check a narrow terminal (~80 cols).

Small, focused PRs get merged fastest. For bigger ideas, open an issue first.
