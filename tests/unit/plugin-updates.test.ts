import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { checkUpdates, newer, updateStep } from "../../server/omp/plugin-updates.ts";
import type { PluginUpdate, UpdatesState } from "../../shared/plugins.ts";
import { writeFakePluginsOmp } from "../support/plugins-stubs.ts";

/**
 * What the Plugins page's Updates section and the automatic update find newer and run (`server/omp/plugin-updates.ts`),
 * and when the automatic update installs (`autoUpdates` in `server/omp/plugins.ts`): only once no conversation is busy.
 */

const HOME = "/home/someone";
const PROJECT = "/work/project";

const skillList = (skills: { id: string; version: string; level: "user" | "project"; root: string }[]) =>
	JSON.stringify({
		skills: skills.map((s) => {
			const [scope, name] = s.id.slice(1).split("/");
			return {
				name,
				filePath: join(s.root, ".omp", "skillshare", `@${scope}`, name, s.version, "SKILL.md"),
				source: `skillshare:${s.level}`,
			};
		}),
	});

describe("checkUpdates", () => {
	test("each place's own plugins and registry skills; one that cannot be read is an error, the rest still count", async () => {
		const asked: string[] = [];
		const found = await checkUpdates({
			home: HOME,
			folders: [PROJECT, "/work/broken", HOME],
			npmLatest: async () => null,
			run: async (args, cwd) => {
				asked.push(`${cwd}: ${args.join(" ")}`);
				if (cwd === "/work/broken") throw new Error("Folder no longer exists\nmore");
				if (args[1] === "upgrade")
					// Every folder lists the user's plugins too: they count once, from the home folder.
					return [
						"[dry-run] Would upgrade hello@market (user): 1.0.0 -> 1.1.0",
						cwd === PROJECT ? "[dry-run] Would upgrade local@market (project): undefined -> 2.0.0" : "",
					].join("\n");
				if (args[0] === "plugin" && args[1] === "list") return JSON.stringify({ npm: [], marketplace: [] });
				if (args[1] === "list")
					return cwd === HOME
						? skillList([{ id: "@acme/pdf-tools", version: "1.1.0", level: "user", root: HOME }])
						: skillList([
								{ id: "@acme/pdf-tools", version: "1.1.0", level: "user", root: HOME },
								{ id: "@acme/shell-helpers", version: "0.3.1", level: "project", root: PROJECT },
							]);
				if (args[1] === "info")
					return JSON.stringify({ distTags: { latest: args[2] === "@acme/pdf-tools" ? "1.2.0" : "0.3.1" } });
				throw new Error(`unexpected ${args.join(" ")}`);
			},
		});
		expect(found.updates.map(({ key: _, ...u }) => u)).toEqual([
			{
				kind: "plugin",
				id: "hello@market",
				source: "marketplace",
				scope: "user",
				folder: null,
				from: "1.0.0",
				to: "1.1.0",
			},
			{
				kind: "plugin",
				id: "local@market",
				source: "marketplace",
				scope: "project",
				folder: PROJECT,
				from: null,
				to: "2.0.0",
			},
			{
				kind: "skill",
				id: "@acme/pdf-tools",
				source: "registry",
				scope: "user",
				folder: null,
				from: "1.1.0",
				to: "1.2.0",
			},
		]);
		expect(found.errors).toEqual([
			"plugins (/work/broken): Folder no longer exists",
			"skills (/work/broken): Folder no longer exists",
		]);
		// The home folder named as a project is the user's place, looked in once (as a full path: a drive on Windows).
		expect(asked.filter((a) => a.startsWith(`${resolve(HOME)}: plugin upgrade`))).toHaveLength(1);
	});

	test("an npm plugin is checked against the registry unless it came from git, a URL or a folder", async () => {
		const home = mkdtempSync(join(tmpdir(), "ompw-updates-"));
		try {
			const modules = join(home, ".omp", "plugins", "node_modules");
			for (const name of ["from-npm", "from-git", "linked"]) mkdirSync(join(modules, name), { recursive: true });
			rmSync(join(modules, "linked"), { recursive: true });
			symlinkSync(join(home, "src"), join(modules, "linked"));
			writeFileSync(
				join(home, ".omp", "plugins", "package.json"),
				JSON.stringify({
					dependencies: { "from-npm": "^1.0.0", "from-git": "github:someone/from-git", linked: "file:../src" },
				}),
			);
			const npm = ["from-npm", "from-git", "linked"].map((name) => ({
				name,
				version: "1.0.0",
				path: join(modules, name),
			}));
			const found = await checkUpdates({
				home,
				folders: [],
				npmLatest: async (name) => (name === "from-npm" ? "1.4.0" : "9.9.9"),
				run: async (args) => {
					if (args[0] === "plugin" && args[1] === "list") return JSON.stringify({ npm, marketplace: [] });
					if (args[1] === "list") return JSON.stringify({ skills: [] });
					return "";
				},
			});
			expect(found.updates.map((u) => [u.id, u.source, u.from, u.to])).toEqual([["from-npm", "npm", "1.0.0", "1.4.0"]]);
			expect(found.unchecked.map((u) => [u.id, u.reason])).toEqual([["from-git", "git"]]);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});

	test("a version is newer only by semver; one that is not a version never is", () => {
		expect(newer("1.10.0", "1.9.0")).toBe(true);
		expect(newer("1.0.0", "1.0.0")).toBe(false);
		expect(newer("1.0.0-beta.1", "1.0.0")).toBe(false);
		expect(newer("1.0.0", null)).toBe(true);
		expect(newer("latest", "1.0.0")).toBe(false);
	});

	test("each update is the command that brings in exactly it, in its own folder", () => {
		const u = (over: Partial<PluginUpdate>): PluginUpdate => ({
			key: "k",
			kind: "plugin",
			id: "hello@market",
			source: "marketplace",
			scope: "user",
			folder: null,
			from: "1.0.0",
			to: "1.1.0",
			...over,
		});
		expect(updateStep(u({}), HOME)).toEqual({
			args: ["plugin", "upgrade", "hello@market", "--scope", "user"],
			cwd: HOME,
		});
		expect(updateStep(u({ scope: "project", folder: PROJECT }), HOME)).toEqual({
			args: ["plugin", "upgrade", "hello@market", "--scope", "project"],
			cwd: PROJECT,
		});
		expect(updateStep(u({ id: "from-npm", source: "npm" }), HOME)).toEqual({
			args: ["plugin", "upgrade", "from-npm"],
			cwd: HOME,
		});
		expect(updateStep(u({ kind: "skill", id: "@acme/pdf-tools", source: "registry" }), HOME)).toEqual({
			args: ["skill", "update", "@acme/pdf-tools", "-g"],
			cwd: HOME,
		});
		expect(
			updateStep(
				u({ kind: "skill", id: "@acme/pdf-tools", source: "registry", scope: "project", folder: PROJECT }),
				HOME,
			),
		).toEqual({ args: ["skill", "update", "@acme/pdf-tools"], cwd: PROJECT });
	});
});

describe("the automatic update", () => {
	// The fake omp keeps what it holds in `~/.fake-plugins-omp.json`: HOME is this test's own folder while it runs.
	// Its real path: the fake omp compares a project with the folder it runs in (macOS's temp folder is a link).
	const root = realpathSync(mkdtempSync(join(tmpdir(), "ompw-autoupdate-")));
	const home = join(root, "home");
	const project = join(root, "project");
	const realHome = process.env.HOME;
	const realProfile = process.env.USERPROFILE;
	let held = { working: 1, asking: 0, paused: 0, waiting: 0 };
	let on = true;
	let plugins: typeof import("../../server/omp/plugins.ts");
	let deps: import("../../server/omp/plugins.ts").PluginsDeps;
	const state = () => JSON.parse(readFileSync(join(home, ".fake-plugins-omp.json"), "utf8"));

	beforeAll(async () => {
		mkdirSync(home, { recursive: true });
		mkdirSync(project, { recursive: true });
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		process.env.OMPW_EXTENSIONS_FIRST_CHECK_MS = "50";
		process.env.OMPW_EXTENSIONS_RETRY_MS = "50";
		writeFileSync(
			join(home, ".fake-plugins-omp.json"),
			JSON.stringify({
				marketplaces: [{ name: "market", source: "someone/market" }],
				skills: [
					{ id: "@acme/pdf-tools", version: "1.1.0", global: true },
					{ id: "@acme/pdf-tools", version: "1.0.0", global: false, folder: project },
				],
				plugins: [{ id: "hello@market", scope: "user", version: "1.0.0", latest: "1.1.0" }],
			}),
		);
		plugins = await import("../../server/omp/plugins.ts");
		deps = {
			bin: writeFakePluginsOmp(root),
			home,
			agentDir: join(home, ".omp", "agent"),
			neutral: root,
			pool: { list: () => [], get: () => undefined } as unknown as import("../../server/live.ts").LivePool,
			held: () => null,
			updates: {
				autoOn: () => on,
				conversations: () => held,
				folders: async () => [project],
				npmLatest: async () => null,
			},
		};
	});

	afterAll(() => {
		on = false;
		plugins?.autoUpdates(deps);
		process.env.HOME = realHome;
		if (realProfile === undefined) delete process.env.USERPROFILE;
		else process.env.USERPROFILE = realProfile;
		rmSync(root, { recursive: true, force: true });
	});

	const updates = async (): Promise<UpdatesState> =>
		(
			await plugins.handlePlugins(
				new Request("http://x/api/plugins/updates"),
				new URL("http://x/api/plugins/updates"),
				deps,
			)
		).json();
	const until = async (what: () => Promise<boolean>, ms = 15_000) => {
		const end = Date.now() + ms;
		while (!(await what())) {
			if (Date.now() > end) throw new Error("timed out");
			await Bun.sleep(25);
		}
	};

	test("it checks, waits while a conversation works, then installs everything newer and lists nothing left", async () => {
		plugins.autoUpdates(deps);
		await until(async () => (await updates()).checkedAt !== null);
		const first = await updates();
		expect(first.updates.map((u) => `${u.id} ${u.scope} ${u.from} -> ${u.to}`).sort()).toEqual([
			"@acme/pdf-tools project 1.0.0 -> 1.2.0",
			"@acme/pdf-tools user 1.1.0 -> 1.2.0",
			"hello@market user 1.0.0 -> 1.1.0",
		]);
		// A conversation works: nothing is installed, and the state says what it waits for.
		await Bun.sleep(200);
		expect((await updates()).auto.waitingFor).toEqual(held);
		expect(state().plugins[0].version).toBe("1.0.0");

		held = { working: 0, asking: 0, paused: 0, waiting: 0 };
		await until(async () => (await updates()).auto.last !== null);
		await until(async () => (await updates()).updates.length === 0);
		const after = await updates();
		expect(after.auto.last).toMatchObject({ count: 3, error: null });
		expect(after.auto.waitingFor).toBeNull();
		expect(state().plugins[0].version).toBe("1.1.0");
		expect(state().skills.map((s: { version: string }) => s.version)).toEqual(["1.2.0", "1.2.0"]);
	});
});
