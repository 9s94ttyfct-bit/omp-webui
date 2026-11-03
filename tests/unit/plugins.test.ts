import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	configValueProblem,
	featureArgs,
	featuresOf,
	PluginsError,
	parseConfig,
	parseDiscover,
	parseDoctor,
	parseInstalled,
	parseMarketplaceList,
	parseUpgradePreview,
	planJob,
	pluginSpec,
	splitMarketplaceId,
	validConfigKey,
	validFeature,
	validMarketplace,
} from "../../server/omp/plugins.ts";
import { validPlugin } from "../../server/omp/toggles.ts";

/**
 * The Plugins page's server side (`server/omp/plugins.ts`): every argument that reaches omp's command line is checked (a
 * flag never passes as a name, a spec or a value), and what omp prints is read as it prints it (omp 18.16's text and
 * JSON, copied from runs in an isolated agent directory).
 */

const HOME = "/home/someone";
const PROJECT = "/work/project";

describe("arguments", () => {
	test("a spec is one line and never a flag; ~/ is the home folder", () => {
		expect(pluginSpec("@scope/plugin@1.2.3", HOME)).toBe("@scope/plugin@1.2.3");
		expect(pluginSpec("  github:user/repo#v1 ", HOME)).toBe("github:user/repo#v1");
		expect(pluginSpec("name[feat1,feat2]", HOME)).toBe("name[feat1,feat2]");
		expect(pluginSpec("~/plugins/mine", HOME)).toBe(join(HOME, "plugins", "mine"));
		expect(pluginSpec("~", HOME)).toBe(HOME);
		for (const bad of [
			"--force",
			"-l",
			" --scope=project",
			"",
			"   ",
			"a\nb",
			"x\u0000",
			3,
			null,
			undefined,
			"x".repeat(1001),
		])
			expect(pluginSpec(bad, HOME)).toBeNull();
	});

	test("a plugin's name, a marketplace's, a feature's and a setting's key are never flags", () => {
		for (const ok of ["hello", "hello@market", "@scope/name", "@scope/name@market", "a.b-c_d"])
			expect(validPlugin(ok)).toBe(true);
		for (const bad of ["-x", "--json", "", "a b", "a;b", "a\nb", 1]) expect(validPlugin(bad)).toBe(false);
		expect(validMarketplace("claude-plugins-official")).toBe(true);
		for (const bad of ["-m", "a/b", "a b", ""]) expect(validMarketplace(bad)).toBe(false);
		expect(validFeature("extra")).toBe(true);
		for (const bad of ["a,b", "-x", "", "a b"]) expect(validFeature(bad)).toBe(false);
		expect(validConfigKey("api.token")).toBe(true);
		for (const bad of ["-k", "", "a b"]) expect(validConfigKey(bad)).toBe(false);
	});

	test("a setting's value that omp's CLI would drop as a flag is refused, not set to something else", () => {
		expect(configValueProblem("hello there")).toBeNull();
		expect(configValueProblem("")).toBeNull();
		expect(configValueProblem("a-b")).toBeNull();
		expect(configValueProblem("-1")).not.toBeNull();
		expect(configValueProblem("  --flag")).not.toBeNull();
		expect(configValueProblem("a\nb")).not.toBeNull();
		expect(configValueProblem(5)).not.toBeNull();
	});

	test("each job runs exactly the command it names, its arguments checked", () => {
		expect(planJob("install", { spec: "hello@market", scope: "project" }, PROJECT, HOME).args).toEqual([
			"plugin",
			"install",
			"hello@market",
			"--scope",
			"project",
		]);
		expect(planJob("install", { spec: "~/p", force: true }, HOME, HOME).args).toEqual([
			"plugin",
			"install",
			join(HOME, "p"),
			"--force",
		]);
		expect(planJob("uninstall", { id: "hello@market", scope: "user" }, HOME, HOME).args).toEqual([
			"plugin",
			"uninstall",
			"hello@market",
			"--scope",
			"user",
		]);
		expect(planJob("upgrade", {}, HOME, HOME).args).toEqual(["plugin", "upgrade"]);
		expect(planJob("upgrade", { id: "pkg" }, HOME, HOME).args).toEqual(["plugin", "upgrade", "pkg"]);
		expect(planJob("doctor-fix", {}, HOME, HOME).args).toEqual(["plugin", "doctor", "--fix"]);
		expect(planJob("marketplace-add", { source: "owner/repo" }, HOME, HOME).args).toEqual([
			"plugin",
			"marketplace",
			"add",
			"owner/repo",
		]);
		expect(planJob("marketplace-update", {}, HOME, HOME).args).toEqual(["plugin", "marketplace", "update"]);
		expect(planJob("marketplace-remove", { name: "m" }, HOME, HOME).args).toEqual([
			"plugin",
			"marketplace",
			"remove",
			"m",
		]);
		// A marketplace's catalog is not something a conversation loads.
		expect(planJob("marketplace-add", { source: "o/r" }, HOME, HOME).reload).toBe(false);
		expect(planJob("install", { spec: "x" }, HOME, HOME).reload).toBe(true);
	});

	test("a flag smuggled into a job is refused before omp is run", () => {
		const refused = (action: Parameters<typeof planJob>[0], body: Record<string, unknown>, cwd = HOME) => {
			try {
				planJob(action, body, cwd, HOME);
			} catch (e) {
				return e instanceof PluginsError && e.status === 400;
			}
			return false;
		};
		expect(refused("install", { spec: "--force" })).toBe(true);
		expect(refused("install", { spec: "x", scope: "--json" })).toBe(true);
		expect(refused("install", { spec: "x", scope: "global" })).toBe(true);
		expect(refused("uninstall", { id: "-l" })).toBe(true);
		expect(refused("upgrade", { id: "--dry-run" })).toBe(true);
		expect(refused("marketplace-add", { source: "-x" })).toBe(true);
		expect(refused("marketplace-remove", { name: "--all" })).toBe(true);
		expect(refused("marketplace-update", { name: "a b" })).toBe(true);
		// The home folder's `.omp` is the user's: a project install needs a project folder.
		expect(refused("install", { spec: "x@m", scope: "project" })).toBe(true);
		expect(refused("install", { spec: "x@m", scope: "project" }, PROJECT)).toBe(false);
	});

	test("features: the list omp keeps on, and all of them off when none is wanted", () => {
		expect(featureArgs("p", ["a", "b"], ["a", "b", "c"])).toEqual(["plugin", "features", "p", "--set", "a,b"]);
		expect(featureArgs("p", [], ["a", "b"])).toEqual(["plugin", "features", "p", "--disable", "a,b"]);
	});
});

describe("what omp prints", () => {
	test("marketplace list", () => {
		const text = "Configured Marketplaces:\n\n  localmk  /tmp/x/mk\n  official  https://github.com/o/r.git\n";
		expect(parseMarketplaceList(text)).toEqual([
			{ name: "localmk", source: "/tmp/x/mk" },
			{ name: "official", source: "https://github.com/o/r.git" },
		]);
		expect(
			parseMarketplaceList("No marketplaces configured\n\nAdd one with: omp plugin marketplace add <source>\n"),
		).toEqual([]);
	});

	test("discover: name@version, a scoped name, no version, and the description under it", () => {
		const text = [
			"Available Plugins (localmk):",
			"",
			"  hello@1.0.0",
			"    Says hello",
			"  @scope/tool@2.1.0",
			"    A tool",
			"  bare",
			"  other@0.2.0",
			"    Another one",
			"",
		].join("\n");
		expect(parseDiscover(text, "localmk")).toEqual([
			{ name: "hello", version: "1.0.0", description: "Says hello", marketplace: "localmk" },
			{ name: "@scope/tool", version: "2.1.0", description: "A tool", marketplace: "localmk" },
			{ name: "bare", version: null, description: null, marketplace: "localmk" },
			{ name: "other", version: "0.2.0", description: "Another one", marketplace: "localmk" },
		]);
		expect(parseDiscover("No plugins found in localmk\n", "localmk")).toEqual([]);
	});

	test("upgrade --dry-run", () => {
		const text = [
			"[dry-run] Would upgrade hello@localmk (user): 1.0.0 -> 1.1.0",
			"[dry-run] Would upgrade other@localmk (project): 1.0.0 -> 1.1.0",
		].join("\n");
		expect(parseUpgradePreview(text)).toEqual([
			{ id: "hello@localmk", scope: "user", from: "1.0.0", to: "1.1.0" },
			{ id: "other@localmk", scope: "project", from: "1.0.0", to: "1.1.0" },
		]);
		expect(parseUpgradePreview("[dry-run] All marketplace plugins are up to date")).toEqual([]);
		// omp 18.12 prints the line without the prefix, indented.
		expect(parseUpgradePreview("  greeter@testmarket (user): 1.0.0 -> 1.1.0\n")).toEqual([
			{ id: "greeter@testmarket", scope: "user", from: "1.0.0", to: "1.1.0" },
		]);
	});

	test("list --json: npm, a linked folder and marketplace plugins, with their upgrade and switch", () => {
		const doc = {
			npm: [
				{
					name: "omp-test-local",
					version: "0.1.0",
					path: "/x/node_modules/omp-test-local",
					manifest: {
						description: "From the manifest",
						features: { extra: { description: "Extra bits", default: false }, basic: { default: true } },
						settings: { greeting: { type: "string" } },
					},
					enabledFeatures: null,
					enabled: true,
				},
				{
					name: "off",
					version: "1.0.0",
					path: "/x/node_modules/off",
					manifest: {},
					enabledFeatures: ["a"],
					enabled: false,
				},
			],
			marketplace: [
				{
					id: "hello@localmk",
					scope: "user",
					shadowedBy: "project",
					entries: [{ scope: "user", installPath: "/cache/hello", version: "1.0.0", enabled: false }],
				},
				{
					id: "other@localmk",
					scope: "project",
					entries: [{ scope: "project", installPath: "/cache/other", version: "1.0.0" }],
				},
			],
		};
		const plugins = parseInstalled(
			doc,
			[{ id: "other@localmk", scope: "project", from: "1.0.0", to: "1.1.0" }],
			(id) => (id === "hello@localmk" ? "Says hello" : null),
			(path) => path === "/x/node_modules/omp-test-local",
		);
		expect(plugins.map((p) => [p.id, p.source, p.scope, p.enabled, p.upgrade?.to ?? null])).toEqual([
			["omp-test-local", "linked", "user", true, null],
			["off", "npm", "user", false, null],
			["hello@localmk", "marketplace", "user", false, null],
			["other@localmk", "marketplace", "project", true, "1.1.0"],
		]);
		expect(plugins[0].description).toBe("From the manifest");
		expect(plugins[0].features).toEqual([
			{ name: "extra", description: "Extra bits", default: false, enabled: false },
			{ name: "basic", description: null, default: true, enabled: true },
		]);
		expect(plugins[0].hasSettings).toBe(true);
		expect(plugins[2]).toMatchObject({
			name: "hello",
			marketplace: "localmk",
			description: "Says hello",
			shadowedBy: "project",
		});
		expect(() => parseInstalled("nope")).toThrow();
	});

	test("features: the chosen ones, else the defaults", () => {
		const manifest = { features: { a: { default: true }, b: {} } };
		expect(featuresOf(manifest, null).map((f) => f.enabled)).toEqual([true, false]);
		expect(featuresOf(manifest, ["b"]).map((f) => f.enabled)).toEqual([false, true]);
		expect(featuresOf(manifest, []).map((f) => f.enabled)).toEqual([false, false]);
		expect(featuresOf({}, null)).toEqual([]);
	});

	test("doctor --json", () => {
		expect(
			parseDoctor([
				{ name: "plugins_directory", status: "warning", message: "Not created yet" },
				{ name: "plugin:x:version", status: "ok", message: "Reconciled", fixed: true },
				{ name: "weird", status: "??", message: 1 },
				"junk",
			]),
		).toEqual([
			{ name: "plugins_directory", status: "warning", message: "Not created yet" },
			{ name: "plugin:x:version", status: "ok", message: "Reconciled", fixed: true },
			{ name: "weird", status: "warning", message: "" },
		]);
	});

	test("config list --json: a secret's value never leaves the server, a default shows when nothing is set", () => {
		const settings = parseConfig({
			settings: { token: "s3cret", count: 3 },
			schema: {
				greeting: { type: "string", description: "What to say", default: "hi" },
				token: { type: "string", secret: true, env: "TOKEN" },
				count: { type: "number" },
			},
		});
		expect(settings).toEqual([
			{
				key: "greeting",
				type: "string",
				description: "What to say",
				env: null,
				secret: false,
				set: false,
				value: "hi",
			},
			{ key: "token", type: "string", description: null, env: "TOKEN", secret: true, set: true, value: null },
			{ key: "count", type: "number", description: null, env: null, secret: false, set: true, value: "3" },
		]);
		expect(JSON.stringify(settings)).not.toContain("s3cret");
	});

	test("name@marketplace splits at the last @", () => {
		expect(splitMarketplaceId("@scope/x@market")).toEqual({ name: "@scope/x", marketplace: "market" });
		expect(splitMarketplaceId("@scope/x")).toBeNull();
	});
});
