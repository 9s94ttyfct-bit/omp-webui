// needs: isolatedHome
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { InstalledPlugin, PluginJob, PluginReload, PluginSetting, PluginsData } from "../../shared/plugins.ts";
import type { LiveInfo } from "../../shared/protocol.ts";
import { pollUntil } from "../support/poll.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { connect, request } from "../support/ws.ts";

/**
 * The Plugins page's API against the real server and the real omp, in the test's own HOME (omp keeps its plugins under
 * `~/.omp/plugins` there), no network and no model call: a local marketplace and a local plugin folder are installed,
 * switched, configured, upgraded and removed with `omp plugin`, and an open conversation reloads its plugins after each.
 */

let s: TestServer;
let market: string;
let localPlugin: string;

const headers = (s: TestServer) => ({ "x-omp-webui-token": s.accessToken, "x-omp-webui": "1" });
const get = async <T>(path: string): Promise<{ status: number; body: T }> => {
	const res = await fetch(`${s.url}${path}`, { headers: headers(s) });
	return { status: res.status, body: (await res.json()) as T };
};
const post = async <T>(path: string, body: unknown): Promise<{ status: number; body: T }> => {
	const res = await fetch(`${s.url}${path}`, {
		method: "POST",
		headers: { ...headers(s), "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: res.status, body: (await res.json()) as T };
};
const list = async (cwd?: string): Promise<PluginsData> => {
	const res = await get<PluginsData>(`/api/plugins${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`);
	expect(res.status).toBe(200);
	return res.body;
};
const installed = (d: PluginsData): InstalledPlugin[] => {
	if (!Array.isArray(d.installed)) throw new Error(`installed: ${d.installed.error}`);
	return d.installed;
};

/** Start a job and wait for it to end; its record at the end. */
async function job(body: Record<string, unknown>): Promise<PluginJob> {
	const started = await post<{ job: PluginJob; error?: string }>("/api/plugins/jobs", body);
	if (started.status !== 202) throw new Error(`job refused (${started.status}): ${started.body.error}`);
	let last = started.body.job;
	await pollUntil(
		async () => {
			last = (await get<{ job: PluginJob }>(`/api/plugins/jobs/${last.id}`)).body.job;
			return last.state !== "running";
		},
		`omp ${last.command} to finish`,
		60_000,
	);
	return last;
}

function writePlugin(dir: string, name: string, version: string) {
	mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
	writeFileSync(join(dir, ".claude-plugin", "plugin.json"), JSON.stringify({ name, version, description: "Says hi" }));
	mkdirSync(join(dir, "commands"), { recursive: true });
	writeFileSync(join(dir, "commands", "hi.md"), "---\ndescription: say hi\n---\nSay hi.\n");
}

function writeCatalog(version: string) {
	writeFileSync(
		join(market, ".claude-plugin", "marketplace.json"),
		JSON.stringify({
			name: "testmarket",
			owner: { name: "test" },
			plugins: [{ name: "greeter", version, description: "Says hi", source: "./plugins/greeter" }],
		}),
	);
	writePlugin(join(market, "plugins", "greeter"), "greeter", version);
}

beforeAll(async () => {
	s = await startTestServer(0, {}, { login: false });
	market = join(s.root, "market");
	mkdirSync(join(market, ".claude-plugin"), { recursive: true });
	writeCatalog("1.0.0");
	localPlugin = join(s.root, "local-plugin");
	mkdirSync(localPlugin, { recursive: true });
	writeFileSync(
		join(localPlugin, "package.json"),
		JSON.stringify({
			name: "local-plugin",
			version: "0.1.0",
			description: "A local plugin",
			omp: {
				features: { extra: { description: "Extra", default: false }, basic: { default: true } },
				settings: { greeting: { type: "string", default: "hi" }, token: { type: "string", secret: true } },
			},
		}),
	);
}, 120_000);

afterAll(async () => {
	await s?.stop();
});

test("arguments that look like flags never reach omp", async () => {
	const refused: [string, Record<string, unknown>][] = [
		["/api/plugins/jobs", { action: "install", spec: "--force" }],
		["/api/plugins/jobs", { action: "install", spec: "x", scope: "--json" }],
		["/api/plugins/jobs", { action: "uninstall", id: "-l" }],
		["/api/plugins/jobs", { action: "marketplace-add", source: "--help" }],
		["/api/plugins/jobs", { action: "marketplace-remove", name: "-x" }],
		["/api/plugins/jobs", { action: "rm -rf" }],
		// A project install needs a project folder: the home folder's `.omp` is the user's own.
		["/api/plugins/jobs", { action: "install", spec: "greeter@testmarket", scope: "project" }],
		["/api/plugins/enable", { id: "--all", enabled: false }],
		["/api/plugins/features", { name: "local-plugin", features: ["a,b"] }],
		["/api/plugins/config", { name: "local-plugin", key: "--set", value: "x" }],
		["/api/plugins/config", { name: "local-plugin", key: "greeting", value: "--json" }],
	];
	for (const [path, body] of refused) {
		const res = await post<{ error: string }>(path, body);
		expect({ path, body, status: res.status }).toEqual({ path, body, status: 400 });
	}
	expect((await get("/api/plugins?cwd=relative/path")).status).toBe(400);
	expect((await get(`/api/plugins?cwd=${encodeURIComponent(join(s.root, "no-such-folder"))}`)).status).toBe(409);
	// Nothing was installed by any of it.
	expect(installed(await list())).toEqual([]);
});

test("a local marketplace: added, its catalog listed, a plugin installed, switched, upgraded and removed; an open conversation reloads", async () => {
	const ws = await connect(s);
	const chat = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: s.work } });
	const reloadedHere = (reloads: PluginReload[]) => reloads.find((r) => r.liveId === chat.liveId)?.state;
	try {
		const empty = await list();
		expect(empty.marketplaces).toEqual([]);
		expect(empty.catalog).toEqual([]);
		expect(empty.home).toBe(true);

		const added = await job({ action: "marketplace-add", source: market });
		expect(added.state).toBe("done");
		expect(added.reloads).toEqual([]);
		const withMarket = await list();
		expect(withMarket.marketplaces).toEqual([{ name: "testmarket", source: market }]);
		expect(withMarket.catalog).toEqual([
			{ name: "greeter", version: "1.0.0", description: "Says hi", marketplace: "testmarket", installed: [] },
		]);

		const install = await job({ action: "install", spec: "greeter@testmarket", scope: "user" });
		expect(install.state).toBe("done");
		expect(install.output).toContain("Installed greeter");
		expect(reloadedHere(install.reloads)).toBe("reloaded");
		const after = await list();
		expect(installed(after)).toMatchObject([
			{
				id: "greeter@testmarket",
				name: "greeter",
				source: "marketplace",
				marketplace: "testmarket",
				scope: "user",
				version: "1.0.0",
				description: "Says hi",
				enabled: true,
				upgrade: null,
			},
		]);
		expect(Array.isArray(after.catalog) && after.catalog[0].installed).toEqual(["user"]);
		// The open conversation now offers the plugin's command.
		const commands = async () =>
			(
				await request<{ commands: { name: string }[] }>(ws, {
					t: "rpc",
					liveId: chat.liveId,
					command: { type: "get_available_commands" },
				})
			).commands.map((c) => c.name);
		await pollUntil(async () => (await commands()).some((c) => c.includes("hi")), "the plugin's command");

		const off = await post<{ reloads: PluginReload[] }>("/api/plugins/enable", {
			id: "greeter@testmarket",
			scope: "user",
			enabled: false,
		});
		expect(off.status).toBe(200);
		expect(reloadedHere(off.body.reloads)).toBe("reloaded");
		expect(installed(await list())[0].enabled).toBe(false);
		expect((await post("/api/plugins/enable", { id: "greeter@testmarket", scope: "user", enabled: true })).status).toBe(
			200,
		);
		expect(installed(await list())[0].enabled).toBe(true);

		// A newer version in the catalog: listed once the marketplace is updated, then upgraded.
		writeCatalog("1.1.0");
		expect((await job({ action: "marketplace-update", name: "testmarket" })).state).toBe("done");
		expect(installed(await list())[0].upgrade).toEqual({ from: "1.0.0", to: "1.1.0" });
		const upgraded = await job({ action: "upgrade", id: "greeter@testmarket", scope: "user" });
		expect(upgraded.state).toBe("done");
		const now = installed(await list())[0];
		expect(now.version).toBe("1.1.0");
		expect(now.upgrade).toBeNull();

		// omp's own words when it refuses.
		const missing = await job({ action: "install", spec: "nope@testmarket" });
		expect(missing.state).toBe("failed");
		expect(missing.error).toContain('Plugin "nope" not found in marketplace "testmarket"');

		const removed = await job({ action: "uninstall", id: "greeter@testmarket", scope: "user" });
		expect(removed.state).toBe("done");
		expect(reloadedHere(removed.reloads)).toBe("reloaded");
		expect(installed(await list())).toEqual([]);

		expect((await job({ action: "marketplace-remove", name: "testmarket" })).state).toBe("done");
		expect((await list()).marketplaces).toEqual([]);
	} finally {
		await request(ws, { t: "close", liveId: chat.liveId }).catch(() => {});
		ws.close();
	}
}, 240_000);

test("a local plugin folder: installed by path, its features and settings changed, a secret never sent back", async () => {
	const install = await job({ action: "install", spec: localPlugin });
	expect(install.state).toBe("done");
	expect(existsSync(join(s.home, ".omp", "plugins", "node_modules", "local-plugin"))).toBe(true);
	const plugin = installed(await list()).find((p) => p.id === "local-plugin");
	expect(plugin).toMatchObject({ source: "linked", scope: "user", version: "0.1.0", enabled: true, hasSettings: true });
	expect(plugin?.features.map((f) => [f.name, f.enabled])).toEqual([
		["extra", false],
		["basic", true],
	]);

	expect((await post("/api/plugins/features", { name: "local-plugin", features: ["extra"] })).status).toBe(200);
	const chosen = installed(await list()).find((p) => p.id === "local-plugin");
	expect(chosen?.features.map((f) => [f.name, f.enabled])).toEqual([
		["extra", true],
		["basic", false],
	]);
	expect((await post("/api/plugins/features", { name: "local-plugin", features: [] })).status).toBe(200);
	expect(
		installed(await list())
			.find((p) => p.id === "local-plugin")
			?.features.every((f) => !f.enabled),
	).toBe(true);
	const unknown = await post<{ error: string }>("/api/plugins/features", { name: "local-plugin", features: ["nope"] });
	expect(unknown.status).toBe(400);

	const set = await post<{ settings: PluginSetting[] }>("/api/plugins/config", {
		name: "local-plugin",
		key: "greeting",
		value: "hello there",
	});
	expect(set.status).toBe(200);
	expect(set.body.settings.find((x) => x.key === "greeting")).toMatchObject({ set: true, value: "hello there" });
	const secret = await post<{ settings: PluginSetting[] }>("/api/plugins/config", {
		name: "local-plugin",
		key: "token",
		value: "s3cret-value",
	});
	expect(secret.status).toBe(200);
	const read = await get<{ settings: PluginSetting[] }>("/api/plugins/config?name=local-plugin");
	expect(read.body.settings.find((x) => x.key === "token")).toMatchObject({ secret: true, set: true, value: null });
	expect(JSON.stringify(read.body)).not.toContain("s3cret-value");
	const reset = await post<{ settings: PluginSetting[] }>("/api/plugins/config", {
		name: "local-plugin",
		key: "greeting",
		value: null,
	});
	expect(reset.body.settings.find((x) => x.key === "greeting")).toMatchObject({ set: false, value: "hi" });

	const doctor = await get<{ checks: { name: string; status: string }[] }>("/api/plugins/doctor");
	expect(doctor.status).toBe(200);
	expect(doctor.body.checks.some((c) => c.name === "plugin:local-plugin")).toBe(true);

	expect((await job({ action: "uninstall", id: "local-plugin" })).state).toBe("done");
	expect(installed(await list()).some((p) => p.id === "local-plugin")).toBe(false);
	// The folder it was linked from is the person's: it stays.
	expect(existsSync(join(localPlugin, "package.json"))).toBe(true);
}, 240_000);
