# opencode-opendeck

Live session dashboard for the OpenCode TUI — a clone of
[claude-flightdeck](https://github.com/scasella/claude-flightdeck) for
[OpenCode](https://opencode.ai) **v2** (`2.0.0+`). Two surfaces: a smart
compact sidebar (`sidebar.content` slot) and a full-screen view (a plugin
route — the widest surface the v2 API offers; `session.panel` was the
alternative but stays narrower and session-scoped). Read-only observer: no
event mutation, no network, no file writes, no state persisted across TUI
restarts.

English | [Tiếng Việt](#tiếng-việt)

## Full view

Open it with `/opendeck` (slash command or command palette) or the `⤢ open`
link in the sidebar. `q` or `esc` returns to the session. Three tabs
(`1`/`2`/`3`): **Overview** (ctx, session stats, charts, errors, pending
permissions), **Agents** (cards or lanes via `t`, `j/k` select, `enter` open,
tokens per agent, tools), **Activity** (full-height timeline plus permission
gate history). `f` opens the diff page, `u` usage, `?` help. There is no default
keybind (`ctrl+g` belongs to the host's `session.first`); bind your own via the
`opendeck.open` command id in your keybinds config. The full view's keys live in
a dedicated keymap mode that only exists while it is the current route, so they
never fire over the prompt or a dialog on top.

- **Layout** — two columns at ≥110 terminal cols (left: context and session
  stats, pending permissions; right: agents), stacked below.
- **Agents** — a card grid between connector rails (`┬` fan-out above, `┴`
  merge below) with packets marching while anything runs; or swimlanes on one
  shared time axis, each bar the agent's lifetime with a pulsing live head.
- **Diff page** (`f`) — file tree + patch, tabs `1` edits / `2` git / `3` log
  (the git log is reachable only from here). `j/k` move, `enter`/`l` open,
  `h` close dir, `tab` tree⇄patch, `pgup/pgdn` and `ctrl+d/u` scroll, `n/p`
  hunk, `g/G` top/bottom, `s` split/unified, `r` refresh, `?` help, `q` back.

## What the sidebar shows

- **Header** — `▾ opendeck · model`; click to collapse.
- **Context** — one line: `ctx ▰▱ NN% · in X · out Y` (accent <70%, warning
  70–85%, error >85%; spinner while the session runs).
- **needs approval** — pending permission requests only; hidden when none.
- **Agents** — each active agent on two lines (spinner, name, short model,
  current tool + arg (secret-masked), elapsed clock). Inactive agents collapse
  to one header line (`▸ Done 5 ✓4 ✗1`); click to expand. Click an agent to
  jump into that child session.
- **⤺ back to Opendeck** — only while a return to the full view is pending.
- **Footer** — `⤢ open · /opendeck`.

All rows are measured against the real slot width, truncated with an ellipsis,
and never wrap.

## Animations

Terminal-feasible pieces of claude-flightdeck's motion, on ONE shared 120ms
ticker (created in `setup`, cleared on plugin cleanup) that stops entirely
when nothing is running or animating — no idle CPU, no per-component timers:

- **Spinners** — braille frames (`⠋⠙⠹…`) on each running agent and on the
  `ctx` label while the main session runs; `✓` / `✗` when done / errored.
- **Live clocks** — per-agent elapsed times tick while running.
- **Rails & swimlanes** — the full view's card grid sits between rails with
  lit packets (`•●`) marching while any agent runs; in lanes mode each running
  bar's head pulses on the shared time axis.
- **Context bar** — tweens to new readings over ~400ms (ease-out) and shifts
  colour by threshold: accent <70%, warning 70–85%, error >85%.
- **Flash & pulse** — new activity rows and permission requests flash accent
  for ~1.5s then fade back; pending permissions pulse.
- **Fan-out** — a newly spawned subagent plays a short `· → ◦ → ●` launch
  sequence (~600ms) before its spinner takes over.

## Install (local checkout)

OpenCode v2 loads TUI plugins from the `plugins` array in the **global**
`~/.config/opencode/cli.json` (`tui.json` is v1-only):

```json
{
  "plugins": ["/absolute/path/to/opencode-opendeck"]
}
```

For a local directory, v2 resolves the physical `tui.js` in the repo root,
which re-exports the build output — so build first:

```bash
bun install
bun run build   # writes dist/index.js
```

Restart OpenCode. The widget appears in the session sidebar
(`ctrl+x` then `b` if the sidebar is hidden).

## Development

```bash
bun install
bun run typecheck   # tsc --noEmit (strict)
bun run build       # rebuild after editing src/*
```

The TUI hot-reloads file plugins; if not, restart OpenCode.

Layout:

- `src/index.tsx` — plugin entry (`Plugin.define`, sidebar slot, plugin route, keymap layer)
- `src/state.ts` — reactive store: shared ticker, run tracking, permission events, full-view navigation
- `src/sidebar.tsx` — the compact sidebar (header, ctx, needs approval, agents, footer)
- `src/fullview.tsx` — the full-screen view (Overview / Agents / Activity tabs)
- `src/diffview.tsx` — the diff page (tree + patch, edits / git / log)
- `src/gitview.tsx` — the git log page
- `src/usageview.tsx` — the usage page
- `src/shared.ts` — shared live-state hooks (agent state, ctx stats, permissions, activity)
- `src/anim.ts` — frame helpers: spinner, rail packets, lane flow, launch, tween, colour mix
- `src/format.ts` — formatting + secret masking helpers
- `script/build.mjs` — Solid transform build (bakes host runtime-module ids)

## License

MIT

---

## Tiếng Việt

Dashboard trực tiếp trong OpenCode TUI — bản clone của claude-flightdeck cho
OpenCode **v2**. Hai màn hình: sidebar gọn (slot `sidebar.content`) và màn
hình đầy đủ (plugin route). Chỉ quan sát, không chặn/sửa event, không gọi
mạng, không ghi file, không lưu state giữa các phiên.

**Mở full view:** gõ `/opendeck` (hoặc command palette), hoặc click `⤢ open`
trong sidebar (không gán phím tắt mặc định — tự gán qua command id
`opendeck.open`). `q`/`esc` quay lại session. Ba tab: `1` Overview (ctx, thống
kê phiên, biểu đồ, lỗi, quyền đang chờ), `2` Agents (cards hoặc lanes qua `t`,
`j/k` chọn, `enter` mở, token từng agent, tool), `3` Activity (timeline đầy đủ
+ lịch sử permission gate). `f` mở trang diff (tab `1` edits / `2` git / `3`
log — git log chỉ vào được từ đây), `u` usage, `?` help.

**Sidebar hiển thị:**

- **Header** — `▾ opendeck · model`, click để thu gọn.
- **Context** — một dòng `ctx ▰▱ NN% · in X · out Y` (accent <70%, warning
  70–85%, error >85%; spinner khi session đang chạy).
- **needs approval** — chỉ request đang chờ; không có thì ẩn.
- **Agents** — agent đang hoạt động 2 dòng mỗi agent (spinner, tên, model,
  tool hiện tại, đồng hồ); agent xong thu gọn một dòng `▸ Done 5 ✓4 ✗1`, click
  để mở rộng.
- **⤺ back to Opendeck** — chỉ hiện khi cần quay lại full view.
- **Footer** — `⤢ open · /opendeck`.

**Cài đặt (bản local):** thêm đường dẫn tuyệt đối của thư mục này vào mảng
`plugins` trong `~/.config/opencode/cli.json` (xem ví dụ JSON ở trên), rồi
chạy `bun install && bun run build` và khởi động lại OpenCode.
