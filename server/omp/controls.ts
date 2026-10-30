import { existsSync } from "node:fs";
import { CodedError } from "../../shared/error-info.ts";
import { isRecord } from "../../shared/guards.ts";
import type { Config } from "../config.ts";
import { type Live, type LivePool, refusal } from "../live.ts";
import type { SessionStore } from "../sessions/store.ts";
import { readPanelConfig, setClaudeSlowMode } from "./panel-config.ts";
import { SessionDefaultError, setSessionDefault } from "./session-defaults.ts";
import { configuredSettings } from "./session-settings.ts";
import { replaceTodos, TODO_MARKDOWN_MAX, TodoError } from "./todos.ts";
import {
	McpSwitchError,
	setMcpServerEnabled,
	setPluginEnabled,
	setSkillEnabled,
	skillSettled,
	type ToggleTarget,
	validMcp,
	validPlugin,
	validSkill,
} from "./toggles.ts";

/**
 * `POST /api/controls/<action>`: things the terminal does that the page asks for with a click, each carried out
 * by omp itself (a slash command of the conversation's process, or omp's CLI), never by editing omp's files.
 */

export interface ControlsDeps {
	cfg: Config;
	pool: LivePool;
	store: SessionStore;
}

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const fail = (error: string, status: number) => json({ error }, status);

/** The conversation's running omp; one that is gone or closing cannot take a command. */
function runningLive(deps: ControlsDeps, id: unknown): Live | null {
	const live = typeof id === "string" ? deps.pool.get(id) : undefined;
	return live && !live.info.exited && !live.client.closing ? live : null;
}

/** A conversation as a request names it: by its running process (`live`) and/or its saved file (`file`). */
interface Conversation {
	cwd: string;
	live: Live | null;
	light: boolean;
	target: ToggleTarget;
}

async function conversation(deps: ControlsDeps, body: Record<string, unknown>): Promise<Conversation | null> {
	const live = runningLive(deps, body.live);
	const file = typeof body.file === "string" ? deps.store.resolveSessionPath(body.file) : null;
	const cwd = live?.info.cwd ?? (file ? (await deps.store.get(file))?.cwd : null);
	if (!cwd) return null;
	return {
		cwd,
		live,
		light: live?.info.mode === "light",
		// omp's CLI runs in the conversation's folder, with the environment (agent directory) its process was started with.
		target: {
			bin: deps.cfg.ompBin,
			cwd,
			neutral: deps.cfg.dataDir,
			agentDir: live?.env.PI_CODING_AGENT_DIR ?? deps.cfg.agentDir,
			env: live?.env ?? {},
		},
	};
}

type Action = (deps: ControlsDeps, body: Record<string, unknown>) => Promise<Response>;

const ACTIONS: Record<string, Action> = {
	/** `{ live, markdown }`: the conversation's todo list becomes `markdown` (omp's `/todo import` format). */
	"/todos": async (deps, body) => {
		const live = runningLive(deps, body.live);
		if (!live) return fail("This conversation has no running omp", 404);
		if (typeof body.markdown !== "string") return fail("markdown required", 400);
		if (body.markdown.length > TODO_MARKDOWN_MAX) return fail("The todo list is too long", 413);
		await replaceTodos(live, body.markdown);
		live.announceTodos();
		return json({ ok: true });
	},

	/**
	 * `{ live, name, enabled }`: a skill on or off, for every conversation. Only a running conversation lists skills,
	 * so only one has the switch. `overridden`: another layer of omp's settings (`project`…) decides for this folder.
	 */
	"/skill": async (deps, body) => {
		const c = await conversation(deps, body);
		if (!c?.live) return fail("This conversation has no running omp", 404);
		if (!validSkill(body.name) || typeof body.enabled !== "boolean") return fail("name and enabled required", 400);
		if (!existsSync(c.cwd)) return fail(`Folder no longer exists: ${c.cwd}`, 409);
		const overridden = await setSkillEnabled(c.target, body.name, body.enabled);
		// Where another layer decides, or the process is frozen, it will not change: nothing to wait for.
		if (overridden === null && c.live.info.pausedAt === null) await skillSettled(c.live, body.name, body.enabled);
		return json({ ok: true, overridden });
	},

	/**
	 * `{ live?, file?, name, enabled, scope? }`: a plugin on or off. `reloaded`: the conversation's running omp has
	 * reloaded its plugins, so its skills and commands follow at once.
	 */
	"/plugin": async (deps, body) => {
		const c = await conversation(deps, body);
		if (!c) return fail("Unknown conversation", 404);
		if (c.light) return fail("omp loads no plugins in Light mode", 409);
		if (!validPlugin(body.name) || typeof body.enabled !== "boolean") return fail("name and enabled required", 400);
		const scope = body.scope ?? null;
		if (scope !== null && scope !== "user" && scope !== "project") return fail("scope must be user or project", 400);
		if (!existsSync(c.cwd)) return fail(`Folder no longer exists: ${c.cwd}`, 409);
		return json({ ok: true, reloaded: await setPluginEnabled(c.target, body.name, scope, body.enabled, c.live) });
	},

	/**
	 * `{ live, name, enabled }`: an MCP server on or off in the config it is defined in (`scope`). The running omp does
	 * not connect or drop servers after it started, so the change applies when this conversation's omp is started anew
	 * (`/restart`). Only a running Full conversation has the switch: Light ones load the servers chosen in Settings.
	 */
	"/mcp": async (deps, body) => {
		const c = await conversation(deps, body);
		if (!c?.live) return fail("This conversation has no running omp", 404);
		if (c.light) return fail("A Light conversation loads the MCP servers chosen in Settings › Full / Light", 409);
		if (typeof body.enabled !== "boolean" || typeof body.name !== "string")
			return fail("name and enabled required", 400);
		if (!validMcp(body.name)) return fail("omp's /mcp enable and /mcp disable cannot take this server's name", 400);
		if (!existsSync(c.cwd)) return fail(`Folder no longer exists: ${c.cwd}`, 409);
		return json({ ok: true, ...(await setMcpServerEnabled(c.target, c.live, body.name, body.enabled)) });
	},

	/**
	 * `{ live }`: end the conversation's omp when it is idle, so the page can resume the same session file with a new
	 * one. 409 while it is working, waiting for an answer or paused, and which of them it says: nothing is cut off.
	 */
	"/restart": async (deps, body) => {
		const live = runningLive(deps, body.live);
		if (!live) return fail("This conversation has no running omp", 404);
		const busy = await deps.pool.endIfIdle(live);
		if (busy) return fail(refusal(busy), 409);
		return json({ ok: true });
	},

	/**
	 * `{ live, setting, value }`: what the conversation's session control `setting` says (see `SESSION_DEFAULTS`)
	 * becomes omp's global default, which new conversations start with. The other running conversations keep what they
	 * have; this one keeps its own value, which is the one written. A Light conversation's settings are its own: its
	 * omp reads another agent directory, so they are no default of omp's.
	 */
	"/default": async (deps, body) => {
		const c = await conversation(deps, body);
		if (!c?.live) return fail("This conversation has no running omp", 404);
		if (c.light) return fail("A Light conversation's settings are not omp's defaults", 409);
		await setSessionDefault(deps.cfg, deps.pool, c.live, c.target.agentDir, body.setting, body.value);
		return json({ ok: true });
	},

	/**
	 * `{ live }`: what omp's configuration says of the controls omp cannot report (`UNREPORTED`: auto-retry, cache warming) for
	 * this conversation's process, which uses it wherever the conversation was not told otherwise (`LiveInfo.sessionSettings`).
	 * Read the way the process was started: its folder, its agent directory (Light has one of its own), its
	 * `--config` files and its `--profile`.
	 */
	"/settings": async (deps, body) => {
		const live = runningLive(deps, body.live);
		if (!live) return fail("This conversation has no running omp", 404);
		return json(await configuredSettings(deps.cfg, live));
	},

	/**
	 * `{ live }`: what omp's configuration says that the controls show beside `get_state` (see `PanelConfig`):
	 * `claudeSlow`, Claude's slow mode, which is omp's global setting whatever model the conversation runs on, and
	 * `defaults`, what a new conversation in the folder starts with, which tells the rows that already are the default.
	 */
	"/panel-config": async (deps, body) => {
		const live = runningLive(deps, body.live);
		if (!live) return fail("This conversation has no running omp", 404);
		return json(await readPanelConfig(deps.cfg, live));
	},

	/** `{ live, enabled }`: Claude's slow mode on or off in omp's global configuration, for every conversation. */
	"/claude-slow": async (deps, body) => {
		const c = await conversation(deps, body);
		if (!c?.live) return fail("This conversation has no running omp", 404);
		if (c.light)
			return fail("A Light conversation has settings of its own: Claude's slow mode is changed in Full", 409);
		if (typeof body.enabled !== "boolean") return fail("enabled required", 400);
		await setClaudeSlowMode(deps.cfg, c.live, body.enabled);
		return json({ ok: true });
	},
};

export async function handleControls(req: Request, url: URL, deps: ControlsDeps): Promise<Response> {
	const action = url.pathname.slice("/api/controls".length);
	if (!Object.hasOwn(ACTIONS, action)) return fail("Not found", 404);
	if (req.method !== "POST") return fail("POST required", 405);
	const body: unknown = await req.json().catch(() => null);
	if (!isRecord(body)) return fail("The body must be a JSON object", 400);
	try {
		return await ACTIONS[action](deps, body);
	} catch (e) {
		if (e instanceof TodoError || e instanceof McpSwitchError || e instanceof SessionDefaultError)
			return fail(e.message, e.status);
		// A closed omp that has not ended yet (`/restart` waits for it): the request is right, the moment is not.
		if (e instanceof CodedError && e.code === "stillFinishing") return fail(e.message, 409);
		return fail(e instanceof Error ? e.message : String(e), 500);
	}
}
