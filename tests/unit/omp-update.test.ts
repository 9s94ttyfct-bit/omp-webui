import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTarget, changelogUrl, latestRelease, parseNpmrc, registryFor } from "../../server/omp/update.ts";

/**
 * Where the latest omp release is looked up, and how: the way `omp update` does it — npm's registry for a package
 * manager's install (the registry the user's own config names), omp's build service for the standalone binary.
 * A fetch that answers from a table stands in for both; nothing here reaches the network.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-update-"));
let n = 0;
function home(files: Record<string, string> = {}): string {
	const dir = join(root, `home${++n}`);
	mkdirSync(dir, { recursive: true });
	for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
	return dir;
}
afterAll(() => rmSync(root, { recursive: true, force: true }));

type Reply = { status?: number; body?: unknown } | ((url: string, init?: RequestInit) => Response);
/** A fetch that answers by URL, and remembers what it was asked. */
function fakeFetch(replies: Record<string, Reply>) {
	const asked: { url: string; headers: Record<string, string> }[] = [];
	const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = String(input);
		asked.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
		const reply = replies[url];
		if (!reply) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
		if (typeof reply === "function") return reply(url, init);
		return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 });
	};
	return { impl, asked };
}

const USER_AGENT = "omp-webui/test";
const NPM = "https://registry.npmjs.org/@oh-my-pi%2fpi-coding-agent/latest";

test("a package-manager install asks npm for the latest version of omp's package", async () => {
	const { impl, asked } = fakeFetch({ [NPM]: { body: { name: "@oh-my-pi/pi-coding-agent", version: "18.13.0" } } });
	const release = await latestRelease({
		method: "homebrew",
		env: {},
		home: home(),
		fetch: impl,
		userAgent: USER_AGENT,
	});
	expect(release).toEqual({
		latest: "18.13.0",
		source: "npm",
		changelogUrl: "https://github.com/can1357/oh-my-pi/releases/tag/v18.13.0",
	});
	expect(asked).toHaveLength(1);
	expect(asked[0].headers["user-agent"]).toBe(USER_AGENT);
	// Homebrew, bun, npm, mise, Nix and anything unclassified share the one source.
	for (const method of ["bun", "npm", "mise", "nix", "unknown", null] as const) {
		expect((await latestRelease({ method, env: {}, home: home(), fetch: impl, userAgent: USER_AGENT })).source).toBe(
			"npm",
		);
	}
});

test("the standalone binary asks omp's build service for this platform's newest stable build", async () => {
	const target = buildTarget();
	const url = `https://build.example.test/api/products/omp/latest/${target}?channel=stable`;
	const { impl, asked } = fakeFetch({
		[url]: { body: { build: { version: "18.13.0", channel: "stable" }, file: {}, download: "x" } },
	});
	const release = await latestRelease({
		method: "installer",
		// A trailing slash on `PI_BUILD_URL` makes no difference, as for omp.
		env: { PI_BUILD_URL: "https://build.example.test/" },
		home: home(),
		fetch: impl,
		userAgent: USER_AGENT,
	});
	expect(release).toMatchObject({ latest: "18.13.0", source: "build-service" });
	expect(asked.map((a) => a.url)).toEqual([url]);
});

test("the build service says when there is no build, and an answer that is no version is refused", async () => {
	const target = buildTarget();
	const url = `https://build.stencil.so/api/products/omp/latest/${target}?channel=stable`;
	const noBuild = fakeFetch({ [url]: { status: 404, body: { error: "no_build" } } });
	await expect(
		latestRelease({ method: "installer", env: {}, home: home(), fetch: noBuild.impl, userAgent: USER_AGENT }),
	).rejects.toThrow(`No omp build is published on https://build.stencil.so for ${target} yet`);
	const odd = fakeFetch({ [url]: { body: { build: { version: "latest" } } } });
	await expect(
		latestRelease({ method: "installer", env: {}, home: home(), fetch: odd.impl, userAgent: USER_AGENT }),
	).rejects.toThrow("Invalid answer");
});

test("build targets are the build service's names", () => {
	expect(buildTarget("darwin", "arm64")).toBe("macos-arm64");
	expect(buildTarget("darwin", "x64")).toBe("macos-x86_64");
	expect(buildTarget("linux", "x64")).toBe("linux-x86_64");
	expect(buildTarget("linux", "arm64", true)).toBe("linux-musl-arm64");
	expect(() => buildTarget("freebsd", "x64")).toThrow("Unsupported platform");
});

test("the registry is the one the user's own config names, in omp's order", () => {
	const h = home({
		".npmrc": [
			"; comment",
			"registry=https://npmrc.example/",
			"@oh-my-pi:registry=https://scoped.example/npm",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: `${VAR}` is .npmrc's own syntax for the environment.
			"//scoped.example/:_authToken=${SCOPED_TOKEN}",
		].join("\n"),
		".bunfig.toml": '[install]\nregistry = "https://bunfig.example/"\n',
	});
	// A registry for the package's scope beats everything, and carries the token npm would send it.
	expect(
		registryFor("@oh-my-pi/pi-coding-agent", { npm_config_registry: "https://env.example/", SCOPED_TOKEN: "t0k" }, h),
	).toEqual({
		url: "https://scoped.example/npm/",
		authorization: "Bearer t0k",
	});
	// Without the scope: the environment, then `.npmrc`, then bunfig, then npm's own.
	const plain = home({
		".npmrc": "registry=https://npmrc.example/\n",
		".bunfig.toml": '[install]\nregistry = "https://bunfig.example/"\n',
	});
	expect(registryFor("@oh-my-pi/pi-coding-agent", { BUN_CONFIG_REGISTRY: "https://env.example" }, plain).url).toBe(
		"https://env.example/",
	);
	expect(registryFor("@oh-my-pi/pi-coding-agent", {}, plain).url).toBe("https://npmrc.example/");
	expect(
		registryFor(
			"@oh-my-pi/pi-coding-agent",
			{},
			home({ ".bunfig.toml": '[install]\nregistry = "https://bunfig.example/"\n' }),
		).url,
	).toBe("https://bunfig.example/");
	expect(registryFor("@oh-my-pi/pi-coding-agent", {}, home()).url).toBe("https://registry.npmjs.org/");
	// bunfig scopes, and `npm_config_*` names in any case.
	const scoped = home({
		".bunfig.toml": '[install.scopes]\n"@oh-my-pi" = { url = "https://bun-scope.example/", token = "x" }\n',
	});
	expect(registryFor("@oh-my-pi/pi-coding-agent", {}, scoped).url).toBe("https://bun-scope.example/");
	expect(registryFor("@oh-my-pi/pi-coding-agent", { NPM_CONFIG_REGISTRY: "https://upper.example/" }, home()).url).toBe(
		"https://upper.example/",
	);
});

test("a registry that is not a web address, or has credentials in it, is handled as omp does", () => {
	expect(() => registryFor("@oh-my-pi/pi-coding-agent", { npm_config_registry: "ftp://x/" }, home())).toThrow(
		"Unsupported npm registry protocol",
	);
	expect(() => registryFor("@oh-my-pi/pi-coding-agent", { npm_config_registry: "nonsense" }, home())).toThrow(
		"Invalid npm registry URL",
	);
	const r = registryFor(
		"@oh-my-pi/pi-coding-agent",
		{ npm_config_registry: "https://user:pw@feed.example/npm" },
		home(),
	);
	expect(r.url).toBe("https://feed.example/npm/");
	expect(r.authorization).toBe(`Basic ${btoa("user:pw")}`);
});

test(".npmrc is read as npm reads it", () => {
	// biome-ignore lint/suspicious/noTemplateCurlyInString: `${VAR}` is .npmrc's own syntax for the environment.
	const c = parseNpmrc('a = 1\n# x\n[section]\nb="two"\nc=${HOME_DIR}/x\n', { HOME_DIR: "/h" });
	expect([...c.entries()]).toEqual([
		["a", "1"],
		["b", "two"],
		["c", "/h/x"],
	]);
});

/** `${NAME}`, `${NAME?}`: .npmrc's syntax for the environment. */
const ref = (name: string, optional = "") => `\${${name}${optional}}`;

test("a bunfig registry's token or username and password is what the look-up sends, as for `omp update`", () => {
	const PKG = "@oh-my-pi/pi-coding-agent";
	// The default registry with a token, the variable filled from the environment.
	const token = home({
		".bunfig.toml": `[install]\nregistry = { url = "https://feed.example/npm", token = "${ref("FEED_TOKEN")}" }\n`,
	});
	expect(registryFor(PKG, { FEED_TOKEN: "t0k" }, token)).toEqual({
		url: "https://feed.example/npm/",
		authorization: "Bearer t0k",
	});
	// A scoped registry with a username and password.
	const basic = home({
		".bunfig.toml":
			'[install.scopes]\n"@oh-my-pi" = { url = "https://scope.example/", username = "me", password = "pw" }\n',
	});
	expect(registryFor(PKG, {}, basic)).toEqual({
		url: "https://scope.example/",
		authorization: `Basic ${btoa("me:pw")}`,
	});
	// The entry's own credentials come before the `.npmrc` ones for its host.
	const both = home({
		".npmrc": "//feed.example/:_authToken=npmrc-token\n",
		".bunfig.toml": '[install]\nregistry = { url = "https://feed.example/", token = "bun-token" }\n',
	});
	expect(registryFor(PKG, {}, both).authorization).toBe("Bearer bun-token");
	// A bunfig that is not TOML stops the look-up, as it stops `omp update`; the message names the file.
	const broken = home({ ".bunfig.toml": '[install\nregistry = "https://feed.example/"\n' });
	expect(() => registryFor(PKG, {}, broken)).toThrow(`Failed to parse ${join(broken, ".bunfig.toml")}`);
});

test("an .npmrc's username and _password (base64) are sent as Basic credentials, walking up the registry's path", () => {
	const h = home({
		".npmrc": [
			"registry=https://feed.example/npm/team/",
			"//feed.example/npm/:username=me",
			`//feed.example/npm/:_password=${btoa("p@ss word")}`,
		].join("\n"),
	});
	expect(registryFor("@oh-my-pi/pi-coding-agent", {}, h)).toEqual({
		url: "https://feed.example/npm/team/",
		authorization: `Basic ${btoa("me:p@ss word")}`,
	});
	// The nearest key wins: a token for the exact path beats a password for its parent.
	const nearer = home({
		".npmrc": [
			"registry=https://feed.example/npm/team/",
			"//feed.example/npm/:username=me",
			`//feed.example/npm/:_password=${btoa("pw")}`,
			"//feed.example/npm/team/:_authToken=exact",
		].join("\n"),
	});
	expect(registryFor("@oh-my-pi/pi-coding-agent", {}, nearer).authorization).toBe("Bearer exact");
	// A password that is not base64 is refused with a message that does not repeat it.
	const raw = home({
		".npmrc": "registry=https://feed.example/\n//feed.example/:username=me\n//feed.example/:_password=not base64 !!\n",
	});
	let said = "";
	try {
		registryFor("@oh-my-pi/pi-coding-agent", {}, raw);
	} catch (e) {
		said = (e as Error).message;
	}
	expect(said).toContain("is not base64-encoded");
	expect(said).not.toContain("not base64 !!");
});

test("a variable an .npmrc names that is not set is an error, as for npm and `omp update`", () => {
	const path = join(home({ ".npmrc": `//feed.example/:_authToken=${ref("FEED_TOKEN")}\n` }), ".npmrc");
	expect(() => parseNpmrc(`//feed.example/:_authToken=${ref("FEED_TOKEN")}\n`, {}, path)).toThrow(
		`Failed to replace env in config: ${ref("FEED_TOKEN")} (${path})`,
	);
	// An empty variable counts as unset; `${VAR?}` is allowed to be, and `\${VAR}` is not a reference at all.
	expect(() => parseNpmrc(`a=${ref("EMPTY")}\n`, { EMPTY: "" })).toThrow("Failed to replace env in config");
	const c = parseNpmrc(`a=x${ref("MISSING", "?")}y\nb=\\${ref("LITERAL")}\n${ref("KEY")}=1\n`, { KEY: "named" });
	expect([...c.entries()]).toEqual([
		["a", "xy"],
		["b", ref("LITERAL")],
		["named", "1"],
	]);
	// Through the look-up: the release is not looked up in the wrong place, and the reason reaches the caller with no value in it.
	const h = home({ ".npmrc": `registry=https://feed.example/\n//feed.example/:_authToken=${ref("FEED_TOKEN")}\n` });
	expect(() => registryFor("@oh-my-pi/pi-coding-agent", { OTHER: "s3cret" }, h)).toThrow(ref("FEED_TOKEN"));
});

test("the credentials reach the registry as a header, and no message repeats them", async () => {
	const h = home({
		".bunfig.toml": '[install]\nregistry = { url = "https://feed.example/", token = "s3cret-token" }\n',
	});
	const url = "https://feed.example/@oh-my-pi%2fpi-coding-agent/latest";
	const ok = fakeFetch({ [url]: { body: { version: "18.14.0" } } });
	await latestRelease({ method: "bun", env: {}, home: h, fetch: ok.impl, userAgent: USER_AGENT });
	expect(ok.asked[0].headers.authorization).toBe("Bearer s3cret-token");
	const denied = fakeFetch({ [url]: { status: 401, body: {} } });
	const error = await latestRelease({
		method: "bun",
		env: {},
		home: h,
		fetch: denied.impl,
		userAgent: USER_AGENT,
	}).then(
		() => "",
		(e: Error) => e.message,
	);
	expect(error).toContain("HTTP 401");
	expect(error).not.toContain("s3cret-token");
	// A registry URL that cannot be parsed is quoted without the credentials in front of its host.
	const bad = (() => {
		try {
			registryFor("@oh-my-pi/pi-coding-agent", { npm_config_registry: "https://user:s3cret@ho st/" }, home());
		} catch (e) {
			return (e as Error).message;
		}
		return "";
	})();
	expect(bad).toContain("Invalid npm registry URL");
	expect(bad).not.toContain("s3cret");
});

test("a registry that does not serve the dist-tag shortcut is asked for the whole package", async () => {
	const base = "https://feed.example/";
	const shortcut = `${base}@oh-my-pi%2fpi-coding-agent/latest`;
	const whole = `${base}@oh-my-pi%2fpi-coding-agent`;
	const env = { npm_config_registry: base };
	// The shortcut answers with the packument itself (some registries do).
	const packument = fakeFetch({ [shortcut]: { body: { "dist-tags": { latest: "18.14.0" }, versions: {} } } });
	expect(
		(await latestRelease({ method: "bun", env, home: home(), fetch: packument.impl, userAgent: USER_AGENT })).latest,
	).toBe("18.14.0");
	// It does not serve the shortcut at all.
	const missing = fakeFetch({ [whole]: { body: { "dist-tags": { latest: "18.15.0" } } } });
	expect(
		(await latestRelease({ method: "bun", env, home: home(), fetch: missing.impl, userAgent: USER_AGENT })).latest,
	).toBe("18.15.0");
	expect(missing.asked.map((a) => a.url)).toEqual([shortcut, whole]);
});

test("a lookup that fails says why, in words for the user", async () => {
	const denied = fakeFetch({ [NPM]: { status: 401, body: {} } });
	await expect(
		latestRelease({ method: "npm", env: {}, home: home(), fetch: denied.impl, userAgent: USER_AGENT }),
	).rejects.toThrow("check the registry credentials in your .npmrc");
	const down = fakeFetch({ [NPM]: { status: 503, body: {} } });
	await expect(
		latestRelease({ method: "npm", env: {}, home: home(), fetch: down.impl, userAgent: USER_AGENT }),
	).rejects.toThrow("HTTP 503");
	const slow = async (): Promise<Response> => {
		throw new DOMException("The operation timed out", "TimeoutError");
	};
	await expect(
		latestRelease({ method: "npm", env: {}, home: home(), fetch: slow, userAgent: USER_AGENT }),
	).rejects.toThrow("Timed out looking up the latest omp release");
	const nothing = fakeFetch({ [NPM]: { body: { name: "x" } } });
	await expect(
		latestRelease({ method: "npm", env: {}, home: home(), fetch: nothing.impl, userAgent: USER_AGENT }),
	).rejects.toThrow("Malformed npm registry response");
});

test("the canary channel asks the build service for its canary build, as `omp update` does (#446)", async () => {
	const target = buildTarget();
	const url = `https://build.stencil.so/api/products/omp/latest/${target}?channel=canary`;
	const { impl, asked } = fakeFetch({
		[url]: { body: { build: { version: "18.13.0-canary.2", channel: "canary" }, file: {}, download: "x" } },
	});
	const release = await latestRelease({
		method: "installer",
		channel: "canary",
		env: {},
		home: home(),
		fetch: impl,
		userAgent: USER_AGENT,
	});
	expect(release).toMatchObject({ latest: "18.13.0-canary.2", source: "build-service" });
	expect(asked.map((a) => a.url)).toEqual([url]);
	// A canary that was never published says how to go back, in omp's words.
	const none = fakeFetch({ [url]: { status: 404, body: { error: "no_build" } } });
	await expect(
		latestRelease({
			method: "installer",
			channel: "canary",
			env: {},
			home: home(),
			fetch: none.impl,
			userAgent: USER_AGENT,
		}),
	).rejects.toThrow("Try `omp update --stable`.");
});

test("the canary channel asks npm for the `canary` dist-tag instead of `latest`, and says when there is none (#446)", async () => {
	const canary = NPM.replace(/latest$/, "canary");
	const { impl, asked } = fakeFetch({
		[canary]: { body: { name: "@oh-my-pi/pi-coding-agent", version: "18.13.0-canary.2" } },
		[NPM]: { body: { name: "@oh-my-pi/pi-coding-agent", version: "18.12.4" } },
	});
	const release = await latestRelease({
		method: "bun",
		channel: "canary",
		env: {},
		home: home(),
		fetch: impl,
		userAgent: USER_AGENT,
	});
	expect(release).toMatchObject({ latest: "18.13.0-canary.2", source: "npm" });
	expect(asked.map((a) => a.url)).toEqual([canary]);
	// npm answers 404 for a tag the package does not have.
	const none = fakeFetch({ [NPM]: { body: { name: "x", version: "18.12.4" } } });
	await expect(
		latestRelease({ method: "npm", channel: "canary", env: {}, home: home(), fetch: none.impl, userAgent: USER_AGENT }),
	).rejects.toThrow(
		"No canary release has been published for @oh-my-pi/pi-coding-agent yet. Try `omp update --stable`.",
	);
	// A registry that answers with the whole package: its `canary` tag is the one that counts, not `latest`.
	const whole = "https://registry.example.test/";
	const packument = fakeFetch({
		[`${whole}@oh-my-pi%2fpi-coding-agent/canary`]: {
			body: { "dist-tags": { latest: "18.12.4", canary: "18.13.0-canary.3" } },
		},
	});
	expect(
		(
			await latestRelease({
				method: "bun",
				channel: "canary",
				env: { npm_config_registry: whole },
				home: home(),
				fetch: packument.impl,
				userAgent: USER_AGENT,
			})
		).latest,
	).toBe("18.13.0-canary.3");
});

test("release notes are the release's page on GitHub", () => {
	expect(changelogUrl("18.13.0")).toBe("https://github.com/can1357/oh-my-pi/releases/tag/v18.13.0");
});
