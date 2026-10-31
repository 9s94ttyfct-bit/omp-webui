---
title: Appearance and layout
summary: Theme, colour palette, language, sidebar and side panel widths, the side panel's two panes, and which pages the sidebar and rail offer.
settings: theme, palette, reset-layout, nav-layout, language
---

# Appearance and layout

## What it does

- **Theme**: Light, Dark or System (follows the OS appearance and repaints when it changes). Applies on top of the palette.
- **Palette**: the colours of the whole app: Claude (warm paper, rust accent; the default), ChatGPT (neutral greys, ink accent), Terminal (green phosphor, monospace), OMP (violet and magenta), Hermes (deep teal, cream, amber).
- **Language**: English or 简体中文. With no stored choice the page uses Chinese when the browser language starts with `zh`, else English.
- **Widths**: the left sidebar and the chat's right side panel are resized by dragging their edge; each width is remembered. *Reset to default size* puts both back.
- **Side panel panes**: the chat's right panel is two panes, one above the other. Each has a row of tabs and shows one of them; every tab is in exactly one row. Tabs: Agents, Todos, Jobs, Files, Issues, Info, Branches, Ask, Host, Terminal, Guidance, Questions, Worktrees. Default: top row Agents, Todos, Jobs, Branches, Info, Guidance, Questions (showing Agents); bottom row Files, Issues, Ask, Host, Terminal, Worktrees (showing Files). A tab can be dragged to the other pane or moved with its menu (*Move to top pane* / *Move to bottom pane*); a pane can be collapsed to its tab row (*Collapse the top pane* / *Expand…*); the divider between them is dragged (top pane share 10%–90%, default 50%). A pane whose row is empty is closed.
- **Sidebar and rail** (nav layout): which pages the sidebar and the rail (the 48 px strip left when the sidebar is hidden in a wide window) offer, and where. Pages: Agent graph, Usage & cost, Memory, Commands & terminal, Settings, Guard. Each surface has three groups: Top, Bottom, Hidden. Default: every page in Bottom, in that order, nothing on top. Items can also be dragged in either bar (to another place, the other group, or the Hide zone shown while dragging).

## Where it is

- Settings › Look & layout › Appearance: Theme (Light / Dark / System), Palette, *Reset to default size*.
- Settings › Look & layout › Sidebar and rail: per-surface lists (Sidebar; Rail) with group pickers, move up/down buttons and *Reset to default* (every page at the bottom of both bars, in the original order).
- Settings › Look & layout › Language.
- Widths: drag the edge of the sidebar or the side panel. Toggle the sidebar with ⌘\ (Ctrl+\ elsewhere; see the shortcuts topic).
- Panes: the tab rows and divider of the side panel in a conversation.

## Settings

| Key | Values | Default | Effect |
|---|---|---|---|
| `ompw.theme` | `dark`, `light`, `system` | `dark` | Synced preference. Light/dark mode; `system` follows the OS. |
| `ompw.palette` | `claude`, `chatgpt`, `terminal`, `omp`, `hermes` | `claude` | Synced preference. Colour palette of the whole app. |
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
