---
title: Appearance and layout
summary: Theme, colour palette, live animations, language, sidebar and side panel widths, the side panel's two panes, and which pages the sidebar and rail offer.
settings: theme, palette, animations, animation-intensity, reset-layout, nav-layout, language
---

# Appearance and layout

## What it does

- **Theme**: Light, Dark or System (follows the OS appearance and repaints when it changes). Applies on top of the palette.
- **Palette**: the colours of the whole app: Claude (warm paper, rust accent; the default), ChatGPT (neutral greys, ink accent), Terminal (green phosphor, monospace), OMP (violet and magenta), Hermes (deep teal, cream, amber).
- **Live animations** (off by default): motion that follows what the agent does. While the model writes a reply, a band of light sweeps over that reply and over the turn's running time under it; a running tool card has a bar moving along its bottom edge; on the agent graph, particles run along a spawn line when an agent starts another (parent to child), along a message line when one agent writes to another, and back up the spawn line (in green) when a subagent finishes well; when a turn ends well (its last reply stopped by itself, no error, no retry, not exited) or a goal is completed, a short burst of pieces and a ring rises from the bottom of the transcript (about 1–2 s). A turn of a goal run that goes on is not celebrated; the goal's completion is. Intensity: Subtle, Normal (default) or Lively — how bright the shimmer and bar are and how fast they move, how many particles each message sends (1 / 2 / 3), and how big the burst is (8 / 14 / 22 pieces; half as many again for a goal). The system's reduced-motion setting (`prefers-reduced-motion: reduce`) turns them all off whatever is chosen, and Settings says so under the switch. Nothing animates while the agent is idle: every effect is an element that exists only while what it follows runs, or a Web Animation of fixed length removed when it ends; the graph's particles have no frame loop, and none starts while the page is hidden. Only what this page saw happen is animated (opening a finished conversation celebrates nothing).
- **Language**: English or 简体中文. With no stored choice the page uses Chinese when the browser language starts with `zh`, else English.
- **Widths**: the left sidebar and the chat's right side panel are resized by dragging their edge; each width is remembered. *Reset to default size* puts both back.
- **Side panel panes**: the chat's right panel is two panes, one above the other. Each has a row of tabs and shows one of them; every tab is in exactly one row. Tabs: Agents, Todos, Jobs, Files, Issues, Info, Branches, Ask, Host, Terminal, Guidance, Questions, Worktrees. Default: top row Agents, Todos, Jobs, Branches, Info, Guidance, Questions (showing Agents); bottom row Files, Issues, Ask, Host, Terminal, Worktrees (showing Files). A tab can be dragged to the other pane or moved with its menu (*Move to top pane* / *Move to bottom pane*); a pane can be collapsed to its tab row (*Collapse the top pane* / *Expand…*); the divider between them is dragged (top pane share 10%–90%, default 50%). A pane whose row is empty is closed.
- **Sidebar and rail** (nav layout): which pages the sidebar and the rail (the 48 px strip left when the sidebar is hidden in a wide window) offer, and where. Pages: Agent graph, Usage & cost, Memory, Commands & terminal, Settings, Guard. Each surface has three groups: Top, Bottom, Hidden. Default: every page in Bottom, in that order, nothing on top. Items can also be dragged in either bar (to another place, the other group, or the Hide zone shown while dragging).

## Where it is

- Settings › Look & layout › Appearance: Theme (Light / Dark / System), Palette, *Live animations* (switch) with *Intensity* (Subtle / Normal / Lively; disabled while the switch is off), *Reset to default size*.
- Settings › Look & layout › Sidebar and rail: per-surface lists (Sidebar; Rail) with group pickers, move up/down buttons and *Reset to default* (every page at the bottom of both bars, in the original order).
- Settings › Look & layout › Language.
- Widths: drag the edge of the sidebar or the side panel. Toggle the sidebar with ⌘\ (Ctrl+\ elsewhere; see the shortcuts topic).
- Panes: the tab rows and divider of the side panel in a conversation.

## Settings

| Key | Values | Default | Effect |
|---|---|---|---|
| `ompw.theme` | `dark`, `light`, `system` | `dark` | Synced preference. Light/dark mode; `system` follows the OS. |
| `ompw.palette` | `claude`, `chatgpt`, `terminal`, `omp`, `hermes` | `claude` | Synced preference. Colour palette of the whole app. |
| `ompw.animations` | `on`, `off` | unset (= `off`) | Synced preference. Live animations (shimmer while generating, tool card bar, agent graph particles, completion burst). Off whatever it says while the system asks for reduced motion. |
| `ompw.animationIntensity` | `subtle`, `normal`, `lively` | unset (= `normal`) | Synced preference. How much the live animations move; used only while `ompw.animations` is `on`. |
| `ompw.lang` | `en`, `zh-CN` | unset: `zh-CN` if the browser language starts with `zh`, else `en` | Synced preference. UI language. |
| `ompw.sidebarWidth` | whole number of pixels, 1–4 digits | unset: 288 | Synced preference. Sidebar width; the page clamps it to 200–480 px and to the room left for the conversation (at least 480 px). Unset by *Reset to default size*. Not used below 900 px window width (the sidebar is a drawer). |
| `ompw.panelWidth` | whole number of pixels, 1–4 digits | unset: 400 | Synced preference. Side panel width; clamped to 280–720 px. Unset by *Reset to default size*. Not used on phone layouts (the panel is a sheet). |
| `ompw.panelPanes` | JSON pane layout (rows of tab ids per pane, the tab each pane shows, the collapsed pane, the divider share) | unset: the default rows above | Synced preference. Side panel pane layout; the default layout is stored as unset. Unknown tab ids are dropped; tabs a later version adds go to their default row. |
| `ompw.navLayout` | JSON `{ v: 1, sidebar, rail }`, each `{ top, bottom, hidden }` lists of `agents`, `usage`, `memory`, `cli`, `settings`, `guard` | unset: every page in `bottom` | Per-device localStorage key (never synced: the rail of a phone is not that of a desktop). Arrangement of the sidebar and rail pages. |

Synced preferences are stored on the server in `ui-prefs.json` in the data folder (`~/.omp-webui` for the web version; Application Support for the macOS app) and applied to every page and port before first paint.

## API routes

| Route | Methods | Access | Purpose |
|---|---|---|---|
| `/api/prefs` | GET, POST | token (POST changing `ompw.keepAwake`: this computer only) | GET returns the snapshot `{ id, rev, values }` of every synced preference (null where unset). POST `{ changes: { <key>: string \| null } }` sets or forgets keys; the whole request is refused (400) on an unknown key, a non-string value, a value over 16 KiB or a value the app never writes. A change is broadcast to every open page. |

## Limits and caveats

- Synced preferences follow the person across browser origins and ports; the nav layout and keyboard shortcuts stay on one device/browser.
- A stored value that is not valid (hand-edited, from another version) is ignored and the default is shown.
- Widths are not applied in phone layouts; the panel width also limits how many pane tabs show their labels.
- The Guard page item is never shown to a page that is not on this computer (a tunnel or network page), whatever the nav layout says.

## Security notes

- `/api/prefs` is open to any page holding the access token (including through the tunnel); only the keep-awake key is refused to pages not on this computer.
- Preferences hold no secrets. Agents should change appearance settings only when the user asks.
