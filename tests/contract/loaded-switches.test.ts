import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LoadedData, LoadedPlugin, LoadedSkill } from "../../shared/loaded.ts";
import type { LiveInfo } from "../../shared/protocol.ts";
import { pollUntil } from "../support/poll.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { type StubOmlx, startStubOmlx } from "../support/stub-omlx.ts";
import { connect, request } from "../support/ws.ts";

/**
 * The Loaded dialog's switches against the real server and the real omp, no model call. A skill is switched by
 * `skill:<name>` in omp's global `disabledExtensions` (which a running omp rediscovers skills from at once); a plugin by
 * `omp plugin enable|disable`, after which the conversation's omp reloads its plugins, so its skills follow.
 */

let s: TestServer;
let omlx: StubOmlx;

const send = (path: string, body: unknown) =>
	fetch(`${s.url}${path}`, {
		method: "POST",
		headers: { "x-omp-webui-token": s.accessToken, "x-omp-webui": "1", "content-type": "application/json" },
		body: JSON.stringify(body),
	});
const loaded = async (query: string): Promise<LoadedData> => {
	const res = await fetch(`${s.url}/api/loaded?${query}`, {
		headers: { "x-omp-webui-token": s.accessToken, "x-omp-webui": "1" },
	});
	expect(res.status).toBe(200);
	return res.json();
};
const skillsOf = (d: LoadedData): LoadedSkill[] => {
	expect(Array.isArray(d.skills)).toBe(true);
	return d.skills as LoadedSkill[];
};
const pluginsOf = (d: LoadedData): LoadedPlugin[] => {
	expect(Array.isArray(d.plugins)).toBe(true);
	return d.plugins as LoadedPlugin[];
};

async function open(target: object) {
	const ws = await connect(s);
	const info = await request<LiveInfo>(ws, { t: "open", target });
	const rpc = <T>(command: Record<string, unknown>) => request<T>(ws, { t: "rpc", liveId: info.liveId, command });
	return {
		info,
		/** The slash-command names omp offers right now. */
		commands: async () =>
			(await rpc<{ commands: { name: string }[] }>({ type: "get_available_commands" })).commands.map((c) => c.name),
		pause: () => request<LiveInfo>(ws, { t: "pause", liveId: info.liveId }),
		resume: () => request<LiveInfo>(ws, { t: "resume", liveId: info.liveId }),
		listing: async () => (await request<LiveInfo[]>(ws, { t: "list_lives" })).find((l) => l.liveId === info.liveId),
		async close() {
			await request(ws, { t: "close", liveId: info.liveId }).catch(() => {});
			ws.close();
		},
	};
}

const omp = (args: string[], cwd: string) =>
	Bun.spawnSync([process.env.OMP_BIN ?? "omp", ...args], {
		cwd,
		env: { ...process.env, HOME: s.home, PI_CODING_AGENT_DIR: s.agentDir },
		stdout: "pipe",
		stderr: "pipe",
	});

const skillFile = (dir: string, name: string, description: string) => {
	mkdirSync(join(dir, name), { recursive: true });
	writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nSay hi.\n`);
};

beforeAll(async () => {
	omlx = await startStubOmlx();
	s = await startTestServer();
	writeFileSync(
		join(s.agentDir, "models.yml"),
		`providers:\n  omlx:\n    baseUrl: ${omlx.url}\n    api: openai-completions\n    apiKey: ${omlx.apiKey}\n    discovery:\n      type: openai-models-list\n`,
	);
	// The user already switched something else off in the terminal: a switch of the page must leave it alone.
	appendFileSync(join(s.agentDir, "config.yml"), "disabledExtensions:\n  - rule:keep-me\n");
	skillFile(join(s.work, ".omp", "skills"), "demo-skill", "A skill of this folder");
	skillFile(join(s.work, ".omp", "skills"), "other-skill", "Another skill of this folder");
	skillFile(join(s.agentDir, "skills"), "user-skill", "A skill of the user");

	// An npm plugin (linked) and a marketplace plugin (a local marketplace), each shipping a skill.
	const npm = join(s.root, "npm-plugin");
	skillFile(join(npm, "skills"), "npm-skill", "From the npm plugin");
	writeFileSync(join(npm, "package.json"), JSON.stringify({ name: "npm-plugin", version: "1.0.0", omp: {} }));
	expect(omp(["plugin", "link", npm], s.work).exitCode).toBe(0);
	const market = join(s.root, "market");
	mkdirSync(join(market, ".claude-plugin"), { recursive: true });
	writeFileSync(
		join(market, ".claude-plugin", "marketplace.json"),
		JSON.stringify({
			name: "market",
			owner: { name: "test" },
			plugins: [{ name: "mk-plugin", source: "./plugins/mk-plugin", description: "d", version: "1.0.0" }],
		}),
	);
	const mkPlugin = join(market, "plugins", "mk-plugin");
	mkdirSync(join(mkPlugin, ".claude-plugin"), { recursive: true });
	writeFileSync(
		join(mkPlugin, ".claude-plugin", "plugin.json"),
		JSON.stringify({ name: "mk-plugin", version: "1.0.0", description: "d" }),
	);
	skillFile(join(mkPlugin, "skills"), "mk-skill", "From the marketplace plugin");
	expect(omp(["plugin", "marketplace", "add", "./market"], s.root).exitCode).toBe(0);
	const installed = omp(["plugin", "install", "mk-plugin@market", "--scope", "user"], s.root);
	if (installed.exitCode !== 0) throw new Error(`install failed: ${installed.stderr.toString()}`);
}, 120_000);

afterAll(async () => {
	await s?.stop();
	await omlx?.stop();
});

test("a skill is turned off for every conversation, and omp stops offering it; the setting's other entries stay", async () => {
	const chat = await open({ kind: "new", cwd: s.work });
	try {
		const before = skillsOf(await loaded(`live=${chat.info.liveId}`));
		expect(before.find((k) => k.name === "demo-skill")).toEqual({
			name: "demo-skill",
			description: "A skill of this folder",
			enabled: true,
		});

		const off = await send("/api/controls/skill", { live: chat.info.liveId, name: "demo-skill", enabled: false });
		expect(off.status).toBe(200);
		expect(await off.json()).toEqual({ ok: true, overridden: null });
		// The running omp rediscovers its skills when its config changes: no restart.
		await pollUntil(async () => !(await chat.commands()).includes("skill:demo-skill"), "omp to drop the skill");
		expect((await chat.commands()).includes("skill:other-skill")).toBe(true);

		const after = skillsOf(await loaded(`live=${chat.info.liveId}`));
		expect(after.find((k) => k.name === "demo-skill")).toEqual({ name: "demo-skill", description: "", enabled: false });
		expect(after.find((k) => k.name === "other-skill")?.enabled).toBe(true);
		const config = readFileSync(join(s.agentDir, "config.yml"), "utf8");
		expect(config).toContain("skill:demo-skill");
		expect(config).toContain("rule:keep-me");

		const on = await send("/api/controls/skill", { live: chat.info.liveId, name: "demo-skill", enabled: true });
		expect(on.status).toBe(200);
		await pollUntil(async () => (await chat.commands()).includes("skill:demo-skill"), "omp to offer the skill again");
		const back = skillsOf(await loaded(`live=${chat.info.liveId}`));
		expect(back.find((k) => k.name === "demo-skill")).toMatchObject({
			enabled: true,
			description: "A skill of this folder",
		});
		const restored = readFileSync(join(s.agentDir, "config.yml"), "utf8");
		expect(restored).not.toContain("skill:demo-skill");
		expect(restored).toContain("rule:keep-me");
	} finally {
		await chat.close();
	}
}, 120_000);

test("where the folder's own settings decide, the switch is saved but says it has no effect there", async () => {
	const project = join(s.root, "project");
	mkdirSync(join(project, ".omp"), { recursive: true });
	writeFileSync(join(project, ".omp", "config.yml"), "disabledExtensions:\n  - rule:project-only\n");
	const chat = await open({ kind: "new", cwd: project });
	try {
		const res = await send("/api/controls/skill", { live: chat.info.liveId, name: "user-skill", enabled: false });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, overridden: "project" });
		// The global setting changed; this folder still reads its own, so the skill is on here.
		expect(readFileSync(join(s.agentDir, "config.yml"), "utf8")).toContain("skill:user-skill");
		expect(skillsOf(await loaded(`live=${chat.info.liveId}`)).find((k) => k.name === "user-skill")?.enabled).toBe(true);
		// Turning it on again clears it, and says nothing: the project's list never held it.
		expect(
			await (await send("/api/controls/skill", { live: chat.info.liveId, name: "user-skill", enabled: true })).json(),
		).toEqual({
			ok: true,
			overridden: null,
		});
		expect(readFileSync(join(s.agentDir, "config.yml"), "utf8")).not.toContain("skill:user-skill");
	} finally {
		await chat.close();
	}
}, 120_000);

test("turning on a skill that only the folder's own settings turn off says so at once: no wait for a change that cannot happen", async () => {
	const project = join(s.root, "project-off");
	mkdirSync(join(project, ".omp"), { recursive: true });
	writeFileSync(join(project, ".omp", "config.yml"), "disabledExtensions:\n  - skill:user-skill\n");
	const chat = await open({ kind: "new", cwd: project });
	try {
		expect(readFileSync(join(s.agentDir, "config.yml"), "utf8")).not.toContain("skill:user-skill");
		const timed = async (name: string) => {
			const started = Date.now();
			const res = await send("/api/controls/skill", { live: chat.info.liveId, name, enabled: true });
			return { body: await res.json(), ms: Date.now() - started };
		};
		// The control: omp never lists a skill that does not exist, so turning one on waits for it, the whole of what
		// `skillSettled` gives (4 s). It is taken here, under the load of the moment, and what the switch below is compared
		// with: a number of seconds that is enough on an idle machine is not on a busy one.
		const waited = await timed("no-such-skill");
		expect(waited.body).toEqual({ ok: true, overridden: null });
		expect(waited.ms).toBeGreaterThanOrEqual(3500);
		const switched = await timed("user-skill");
		expect(switched.body).toEqual({ ok: true, overridden: "project" });
		// What the switch does more than the control is two more of omp's `config` commands (the write, and a read of what
		// this folder then reads), and no wait. What two such commands take is measured here too, under the same load: a
		// switch that had waited `skillSettled`'s 4 s would take about that more than the control, one that did not about 4 s
		// less than that. The bound is halfway: an omp that is slow to start (a CI runner's, over a second each) moves both.
		const before = Date.now();
		for (let i = 0; i < 2; i++) omp(["config", "get", "disabledExtensions", "--json"], project);
		const twoCommands = Date.now() - before;
		expect(switched.ms).toBeLessThan(waited.ms + twoCommands - 2000);
		// The global list never had it: nothing to change there.
		expect(readFileSync(join(s.agentDir, "config.yml"), "utf8")).not.toContain("skill:user-skill");
		expect(skillsOf(await loaded(`live=${chat.info.liveId}`)).find((k) => k.name === "user-skill")?.enabled).toBe(
			false,
		);
	} finally {
		await chat.close();
	}
}, 120_000);

test("a plugin installed in both scopes is two rows: the user's is marked shadowed, and a switch takes only its own scope", async () => {
	const folder = join(s.root, "both-scopes");
	mkdirSync(folder, { recursive: true });
	const installed = omp(["plugin", "install", "mk-plugin@market", "--scope", "project"], folder);
	if (installed.exitCode !== 0) throw new Error(`install failed: ${installed.stderr.toString()}`);
	const chat = await open({ kind: "new", cwd: folder });
	const rows = async () =>
		pluginsOf(await loaded(`live=${chat.info.liveId}`))
			.filter((p) => p.name === "mk-plugin@market")
			.map((p) => [p.scope, p.enabled, p.shadowedBy]);
	try {
		expect(await rows()).toEqual([
			["project", true, undefined],
			["user", true, "project"],
		]);
		const off = await send("/api/controls/plugin", {
			live: chat.info.liveId,
			name: "mk-plugin@market",
			enabled: false,
			scope: "project",
		});
		expect(off.status).toBe(200);
		// The user's copy was not touched, and with the folder's off it is the one omp loads: no longer shadowed.
		expect(await rows()).toEqual([
			["project", false, undefined],
			["user", true, undefined],
		]);
	} finally {
		await chat.close();
	}
}, 120_000);

test("bad skill requests: no process, no name, a name with a newline", async () => {
	expect((await send("/api/controls/skill", { live: "nope", name: "x", enabled: false })).status).toBe(404);
	const chat = await open({ kind: "new", cwd: s.work });
	try {
		expect((await send("/api/controls/skill", { live: chat.info.liveId, enabled: false })).status).toBe(400);
		expect((await send("/api/controls/skill", { live: chat.info.liveId, name: "a\nb", enabled: false })).status).toBe(
			400,
		);
		expect((await send("/api/controls/skill", { live: chat.info.liveId, name: "x" })).status).toBe(400);
	} finally {
		await chat.close();
	}
}, 120_000);

test("a plugin is switched with omp's CLI and the conversation's omp reloads it, so its skills follow at once", async () => {
	const chat = await open({ kind: "new", cwd: s.work });
	try {
		expect(await chat.commands()).toEqual(expect.arrayContaining(["skill:npm-skill", "skill:mk-skill"]));
		const before = pluginsOf(await loaded(`live=${chat.info.liveId}`));
		expect(before.find((p) => p.name === "npm-plugin")).toMatchObject({ kind: "npm", enabled: true });
		expect(before.find((p) => p.name === "mk-plugin@market")).toMatchObject({
			kind: "marketplace",
			scope: "user",
			enabled: true,
		});

		// npm plugin: off, and the skill it ships leaves the process before the reply (no waiting for a file watcher).
		const off = await send("/api/controls/plugin", {
			live: chat.info.liveId,
			name: "npm-plugin",
			enabled: false,
			scope: null,
		});
		expect(off.status).toBe(200);
		expect(await off.json()).toEqual({ ok: true, reloaded: true });
		expect(await chat.commands()).not.toContain("skill:npm-skill");
		expect(await chat.commands()).toContain("skill:mk-skill");
		const data = await loaded(`live=${chat.info.liveId}`);
		expect(pluginsOf(data).find((p) => p.name === "npm-plugin")?.enabled).toBe(false);
		expect(skillsOf(data).some((k) => k.name === "npm-skill")).toBe(false);

		// marketplace plugin, with its scope.
		const mk = await send("/api/controls/plugin", {
			live: chat.info.liveId,
			name: "mk-plugin@market",
			enabled: false,
			scope: "user",
		});
		expect(await mk.json()).toEqual({ ok: true, reloaded: true });
		expect(await chat.commands()).not.toContain("skill:mk-skill");
		expect(
			pluginsOf(await loaded(`live=${chat.info.liveId}`)).find((p) => p.name === "mk-plugin@market")?.enabled,
		).toBe(false);

		for (const [name, scope] of [
			["npm-plugin", null],
			["mk-plugin@market", "user"],
		] as const) {
			const on = await send("/api/controls/plugin", { live: chat.info.liveId, name, enabled: true, scope });
			expect(on.status).toBe(200);
		}
		expect(await chat.commands()).toEqual(expect.arrayContaining(["skill:npm-skill", "skill:mk-skill"]));
		expect(pluginsOf(await loaded(`live=${chat.info.liveId}`)).every((p) => p.enabled)).toBe(true);
	} finally {
		await chat.close();
	}
}, 120_000);

test("a saved conversation without a process can switch a plugin (omp's CLI only: nothing is reloaded)", async () => {
	const file = encodeURIComponent(s.fixtures.alpha);
	const off = await send("/api/controls/plugin", {
		file: s.fixtures.alpha,
		name: "npm-plugin",
		enabled: false,
		scope: null,
	});
	expect(off.status).toBe(200);
	expect(await off.json()).toEqual({ ok: true, reloaded: false });
	expect(pluginsOf(await loaded(`file=${file}`)).find((p) => p.name === "npm-plugin")?.enabled).toBe(false);
	await send("/api/controls/plugin", { file: s.fixtures.alpha, name: "npm-plugin", enabled: true, scope: null });
	expect(pluginsOf(await loaded(`file=${file}`)).find((p) => p.name === "npm-plugin")?.enabled).toBe(true);
});

test("a paused conversation takes a plugin switch, reloads, and stays paused", async () => {
	const chat = await open({ kind: "new", cwd: s.work });
	try {
		await chat.pause();
		const pausedAt = (await chat.listing())?.pausedAt;
		expect(pausedAt).toBeTruthy();
		const res = await send("/api/controls/plugin", {
			live: chat.info.liveId,
			name: "npm-plugin",
			enabled: false,
			scope: null,
		});
		expect(await res.json()).toEqual({ ok: true, reloaded: true });
		expect((await chat.listing())?.pausedAt).toBe(pausedAt as number);
		await chat.resume();
		expect(await chat.commands()).not.toContain("skill:npm-skill");
	} finally {
		await send("/api/controls/plugin", { file: s.fixtures.alpha, name: "npm-plugin", enabled: true, scope: null });
		await chat.close();
	}
}, 120_000);

test("omp's own message comes back for a plugin it does not know; names that could be flags are refused", async () => {
	const chat = await open({ kind: "new", cwd: s.work });
	try {
		const unknown = await send("/api/controls/plugin", {
			live: chat.info.liveId,
			name: "no-such-plugin",
			enabled: false,
			scope: null,
		});
		expect(unknown.status).toBe(500);
		expect(((await unknown.json()) as { error: string }).error).toContain("no-such-plugin");
		for (const name of ["--force", "-x", "a b", ""]) {
			expect(
				(await send("/api/controls/plugin", { live: chat.info.liveId, name, enabled: false, scope: null })).status,
			).toBe(400);
		}
		expect(
			(
				await send("/api/controls/plugin", {
					live: chat.info.liveId,
					name: "npm-plugin",
					enabled: false,
					scope: "weird",
				})
			).status,
		).toBe(400);
		expect(pluginsOf(await loaded(`live=${chat.info.liveId}`)).every((p) => p.enabled)).toBe(true);
	} finally {
		await chat.close();
	}
}, 120_000);

test("a Light conversation loads no plugins: its switch is refused", async () => {
	expect((await send("/api/mode", { mode: "light", lightModels: "local", offline: { mcp: [] } })).status).toBe(200);
	const chat = await open({ kind: "new", cwd: s.work });
	try {
		expect(chat.info.mode).toBe("light");
		const res = await send("/api/controls/plugin", {
			live: chat.info.liveId,
			name: "npm-plugin",
			enabled: false,
			scope: null,
		});
		expect(res.status).toBe(409);
		expect(pluginsOf(await loaded(`live=${chat.info.liveId}`)).find((p) => p.name === "npm-plugin")?.enabled).toBe(
			true,
		);
	} finally {
		await chat.close();
		await send("/api/mode", { mode: "full" });
	}
}, 120_000);
