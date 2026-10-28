# opencode-flightdeck

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

Open it with `/flightdeck` (slash command or command palette) or the
`⤢ open Flightdeck` link in the sidebar. `q` or `esc` returns to the session;
`t` (or clicking the header) toggles the agents area between the card grid and
swimlanes. There is no default keybind (`ctrl+g` belongs to the host's
`session.first`); bind your own via the `flightdeck.open` command id in your
keybinds config. The `esc`/`q`/`t` keys live in a dedicated keymap mode that
only exists while the full view is the current route, so they never fire over
the prompt or a dialog on top.

- **Layout** — two columns at ≥110 terminal cols (left: main context/cost
  panel, permission gate, activity timeline; right: agents), stacked below.
- **Agents** — a card grid between connector rails (`┬` fan-out above, `┴`
  merge below) with packets marching while anything runs; or swimlanes on one
  shared time axis, each bar the agent's lifetime with a pulsing live head.
- **Permission gate** — one cell per check (allowed `■`, pending `■` pulsing,
  denied `✗`; dimmed when made inside a subagent) plus totals and pending rows.

## What the sidebar shows

- **Context & cost** — context tokens vs the model's context limit (bar + %),
  total session cost including subagents, current model.
- **Active** — only agents running, waiting on a permission reply, or finished
  within the last ~30s (pending first, then running by start time). Per agent:
  spinner, name, short model, current tool + arg (secret-masked), elapsed
  clock, ctx %, cost. Click a card to jump into that child session.
- **Done** — inactive agents collapsed to one header line (`▸ Done 5  ✓4 ✗1`,
  failed count always visible); click to expand one-line rows.
- **Activity** — tool calls from the main session + active agents only;
  consecutive identical rows collapse to `×n`; max 6 rows.
- **Permissions** — pending requests pulse, plus a short verdict history.
- Sections with nothing to say are hidden; when nothing is happening at all
  the widget is just the context line and a dim `· idle` hint.

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
  "plugins": ["/absolute/path/to/opencode-flightdeck"]
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
- `src/sidebar.tsx` — the compact sidebar (Active / Done / Activity / Permissions)
- `src/fullview.tsx` — the full-screen view (panels, card grid + rails, swimlanes)
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

**Mở full view:** gõ `/flightdeck` (hoặc command palette), hoặc click
`⤢ open Flightdeck` trong sidebar (không gán phím tắt mặc định — tự gán qua
command id `flightdeck.open`). `q`/`esc` để quay lại session, `t`
để đổi agents giữa lưới thẻ (cards) và swimlanes.

**Sidebar hiển thị:**

- **Context & cost** — token context so với giới hạn của model (thanh + %),
  tổng chi phí phiên gồm cả các subagent, model hiện tại.
- **Active** — chỉ agent đang chạy / chờ quyền / vừa xong trong ~30s: spinner,
  tên, model, tool hiện tại, đồng hồ, ctx %, cost. Agent khác nằm trong mục
  **Done** thu gọn một dòng (`▸ Done 5  ✓4 ✗1`), click để mở rộng.
- **Activity** — tool call của session chính + agent đang chạy; dòng trùng
  liên tiếp gom thành `×n`; tối đa 6 dòng.
- **Permissions** — request đang chờ nhấp nháy, kèm lịch sử cho phép (`✓`) /
  từ chối (`✗`). Mục nào trống thì ẩn hẳn; không có gì chạy thì chỉ còn dòng
  context và gợi ý `· idle` mờ.

**Cài đặt (bản local):** thêm đường dẫn tuyệt đối của thư mục này vào mảng
`plugins` trong `~/.config/opencode/cli.json` (xem ví dụ JSON ở trên), rồi
chạy `bun install && bun run build` và khởi động lại OpenCode.
