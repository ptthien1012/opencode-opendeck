/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { ErrorBoundary } from "solid-js"
import { maskSecrets, truncate } from "./format.js"
import { DiffView } from "./diffview.js"
import { GitView } from "./gitview.js"
import { FullView } from "./fullview.js"
import { Sidebar } from "./sidebar.js"
import { createDeck } from "./state.js"

/** One-line dim error for a crashed root — never let the host slot throw. */
function CrashLine(props: { err: unknown }) {
  const context = usePlugin()
  const message = () => {
    const err = props.err as { message?: unknown }
    return truncate(maskSecrets(String(err?.message ?? props.err)), 60)
  }
  return (
    <text wrapMode="none" fg={context.theme.text.feedback.error.base}>
      opendeck: {message()}
    </text>
  )
}

export default Plugin.define({
  id: "opendeck",
  setup(context) {
    const { deck, dispose } = createDeck(context)

    // Open: /opendeck slash command + command palette entry, reachable from
    // anywhere (mode "global"). No default keybind: the host already binds
    // ctrl+g (session.first) and a lower-priority bind never dispatches, so
    // auto-binding is disabled — bind your own via the "opendeck.open"
    // command id in keybinds config.
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "opendeck.open",
          title: "Open Opendeck",
          description: "Open the Opendeck dashboard full screen",
          group: "Opendeck",
          palette: true,
          slash: { name: "opendeck" },
          bind: false,
          enabled: () => !deck.isFullRoute(),
          run: () => deck.openFullview(),
        },
      ],
    }))

    // Close/toggle keys: scoped to the "opendeck" keymap mode, which the
    // deck pushes only while the full view is the current route and pops on
    // close — so they can't fire over the prompt or a dialog on top.
    context.keymap.layer(() => ({
      mode: "opendeck",
      commands: [
        {
          id: "opendeck.close",
          title: "Close Opendeck",
          description: "Return from the Opendeck full view to the session",
          group: "Opendeck",
          bind: "escape",
          enabled: () => deck.isFullRoute(),
          run: () => deck.closeFullview(),
        },
        {
          id: "opendeck.toggle",
          title: "Opendeck: toggle cards/lanes",
          description: "Switch the agents area between card grid and swimlanes",
          group: "Opendeck",
          bind: "t",
          enabled: () => deck.isFullRoute(),
          run: () => deck.setLanes(!(deck.lanesPref() ?? false)),
        },
        {
          id: "opendeck.diff",
          title: "Opendeck: files changed",
          description: "Open the diff of files changed in this session",
          group: "Opendeck",
          bind: "f",
          enabled: () => deck.isFullRoute(),
          run: () => deck.openDiff(),
        },
        {
          id: "opendeck.git",
          title: "Opendeck: git log",
          description: "Open the git commit graph of the session's directory",
          group: "Opendeck",
          bind: "l",
          enabled: () => deck.isFullRoute(),
          run: () => deck.openGit(),
        },
        {
          bind: "q",
          enabled: () => deck.isFullRoute(),
          run: () => deck.closeFullview(),
        },
      ],
    }))

    // Diff page keys: scoped to the "opendeck-diff" keymap mode, which the
    // deck pushes only while the diff route is the current route. One command
    // per key — `bind` takes a single key string. Movement/open/page keys are
    // focus-aware: deck.diffKey routes them to the tree cursor or the patch
    // scroll depending on deck.diffFocus (tab swaps the two).
    context.keymap.layer(() => ({
      mode: "opendeck-diff",
      commands: [
        {
          id: "opendeck.diff.close",
          title: "Opendeck: back from diff",
          description: "Return from the diff view to the Opendeck full view",
          group: "Opendeck",
          bind: "escape",
          enabled: () => deck.diffOpen(),
          run: () => deck.closeDiff(),
        },
        {
          bind: "q",
          enabled: () => deck.diffOpen(),
          run: () => deck.closeDiff(),
        },
        {
          id: "opendeck.diff.focus",
          title: "Opendeck: switch diff pane focus",
          description: "Swap keyboard focus between the file tree and the patch",
          group: "Opendeck",
          bind: "tab",
          enabled: () => deck.diffOpen(),
          run: () => deck.diffToggleFocus(),
        },
        {
          bind: "j",
          enabled: () => deck.diffOpen(),
          run: () => deck.diffKey("down"),
        },
        {
          bind: "down",
          enabled: () => deck.diffOpen(),
          run: () => deck.diffKey("down"),
        },
        {
          bind: "k",
          enabled: () => deck.diffOpen(),
          run: () => deck.diffKey("up"),
        },
        {
          bind: "up",
          enabled: () => deck.diffOpen(),
          run: () => deck.diffKey("up"),
        },
        // Tree: open dir/file (file also moves focus to the patch).
        {
          bind: "enter",
          enabled: () => deck.diffOpen(),
          run: () => deck.diffKey("open"),
        },
        {
          bind: "l",
          enabled: () => deck.diffOpen(),
          run: () => deck.diffKey("open"),
        },
        {
          bind: "right",
          enabled: () => deck.diffOpen(),
          run: () => deck.diffKey("open"),
        },
        {
          bind: "h",
          enabled: () => deck.diffOpen(),
          run: () => deck.diffKey("close-parent"),
        },
        {
          bind: "left",
          enabled: () => deck.diffOpen(),
          run: () => deck.diffKey("close-parent"),
        },
        // Tree: open under cursor; patch: page down.
        {
          bind: "space",
          enabled: () => deck.diffOpen(),
          run: () => deck.diffKey("space"),
        },
        // Page scrolling uses the view-published visible row count.
        {
          bind: "pagedown",
          enabled: () => deck.diffOpen(),
          run: () => deck.diffKey("page-down"),
        },
        {
          bind: "b",
          enabled: () => deck.diffOpen(),
          run: () => deck.diffKey("page-up"),
        },
        {
          bind: "pageup",
          enabled: () => deck.diffOpen(),
          run: () => deck.diffKey("page-up"),
        },
        {
          bind: "ctrl+d",
          enabled: () => deck.diffOpen(),
          run: () => deck.diffKey("half-down"),
        },
        {
          bind: "ctrl+u",
          enabled: () => deck.diffOpen(),
          run: () => deck.diffKey("half-up"),
        },
        // Hunk/top/bottom jumps: the view owns row indexes, so these send a
        // jump request the view consumes.
        {
          bind: "n",
          enabled: () => deck.diffOpen(),
          run: () => deck.diffKey("next-hunk"),
        },
        {
          bind: "p",
          enabled: () => deck.diffOpen(),
          run: () => deck.diffKey("prev-hunk"),
        },
        {
          bind: "g",
          enabled: () => deck.diffOpen(),
          run: () => deck.diffKey("top"),
        },
        {
          bind: "shift+g",
          enabled: () => deck.diffOpen(),
          run: () => deck.diffKey("bottom"),
        },
        {
          id: "opendeck.diff.toggle-view",
          title: "Opendeck: toggle split/unified diff",
          description: "Switch the diff page between side-by-side and unified view",
          group: "Opendeck",
          bind: "s",
          enabled: () => deck.diffOpen(),
          run: () => deck.diffToggleView(),
        },
        {
          id: "opendeck.diff.source-edits",
          title: "Opendeck: diff session edits",
          description: "Show files changed by the session's edit/write tool calls",
          group: "Opendeck",
          bind: "1",
          enabled: () => deck.diffOpen(),
          run: () => deck.setDiffSource("edits"),
        },
        {
          id: "opendeck.diff.source-git",
          title: "Opendeck: diff git working tree",
          description: "Show the git working tree diff for the session's directory",
          group: "Opendeck",
          bind: "2",
          enabled: () => deck.diffOpen(),
          run: () => deck.setDiffSource("git"),
        },
        {
          id: "opendeck.diff.refresh-git",
          title: "Opendeck: refresh git diff",
          description: "Refetch the git working tree diff",
          group: "Opendeck",
          bind: "r",
          enabled: () => deck.diffOpen(),
          run: () => deck.diffRefreshGit(),
        },
        {
          bind: "3",
          enabled: () => deck.diffOpen(),
          run: () => deck.openGit(),
        },
      ],
    }))

    // Git log page keys: scoped to the "opendeck-git" keymap mode, pushed
    // only while the git route is current. One key per command object.
    const gitOn = () => deck.gitOpen()
    const page = () => deck.gitPage()
    context.keymap.layer(() => ({
      mode: "opendeck-git",
      commands: [
        {
          id: "opendeck.git.close",
          title: "Opendeck: back from git log",
          description: "Return from the git log to the Opendeck full view",
          group: "Opendeck",
          bind: "escape",
          enabled: gitOn,
          run: () => deck.closeGit(),
        },
        { bind: "q", enabled: gitOn, run: () => deck.closeGit() },
        { bind: "j", enabled: gitOn, run: () => deck.gitMove(1) },
        { bind: "down", enabled: gitOn, run: () => deck.gitMove(1) },
        { bind: "k", enabled: gitOn, run: () => deck.gitMove(-1) },
        { bind: "up", enabled: gitOn, run: () => deck.gitMove(-1) },
        { bind: "space", enabled: gitOn, run: () => deck.gitMove(page()) },
        { bind: "pagedown", enabled: gitOn, run: () => deck.gitMove(page()) },
        { bind: "b", enabled: gitOn, run: () => deck.gitMove(-page()) },
        { bind: "pageup", enabled: gitOn, run: () => deck.gitMove(-page()) },
        { bind: "g", enabled: gitOn, run: () => deck.gitSelect(0) },
        { bind: "shift+g", enabled: gitOn, run: () => deck.gitSelect(1_000_000) },
        { bind: "enter", enabled: gitOn, run: () => deck.gitOpenSelected() },
        { bind: "r", enabled: gitOn, run: () => deck.gitReload() },
      ],
    }))

    // Full-screen view: a plugin route (the widest surface the v2 API offers).
    const unregister = context.ui.router.register({
      name: "opendeck",
      render: ({ data }) => (
        <ErrorBoundary fallback={(err: unknown) => <CrashLine err={err} />}>
          <FullView deck={deck} sessionID={typeof data?.sessionID === "string" ? data.sessionID : undefined} />
        </ErrorBoundary>
      ),
    })

    // Diff page: second plugin route, same crash guard as the full view.
    const unregisterDiff = context.ui.router.register({
      name: "opendeck-diff",
      render: ({ data }) => (
        <ErrorBoundary fallback={(err: unknown) => <CrashLine err={err} />}>
          <DiffView
            deck={deck}
            sessionID={typeof data?.sessionID === "string" ? data.sessionID : undefined}
            file={typeof data?.file === "string" ? data.file : undefined}
          />
        </ErrorBoundary>
      ),
    })

    // Git log page: third plugin route, same crash guard.
    const unregisterGit = context.ui.router.register({
      name: "opendeck-git",
      render: ({ data }) => (
        <ErrorBoundary fallback={(err: unknown) => <CrashLine err={err} />}>
          <GitView deck={deck} sessionID={typeof data?.sessionID === "string" ? data.sessionID : undefined} />
        </ErrorBoundary>
      ),
    })

    const remove = context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => (
        <ErrorBoundary fallback={(err: unknown) => <CrashLine err={err} />}>
          <Sidebar deck={deck} sessionID={sessionID} />
        </ErrorBoundary>
      ),
    })

    return () => {
      unregister()
      unregisterDiff()
      unregisterGit()
      remove()
      dispose()
    }
  },
})
