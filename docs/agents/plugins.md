---
title: Plugins page
summary: The page that manages omp's plugins, skills and MCP servers, in tabs: installed plugins (switch, upgrade, uninstall, features, settings, health check); Discover (recommended marketplaces and skill libraries with one-click Add, the marketplaces' catalogs, installing by package, git URL or folder); Skills (every skill omp has, omp's skill registry); MCP servers (the official MCP Registry, added to omp's user mcp.json); the marketplaces themselves.
settings:
---

# Plugins page

## What it does

Manages omp's plugins, skills and MCP servers on the computer omp-webui runs on. Plugins and skills are changed by omp's own CLI (`omp plugin …`, `omp skill …`, run without a shell, in the server's environment: the same HOME and agent directory as the Commands & terminal page), never by editing omp's files; the one exception is a new MCP server (below), for which omp has no command. omp keeps the user's plugins under `~/.omp/plugins` (`installed_plugins.json`, `omp-plugins.lock.json`, `node_modules`) and the marketplaces in `~/.omp/marketplaces.json` with their catalogs under `~/.omp/plugins/cache/marketplaces/`; a project's own plugins are under the project's `.omp/plugins`. Registry skills are listed in `skills.json` / `skills.lock.json` of omp's agent directory (or a project's `.omp`), the user's MCP servers in the agent directory's `mcp.json`.

The page has five tabs (Installed, Discover, Skills, MCP servers, Marketplaces); the folder picker and the outcome of the last change are above them.

- **Folder**: omp's CLI runs in the home folder (the user's plugins) or in a project folder chosen from the recent conversations' folders. In a project folder omp lists that project's plugins with the user's, and a marketplace plugin can be installed for the project (scope `project`).
- **Installed**: one card per plugin and scope, with its version, scope (`user` / `project`), where it came from (the marketplace's name, `npm` for npm and git installs, `folder` for a linked local folder), its description, and a note when the project's copy shadows a user one.
  - **Switch**: `omp plugin enable|disable [--scope] <id>`.
  - **Upgrade**: `omp plugin upgrade <id> [--scope]` (not offered for a linked folder). A marketplace plugin whose catalog has a newer version shows it (`omp plugin upgrade --dry-run`, read each time the page lists), and the section offers **Upgrade all (N)**, which lists what would be upgraded and asks before running `omp plugin upgrade`.
  - **Uninstall**: asks first, then `omp plugin uninstall <id> [--scope]`. A linked folder is unlinked; the folder itself stays.
  - **Features** (plugins whose manifest declares `omp.features`): checkboxes; Save runs `omp plugin features <name> --set a,b` (or `--disable` all of them when none is ticked). Until the person chooses, omp turns on the features marked default.
  - **Settings** (plugins whose manifest declares `omp.settings`): each setting's key, type, description, the environment variable it is also read from, and its value or default; Save runs `omp plugin config set <name> <key> <value>`, **Reset to default** runs `omp plugin config delete`. A secret setting's value is never sent to a page: it shows only whether it is set.
- **Discover** tab:
  - **Recommended marketplaces** (`shared/plugins-catalogs.ts`, each checked on 2026-11-03 to hold a `.claude-plugin/marketplace.json` under the name listed): plugin marketplaces `anthropics/claude-plugins-official` (official), `anthropics/claude-plugins-community`, `anthropics/knowledge-work-plugins`, `wshobson/agents`, `obra/superpowers-marketplace`, `EveryInc/compound-engineering-plugin`, `jeremylongshore/claude-code-plugins-plus-skills`, `ChromeDevTools/chrome-devtools-mcp`; skill libraries `anthropics/skills`, `trailofbits/skills`, `addyosmani/web-quality-skills`. Each shows *added as <name>* when a configured marketplace has its name or its GitHub repository (`owner/repo`, a GitHub URL, with or without `.git`), else **Add**, which runs `omp plugin marketplace add <owner/repo>` as a job. `anthropics/claude-code` is deprecated and not listed. A link opens claude.com's web catalog.
  - **Catalogs**: every plugin of every added marketplace (`omp plugin discover <marketplace>`), with a filter, its version, description, marketplace, and the scopes it is installed in. **Install** with a scope runs `omp plugin install <name>@<marketplace> --scope <scope>`.
  - **Install from npm, git or a folder**: a package (`name`, `name@1.2.3`, `name[feature]`), `github:user/repo[#ref]`, a git URL, a folder on this computer (`~/…` is taken from the home folder; a folder is linked, so edits in it apply), or `name@marketplace`. The scope applies to marketplace plugins only (omp ignores it for the rest).
- **Skills** tab: every skill omp discovers in the folder (`omp skill list --json`: name, description, where omp found it, `user` / `project`, hidden), with a filter; a skill from omp's registry shows its version and **Uninstall** (asks first; `omp skill uninstall <@scope/name> [-g]`). **omp's skill registry** searches skills.omp.sh (`omp skill search <query> --json`); **Install** runs `omp skill install <@scope/name> -g` (user) or without `-g` (project). The registry is still small: no hit says so and offers the skill libraries of Discover. omp refuses to install a skill that ships scripts without a terminal to ask on; the page then shows what omp listed (**Review scripts**) and, if the person agrees, runs the install again with `-y`.
- **MCP servers** tab: searches the official MCP Registry (`GET <registry>/v0/servers?search=<q>&limit=20&version=latest`, fetched by the server with a 15 s timeout and a 2 MiB cap; **More** follows its cursor). Each server shows its title, name, version, description, repository, whether a server in the user's or the folder's `mcp.json` already runs it (*added as <name>*: the same package at any version, or the same address), and its ways of running it. **Add to omp** opens a dialog: the name in omp's config (the last part of the registry name; one already in the user's `mcp.json` is refused) and the values it needs (environment variables, headers, arguments, `{placeholders}`; secret ones in password fields, defaults as placeholders). The server fetches the entry again from the registry (`/v0/servers/<name>/versions/<version>`), never trusting the page for it, and writes the user's `mcp.json` in omp's agent directory as omp's `/mcp add` does: an npm package as `{ type: "stdio", command: "npx", args: ["-y", "<pkg>@<version>", …], env }`, a PyPI package with `uvx <pkg>@<version>`, an OCI image with `docker run -i --rm [-e NAME…] <image>`, a remote as `{ type: "http" | "sse", url, headers }`. Refused, with why: other package kinds (nuget, cargo, mcpb…), a package from a registry other than npm's or PyPI's public one, a package that serves HTTP itself, a remote transport omp does not speak, a name or value that could be read as something else. Conversations started afterwards connect the server; a running one after a restart. Links to Smithery, Glama and mcp.so (Smithery's API needs a key, so it is not searched).
- **Marketplaces** tab: each added marketplace and its source, **Update** (`omp plugin marketplace update [<name>]`, also **Update all**), **Remove** (asks first; plugins installed from it stay installed), and **Add** by `owner/repo`, a git URL or a folder that holds `.omp-plugin/marketplace.json` or `.claude-plugin/marketplace.json`. A marketplace whose catalog cannot be read shows omp's error.
- **Doctor**: **Run checks** shows `omp plugin doctor --json` (the plugins folder, its package files, each plugin's manifest and entries, version drift); **Fix** runs `omp plugin doctor --fix` when a check is not ok.

**Progress**: an install, upgrade, uninstall, Fix, every marketplace change and every skill install or uninstall run as a job on the server; the page shows the command, what omp prints as it goes, and omp's own error text when it fails. A switch, features, settings and adding an MCP server answer at once. One change runs at a time (also in turn with the Loaded dialog's switches); while one runs the page's controls wait, and a page opened meanwhile follows it.

**Open conversations**: after a change a conversation loads (anything but a marketplace's catalog), every running Full conversation is told to `/reload-plugins`, and the page lists which reloaded, which need a restart (their omp has no `/reload-plugins`, or it did not answer in 20 s: Restart in the conversation's panel) and which are paused (they see it after Resume and a restart). Light conversations load no plugins and are left alone.

## Where it is

- Sidebar / rail item **Plugins** (`plugins`, `#/plugins`), where Commands & terminal was; also in the command palette's Go to.
- Settings › App & system › **omp configuration** › **Plugins** opens it.
- A conversation's Loaded dialog keeps its own plugin switches (see [session-controls.md](session-controls.md)).

## Settings

None of omp-webui's own. What the page changes is omp's: its plugin files under `~/.omp/plugins` (or a project's `.omp/plugins`), `~/.omp/marketplaces.json`, its registry skills, and the user's `mcp.json` in omp's agent directory. `OMPW_MCP_REGISTRY` (tests only) points the MCP tab at a stand-in registry.

## API routes

| Route | Methods | Access | Purpose |
|---|---|---|---|
| `/api/plugins` | GET | token | Query `cwd?` (an absolute folder; none: the home folder). `{ cwd, home, installed, marketplaces, catalog, upgradeError }`; each list is `{ error }` on its own when omp could not answer. |
| `/api/plugins/doctor` | GET | token | Query `cwd?`: `{ checks: [{ name, status: ok\|warning\|error, message, fixed? }] }` from `omp plugin doctor --json`. |
| `/api/plugins/config` | GET, POST | token | GET: query `name`, `cwd?`: `{ settings }` (a secret's value is never included). POST `{ name, key, value, cwd? }` (`value` null deletes it): `{ settings, reloads }`. |
| `/api/plugins/enable` | POST | token | `{ id, enabled, scope?, cwd? }`: `omp plugin enable\|disable`. Answers `{ reloads }`. |
| `/api/plugins/features` | POST | token | `{ name, features: string[], cwd? }`: exactly these features on. Answers `{ reloads }`. |
| `/api/plugins/jobs` | GET, POST | token | GET: `{ running }`, the job running now or null. POST `{ action, cwd?, … }` starts one (202 `{ job }`): `install` `{ spec, scope?, force? }`, `uninstall` `{ id, scope? }`, `upgrade` `{ id?, scope? }` (no id: all), `doctor-fix`, `marketplace-add` `{ source }`, `marketplace-remove` `{ name }`, `marketplace-update` `{ name? }`, `skill-install` `{ spec, scope?, yes? }`, `skill-uninstall` `{ id, scope? }`. 409 while another change runs or an import writes. |
| `/api/plugins/skills` | GET | token | Query `cwd?`: `{ installed: [{ name, description, provider, level, path, hidden, registry: { id, version } \| null }] }` from `omp skill list --json`. |
| `/api/plugins/skills/search` | GET | token | Query `q`, `cwd?`: `{ total, hits: [{ id, version, description, weeklyDownloads, publisher, keywords, deprecated }] }` from `omp skill search <q> --json`. |
| `/api/plugins/mcp/search` | GET | token | Query `q?`, `cursor?`, `cwd?`: `{ servers: [{ name, title, description, version, repository, website, options: [{ id, kind, transport, summary, inputs, problem }], configName, added }], nextCursor, taken }`; 502/504 when the registry fails or is slow. |
| `/api/plugins/mcp` | POST | token | `{ server, version, option, name, values, cwd? }`: adds that way of running the server to the user's `mcp.json`; `{ name, file }`. 400 for a bad name or a required value left empty, 404 for a server or option the registry does not have, 409 for a name already there (or a file that is not JSON) or while another change runs, 422 for an option that cannot be mapped. |
| `/api/plugins/jobs/<id>` | GET | token | `{ job: { id, action, command, state: running\|done\|failed, output, error, startedAt, endedAt, reloads } }`; the last 20 jobs are kept. |

`reloads` is `[{ liveId, sessionFile, state: reloaded\|restart\|paused }]`. A job omp refused because the skill ships scripts has `confirm: "scripts"`. Errors answer `{ error }`: 400 for an argument refused before omp runs, 409 (busy, folder gone, import), 422 with omp's own words when omp failed, 504 when it did not finish in time (30 s for a listing or a quick change, 2 minutes for an uninstall or a removal, 10 minutes for what fetches).

## Limits and caveats

- Every name, spec, source, feature, key and value is checked before it is put on omp's command line: anything that starts with `-` (omp would read it as a flag, and drop one it does not know) or holds a control character is refused, and so is a project scope in the home folder. A setting's value that starts with `-` cannot be set here (omp's CLI cannot take it); use the terminal's `omp plugin config set` with omp's own quoting, or the plugin's environment variable.
- A marketplace plugin has no features or settings omp can switch from its CLI; a linked folder is not upgraded (edit the folder).
- npm and git installs and adding a marketplace from GitHub need the network and `git` / `bun` on this computer; omp prints why when they fail.
- What omp prints is shown as it is (English).

## Security notes

- The routes are open to every page that has the token (not local-only), as the Commands & terminal page is: that page already runs any `omp` command line, `omp plugin` and `omp skill` included, for such a page, and a conversation's `/mcp add` adds any MCP server, so these routes give it nothing more; a change waits while an import writes and runs one at a time. A plugin, a skill with scripts or an MCP server runs code in every later conversation's omp, so adding one is as consequential as running a command; the page adds nothing by itself, and agents must not install, upgrade or remove plugins or skills, or add MCP servers, through this API unless the person asks.
- A secret setting's value stays on this computer: `/api/plugins/config` answers only whether it is set. An MCP value is written to `mcp.json` (mode 0600) and never sent back, logged or repeated in an error.
- The MCP Registry is fetched by the server only, with a timeout and a size cap; what it says is data (a package name or a value that could be read as a flag is refused), and the entry written is built from the registry's own answer, fetched again on Add.
- omp runs without a shell; nothing the page sends is interpreted by one.
