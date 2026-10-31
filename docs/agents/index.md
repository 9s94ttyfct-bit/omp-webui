---
title: omp-webui documentation for agents
summary: Start here: what omp-webui is, how the app is laid out, the conventions of these docs, and every topic.
settings:
---

# omp-webui documentation for agents

omp-webui is a web UI and macOS app for the omp coding agent. A local server (`omp-webui-server`, by default on `http://127.0.0.1:7878`) runs each conversation's `omp` process, reads omp's session files and serves the page; the macOS app is a native window around that page. These docs tell an agent running inside omp-webui how the app works, so that it can answer the person's questions about it accurately.

They are written in English only, by choice: one language keeps them exact and searchable. Answer the person in their own language, and name UI labels as the person sees them (the app is also in Chinese).

## How to read them

- In a conversation, use the `webui_docs` tool (mounted at `xd://webui_docs`): `{"action":"list"}`, `{"action":"search","query":"…"}`, `{"action":"read","topic":"guard","section":"Settings"}`. See the topic `webui-docs-tool`.
- Every topic has the same sections: **What it does**, **Where it is** (navigation path in the UI), **Settings**, **API routes**, **Limits and caveats**, **Security notes**.
- **Setting keys** in a `Key` table are fully qualified:
  - `ompw.<name>`: a preference of the web UI. The synced ones are kept by the server in `~/.omp-webui/ui-prefs.json` and given to every page (so they survive a reload, the app moving to another port, and show in every window); a few are per device (the browser's own storage) and each says so.
  - `guard.json:<field>`, `remote.json:<field>`, `mode.json:<field>`: a field of that file in the server's data folder (`~/.omp-webui`, or `OMP_WEBUI_DATA_DIR`).
  - `session:<name>`: a control of a conversation's *This session* panel that can be made omp's default for new conversations; the effect names the omp setting it writes.
  - `omp:<key>`: one of omp's own settings (in omp's `config.yml`) that the app reads or writes.
  - Other stored values are in tables with other headings, or in prose.
- **API routes** list the method and the **Access**: `local-only` routes answer only a page on the computer omp-webui runs on (a loopback connection, a loopback `Host`, no proxy headers) and refuse a page through the tunnel or the network whatever token it holds; `token` routes answer any page holding the access token, including a remote one, with any extra restriction said after it.

## Where things are

- **Sidebar**: New chat, the list of conversations (grouped by date and project, filter, pinned group, archive), and the pages: *Agent graph*, *Usage & cost*, *Memory*, *Commands & terminal*, *Settings*, *Guard* (not offered to a remote page). On a narrow window the pages are on a rail.
- **A conversation**: header (title, model, quota ring, guard switch, session settings, ⋯ menu), the transcript, the message box with its controls, the status line under it, and the right side panel: two panes of tabs, by default *Agents*, *Todos*, *Jobs*, *Branches*, *Info*, *Guidance*, *Questions* on top and *Files*, *Issues*, *Ask*, *Host*, *Terminal*, *Worktrees* below (a tab can be moved between panes).
- **Settings** (`#/settings/<page>`) has five pages: *Look & layout* (`look`), *Conversations & files* (`chats`), *Models & accounts* (`models`), *Approvals & safety* (`safety`), *App & system* (`app`), and a search box that finds any setting.
- **⌘K** (Ctrl+K elsewhere) searches every message of every conversation; see `conversations` and `shortcuts`.

## Topics

- [Appearance and layout](appearance.md)
- [Keyboard shortcuts](shortcuts.md)
- [Conversations, sidebar and history](conversations.md)
- [The message box](composer.md)
- [Session controls and permission mode](session-controls.md)
- [Compaction](compaction.md)
- [Agent graph and subagents](agent-graph.md)
- [Notifications](notifications.md)
- [Unattended mode and questions](unattended.md)
- [Quota and usage](quota-and-usage.md)
- [Projects, folders and git](projects-and-git.md)
- [Feedback](feedback.md)
- [Guard dangerous commands](guard.md)
- [Remote access](remote-access.md)
- [Files tab and file transfer](file-transfer.md)
- [Models, roles, presets and accounts](models.md)
- [Model guidance](model-guidance.md)
- [Memory](memory.md)
- [Full / Light mode](light-mode.md)
- [Updates of the app and of omp](updates.md)
- [The macOS app](macos-app.md)
- [Move to another computer](migration.md)
- [The server and its security](server-and-security.md)
- [The webui_docs tool](webui-docs-tool.md)
- [Ask agent for help](settings-help.md)

## Rules for an agent

- Answer from these docs; when they do not say, say so rather than guess.
- These docs describe what the app can do, not what this installation has set. To know a current value, ask the person or look where the topic says it is shown.
- Do not change the person's settings on their behalf unless they ask; never change guard, remote access, memory, update or migration settings unasked. The local-only routes refuse remote pages by design. A conversation started from Settings › Ask agent for help changes settings with its `webui_settings` tool only (topic `settings-help`), never by editing files.
