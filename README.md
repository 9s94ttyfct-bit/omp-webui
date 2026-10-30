<p align="center">
  <img src="web/public/icon-512.png" alt="omp-webui icon" width="128" height="128">
</p>

<h1 align="center">omp-webui</h1>

<p align="center">A web UI and macOS app for the <a href="https://omp.sh">omp</a> coding agent.</p>

<p align="center"><b>English</b> · <a href="README.zh-CN.md">简体中文</a></p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/chat-en-dark.png">
    <img alt="omp-webui: a conversation with tool calls, the sidebar of conversations and the status line" src="docs/screenshots/chat-en-light.png" width="860">
  </picture>
</p>

## Key features

- **Every conversation, searchable**: all omp sessions by date and project, ⌘K full-text search, branches you flip between with ‹ 1/2 ›.
- **Subagents you can watch**: a live tree with status, cost and transcript, steer or stop any of them, and an agent graph of who started and messaged whom.
- **Tokens, cost and quota**: the terminal's stats line per turn, totals that include subagents, a usage dashboard and each provider's remaining quota.
- **Models your way**: omp's model roles and presets in one click, goal and plan mode, and a Light mode that loads only the tools, MCP servers and skills you pick.
- **A guard for dangerous commands**: high-risk tool calls, in the main agent and every subagent, wait for a reviewer model or for you.
- **Unattended mode**: the agent keeps working while you are away and files its questions in a Questions list.
- **From your phone**: remote access through a Cloudflare Tunnel with Access, a layout for narrow screens, and push notifications when a conversation needs you.
- **A macOS app**: installs omp for you, updates itself from the releases, runs in the background from the menu bar, and moves your setup to another Mac.

## Install

**macOS app** (Apple Silicon, macOS 13 or later): download `omp-webui-vX.Y.Z.dmg` from the [latest release](../../releases/latest), drag **omp-webui** onto **Applications**, then run once:

```sh
xattr -dr com.apple.quarantine /Applications/omp-webui.app
```

The app is signed with a self-signed certificate, not notarized; the command lifts the quarantine (or choose **Open Anyway** in System Settings › Privacy & Security). On first start it offers to install [omp](https://omp.sh) if it is missing.

**From source**, for development (any system with [Bun](https://bun.sh) ≥ 1.3 and `omp` on `PATH`):

```sh
bun install
bun run build
bun run start          # then open the http://127.0.0.1:7878/?token=… link it prints
```

Configuration (port, address, data folder, remote access) and troubleshooting are in the [technical documentation](docs/TECHNICAL.md#configuration).

## Links

- [Technical documentation](docs/TECHNICAL.md) ([中文](docs/TECHNICAL.zh-CN.md)): every feature in detail, usage, troubleshooting, configuration, security, remote access, tests and releasing.
- [Release notes](release-notes/): one file per version, in English and Chinese.
- [Issues](../../issues): report a bug or ask for a feature. Say the omp-webui version (the sidebar's version line), `omp --version` and what happened; issues are public, so leave out tokens, `?token=…` links and private host names or paths. See [Issues and pull requests](docs/TECHNICAL.md#issues-and-pull-requests).

This repository starts at v0.12.2; issue numbers from before it (in the code, tests and release notes) refer to the earlier repository.
