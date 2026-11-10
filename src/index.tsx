/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { ErrorBoundary } from "solid-js"
import { maskSecrets, truncate } from "./format.js"
import { DiffView } from "./diffview.js"
import { GitView } from "./gitview.js"
import { HelpView } from "./help.js"
import { UsageView } from "./usageview.js"
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
        {
          // Palette-only: a single-letter global bind would steal chat typing.
          id: "opendeck.toggleSidebar",
          title: "Opendeck: collapse/expand sidebar",
          description: "Collapse or expand the Opendeck sidebar panel",
          group: "Opendeck",
          palette: true,
          bind: false,
          run: () => deck.toggleCollapsed(),
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
          id: "opendeck.usage",
          title: "Opendeck: usage",
          description: "Token, cache, model and tool usage over 30d / 90d / 1y",
          group: "Opendeck",
          bind: "u",
          enabled: () => deck.isFullRoute(),
          run: () => deck.openUsage(),
        },
        // ? opens the help page. Terminals report the key differently — the
        // literal "?", or shift-modified "/" or "?" — so bind all three (the
        // same trio the host uses for its own diff.help shortcut).
        {
          id: "opendeck.help",
          title: "Opendeck: help",
          description: "Every Opendeck shortcut plus the symbol legend",
          group: "Opendeck",
          bind: "?",
          enabled: () => deck.isFullRoute(),
          run: () => deck.openHelp("full"),
        },
        { bind: "shift+?", enabled: () => deck.isFullRoute(), run: () => deck.openHelp("full") },
        { bind: "shift+/", enabled: () => deck.isFullRoute(), run: () => deck.openHelp("full") },
        {
          id: "opendeck.tab.agents",
          title: "Opendeck: tab Agents",
          description: "Context, agent tree, tokens, tools, stats, charts and errors",
          group: "Opendeck",
          bind: "1",
          enabled: () => deck.isFullRoute(),
          run: () => deck.setFullTab("agents"),
        },
        {
          id: "opendeck.tab.activity",
          title: "Opendeck: tab Activity",
          description: "Full-height tool-call timeline and permissions",
          group: "Opendeck",
          bind: "2",
          enabled: () => deck.isFullRoute(),
          run: () => deck.setFullTab("activity"),
        },
        // Agents tab: j/k move the keyboard selection, enter opens it. The
        // commands stay inert on the other tabs (each tab has its own page
        // keys), so plain j/k/enter keep their host meaning elsewhere.
        {
          id: "opendeck.agent.next",
          title: "Opendeck: select next agent",
          description: "Move the Agents tab selection down one row",
          group: "Opendeck",
          bind: "j",
          enabled: () => deck.isFullRoute() && deck.fullTab() === "agents",
          run: () => deck.moveAgentSel(1),
        },
        {
          id: "opendeck.agent.prev",
          title: "Opendeck: select previous agent",
          description: "Move the Agents tab selection up one row",
          group: "Opendeck",
          bind: "k",
          enabled: () => deck.isFullRoute() && deck.fullTab() === "agents",
          run: () => deck.moveAgentSel(-1),
        },
        {
          id: "opendeck.agent.open",
          title: "Opendeck: open selected agent",
          description: "Dive into the agent selected on the Agents tab",
          group: "Opendeck",
          bind: "enter",
          enabled: () => deck.isFullRoute() && deck.fullTab() === "agents",
          run: () => deck.openAgentSel(),
        },
        // Full view scrolling (j/k stay agent selection): wheel works natively.
        { bind: "pagedown", enabled: () => deck.isFullRoute(), run: () => deck.fullScroll("page", 1) },
        { bind: "pageup", enabled: () => deck.isFullRoute(), run: () => deck.fullScroll("page", -1) },
        { bind: "ctrl+d", enabled: () => deck.isFullRoute(), run: () => deck.fullScroll("half", 1) },
        { bind: "ctrl+u", enabled: () => deck.isFullRoute(), run: () => deck.fullScroll("half", -1) },
        { bind: "g", enabled: () => deck.isFullRoute(), run: () => deck.fullScroll("top") },
        { bind: "shift+g", enabled: () => deck.isFullRoute(), run: () => deck.fullScroll("bottom") },
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
          bind: "h",
          enabled: () => deck.diffOpen(),
          run: () => deck.diffKey("close-parent"),
        },
        // Page scrolling uses the view-published visible row count.
        {
          bind: "pagedown",
          enabled: () => deck.diffOpen(),
          run: () => deck.diffKey("page-down"),
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
          id: "opendeck.diff.git-toggle",
          title: "Opendeck: git stage/unstage file",
          description: "Stage or unstage the selected file (needs gitWrite)",
          group: "Opendeck",
          bind: "space",
          enabled: () => deck.diffOpen() && deck.diffSource() === "git" && deck.gitWriteEnabled(),
          run: () => void deck.gitAction("toggle"),
        },
        {
          id: "opendeck.diff.git-stage-all",
          title: "Opendeck: git stage all",
          description: "git add -A after a confirm (needs gitWrite)",
          group: "Opendeck",
          bind: "a",
          enabled: () => deck.diffOpen() && deck.diffSource() === "git" && deck.gitWriteEnabled(),
          run: () => void deck.gitAction("stage-all"),
        },
        {
          id: "opendeck.diff.git-discard",
          title: "Opendeck: git discard file",
          description: "Discard the selected file's changes after a confirm (needs gitWrite)",
          group: "Opendeck",
          bind: "x",
          enabled: () => deck.diffOpen() && deck.diffSource() === "git" && deck.gitWriteEnabled(),
          run: () => void deck.gitAction("discard"),
        },
        {
          id: "opendeck.diff.git-commit",
          title: "Opendeck: git commit",
          description: "Commit staged changes with a prompted message (needs gitWrite)",
          group: "Opendeck",
          bind: "c",
          enabled: () => deck.diffOpen() && deck.diffSource() === "git" && deck.gitWriteEnabled(),
          run: () => void deck.gitAction("commit"),
        },
        {
          bind: "3",
          enabled: () => deck.diffOpen(),
          run: () => deck.openGit(),
        },
        // ? opens the help page (close returns to the diff page).
        {
          id: "opendeck.diff.help",
          title: "Opendeck: diff help",
          description: "Every Opendeck shortcut plus the symbol legend",
          group: "Opendeck",
          bind: "?",
          enabled: () => deck.diffOpen(),
          run: () => deck.openHelp("diff"),
        },
        { bind: "shift+?", enabled: () => deck.diffOpen(), run: () => deck.openHelp("diff") },
        { bind: "shift+/", enabled: () => deck.diffOpen(), run: () => deck.openHelp("diff") },
      ],
    }))

    // Usage page keys: scoped to the "opendeck-usage" keymap mode.
    const usageOn = () => deck.usageOpen()
    context.keymap.layer(() => ({
      mode: "opendeck-usage",
      commands: [
        {
          id: "opendeck.usage.close",
          title: "Opendeck: back from usage",
          description: "Return from the usage page to the Opendeck full view",
          group: "Opendeck",
          bind: "escape",
          enabled: usageOn,
          run: () => deck.closeUsage(),
        },
        { bind: "q", enabled: usageOn, run: () => deck.closeUsage() },
        { bind: "1", enabled: usageOn, run: () => deck.setUsageRange("30d") },
        { bind: "2", enabled: usageOn, run: () => deck.setUsageRange("90d") },
        { bind: "3", enabled: usageOn, run: () => deck.setUsageRange("1y") },
        { bind: "p", enabled: usageOn, run: () => deck.toggleUsageScope() },
        { bind: "j", enabled: usageOn, run: () => deck.usageScrollBy(1) },
        { bind: "down", enabled: usageOn, run: () => deck.usageScrollBy(1) },
        { bind: "k", enabled: usageOn, run: () => deck.usageScrollBy(-1) },
        { bind: "up", enabled: usageOn, run: () => deck.usageScrollBy(-1) },
        { bind: "r", enabled: usageOn, run: () => deck.usageReload() },
        // ? opens the help page (close returns to the usage page).
        {
          id: "opendeck.usage.help",
          title: "Opendeck: usage help",
          description: "Every Opendeck shortcut plus the symbol legend",
          group: "Opendeck",
          bind: "?",
          enabled: usageOn,
          run: () => deck.openHelp("usage"),
        },
        { bind: "shift+?", enabled: usageOn, run: () => deck.openHelp("usage") },
        { bind: "shift+/", enabled: usageOn, run: () => deck.openHelp("usage") },
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
        { bind: "pagedown", enabled: gitOn, run: () => deck.gitMove(page()) },
        { bind: "pageup", enabled: gitOn, run: () => deck.gitMove(-page()) },
        { bind: "g", enabled: gitOn, run: () => deck.gitSelect(0) },
        { bind: "shift+g", enabled: gitOn, run: () => deck.gitSelect(1_000_000) },
        { bind: "enter", enabled: gitOn, run: () => deck.gitOpenSelected() },
        { bind: "r", enabled: gitOn, run: () => deck.gitReload() },
        // ? opens the help page (close returns to the git log).
        {
          id: "opendeck.git.help",
          title: "Opendeck: git help",
          description: "Every Opendeck shortcut plus the symbol legend",
          group: "Opendeck",
          bind: "?",
          enabled: gitOn,
          run: () => deck.openHelp("git"),
        },
        { bind: "shift+?", enabled: gitOn, run: () => deck.openHelp("git") },
        { bind: "shift+/", enabled: gitOn, run: () => deck.openHelp("git") },
      ],
    }))

    // Help page keys: scoped to the "opendeck-help" keymap mode, pushed only
    // while the help route is current. escape/q/? all return to the page the
    // help page was opened from (deck.helpBack).
    const helpOn = () => deck.helpOpen()
    context.keymap.layer(() => ({
      mode: "opendeck-help",
      commands: [
        {
          id: "opendeck.help.close",
          title: "Opendeck: back from help",
          description: "Return from the help page to the page you came from",
          group: "Opendeck",
          bind: "escape",
          enabled: helpOn,
          run: () => deck.closeHelp(),
        },
        { bind: "q", enabled: helpOn, run: () => deck.closeHelp() },
        { bind: "?", enabled: helpOn, run: () => deck.closeHelp() },
        { bind: "shift+?", enabled: helpOn, run: () => deck.closeHelp() },
        { bind: "shift+/", enabled: helpOn, run: () => deck.closeHelp() },
        // Scroll the help list: same shape as the diff page's patch keys.
        { bind: "j", enabled: helpOn, run: () => deck.scrollHelp(1) },
        { bind: "down", enabled: helpOn, run: () => deck.scrollHelp(1) },
        { bind: "k", enabled: helpOn, run: () => deck.scrollHelp(-1) },
        { bind: "up", enabled: helpOn, run: () => deck.scrollHelp(-1) },
        { bind: "g", enabled: helpOn, run: () => deck.setHelpScroll(0) },
        { bind: "shift+g", enabled: helpOn, run: () => deck.setHelpScroll(1_000_000) },
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

    // Usage page: fourth plugin route, same crash guard.
    const unregisterUsage = context.ui.router.register({
      name: "opendeck-usage",
      render: ({ data }) => (
        <ErrorBoundary fallback={(err: unknown) => <CrashLine err={err} />}>
          <UsageView deck={deck} sessionID={typeof data?.sessionID === "string" ? data.sessionID : undefined} />
        </ErrorBoundary>
      ),
    })

    // Help page: fifth plugin route, same crash guard.
    const unregisterHelp = context.ui.router.register({
      name: "opendeck-help",
      render: ({ data }) => (
        <ErrorBoundary fallback={(err: unknown) => <CrashLine err={err} />}>
          <HelpView deck={deck} sessionID={typeof data?.sessionID === "string" ? data.sessionID : undefined} />
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
      unregisterUsage()
      unregisterHelp()
      remove()
      dispose()
    }
  },
})
