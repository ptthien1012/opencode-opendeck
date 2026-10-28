/** @jsxImportSource @opentui/solid */
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { ErrorBoundary } from "solid-js"
import { maskSecrets, truncate } from "./format.js"
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
      flightdeck: {message()}
    </text>
  )
}

export default Plugin.define({
  id: "flightdeck",
  setup(context) {
    const { deck, dispose } = createDeck(context)

    // Open: /flightdeck slash command + command palette entry, reachable from
    // anywhere (mode "global"). No default keybind: the host already binds
    // ctrl+g (session.first) and a lower-priority bind never dispatches, so
    // auto-binding is disabled — bind your own via the "flightdeck.open"
    // command id in keybinds config.
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "flightdeck.open",
          title: "Open Flightdeck",
          description: "Open the Flightdeck dashboard full screen",
          group: "Flightdeck",
          palette: true,
          slash: { name: "flightdeck" },
          bind: false,
          enabled: () => !deck.isFullRoute(),
          run: () => deck.openFullview(),
        },
      ],
    }))

    // Close/toggle keys: scoped to the "flightdeck" keymap mode, which the
    // deck pushes only while the full view is the current route and pops on
    // close — so they can't fire over the prompt or a dialog on top.
    context.keymap.layer(() => ({
      mode: "flightdeck",
      commands: [
        {
          id: "flightdeck.close",
          title: "Close Flightdeck",
          description: "Return from the Flightdeck full view to the session",
          group: "Flightdeck",
          bind: "escape",
          enabled: () => deck.isFullRoute(),
          run: () => deck.closeFullview(),
        },
        {
          id: "flightdeck.toggle",
          title: "Flightdeck: toggle cards/lanes",
          description: "Switch the agents area between card grid and swimlanes",
          group: "Flightdeck",
          bind: "t",
          enabled: () => deck.isFullRoute(),
          run: () => deck.setLanes(!(deck.lanesPref() ?? false)),
        },
        {
          bind: "q",
          enabled: () => deck.isFullRoute(),
          run: () => deck.closeFullview(),
        },
      ],
    }))

    // Full-screen view: a plugin route (the widest surface the v2 API offers).
    const unregister = context.ui.router.register({
      name: "flightdeck",
      render: ({ data }) => (
        <ErrorBoundary fallback={(err: unknown) => <CrashLine err={err} />}>
          <FullView deck={deck} sessionID={typeof data?.sessionID === "string" ? data.sessionID : undefined} />
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
      remove()
      dispose()
    }
  },
})
