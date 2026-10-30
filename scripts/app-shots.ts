/**
 * Pictures of the macOS app's pages, and what changed between two releases (`bun run app-shots <before> <after>`).
 *
 *   bun scripts/app-shots.ts [--out DIR] [--scale 2] [--only home,chat] <before> [<after>]
 *
 * `<before>` and `<after>` are each an installer (`omp-webui-vX.Y.Z.dmg`), an app (`omp-webui.app`) or a release tag
 * (`v0.11.11`, whose dmg is downloaded with `gh`). One input only takes its pictures; two also lay them side by side,
 * label each pair and count the pixels that differ (DIR/compare/*.png, DIR/index.md).
 *
 * Nothing here needs a screen you are looking at, and the Mac may be locked. The app itself is never started (it would
 * need a window on a screen, and would be the installed app's neighbour): each bundle's own server and web build are run,
 * and the page is photographed in a WKWebView set up as the app sets up its own (tests/support/swift/appshots-harness.swift)
 * that is never shown: `WKWebView.takeSnapshot` renders it inside WebKit. The picture is therefore the page without the
 * window around it, in the shell's mode (the page finds the app's script message handlers), at 1280 × 840 points.
 *
 * It stays away from the installed app and your preferences: each bundle's server gets its own HOME, omp agent directory,
 * data directory, temp directory and port in a new temporary directory (tests/support/omp-env.ts, `login: false`, so no model
 * and no login of yours), the fixture conversations of the tests are written into it, and the page's WebKit storage is
 * not persistent. Theme and language are set through the server's preferences (`POST /api/prefs`), before each picture.
 * Nothing is deleted: the images are written into DIR/<version>/ and an existing file is never replaced (the run stops).
 * Disk images are mounted read-only, outside Finder's view, under a temporary directory and detached at the end.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";
import { FIXTURE_BUCKET, FIXTURE_FILES, seedFixtures } from "../tests/support/fixtures.ts";
import { hostEnv, isolatedEnv } from "../tests/support/omp-env.ts";
import { isShuttingDown, killTree, onShutdown } from "./lib/shutdown.ts";

const root = join(import.meta.dirname, "..");
const SIZE = { width: 1280, height: 840 };

type Lang = "en" | "zh-CN";
type Theme = "dark" | "light";
const LANGS: Lang[] = ["en", "zh-CN"];
const THEMES: Theme[] = ["dark", "light"];

// ───────────────────────────── what is photographed ─────────────────────────────

interface Pages {
	alpha: string;
	epsilon: string;
}

interface ShotSpec {
	name: string;
	/** What follows the origin. */
	path(p: Pages): string;
	/** JavaScript (an async function body) run once the page is up. */
	prepare?: string;
	/** A JavaScript expression that is true once the page shows what the picture is about. */
	waitFor: string;
}

const has = (testid: string) => `!!document.querySelector('[data-testid="${testid}"]')`;
const open = (file: string) => `/#/s/${encodeURIComponent(file)}`;

const SHOTS: ShotSpec[] = [
	{ name: "home", path: () => "/", waitFor: has("session-item") },
	{
		name: "chat",
		path: (p) => open(p.alpha),
		waitFor: `${has("chat-title")} && document.querySelectorAll('[data-testid="transcript"] *').length > 8`,
	},
	{
		name: "agents",
		path: (p) => open(p.epsilon),
		prepare: `const until = Date.now() + 15000;
			while (!document.querySelector('[data-testid="toggle-panel"]') && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
			if (!document.querySelector('[data-testid="right-panel"]')) document.querySelector('[data-testid="toggle-panel"]').click();`,
		waitFor: has("right-panel"),
	},
	{
		name: "search",
		path: (p) => open(p.alpha),
		prepare: `const until = Date.now() + 15000;
			while (!document.querySelector('[data-testid="chat-title"]') && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
			document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
			let input = null;
			while (!(input = document.querySelector('[data-testid="palette-input"]')) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "zebra");
			input.dispatchEvent(new Event("input", { bubbles: true }));`,
		waitFor: has("search-hit"),
	},
	{
		name: "settings",
		path: () => "/#/settings",
		waitFor: `location.hash.startsWith("#/settings") && document.body.innerText.length > 300`,
	},
];

/** What would differ between two releases for no reason of the page's own: the version line of the sidebar. */
const CSS = '[data-testid="app-versions"],[aria-label="Scroll to bottom"],[aria-label="滚动到底部"]{visibility:hidden}';

// ───────────────────────────── processes ─────────────────────────────

/** The commands and servers running now, and the images mounted: a signal ends them before the script goes. */
const running = new Set<Subprocess>();
const mounts: string[] = [];

async function exec(cmd: string[], opts: { env?: Record<string, string | undefined>; timeout?: number } = {}) {
	const proc = Bun.spawn(cmd, { cwd: root, stdout: "pipe", stderr: "pipe", env: opts.env, timeout: opts.timeout });
	running.add(proc);
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout as ReadableStream).text(),
		new Response(proc.stderr as ReadableStream).text(),
		proc.exited,
	]).finally(() => running.delete(proc));
	return { code, out, err };
}

async function must(cmd: string[], opts: { env?: Record<string, string | undefined>; timeout?: number } = {}) {
	const r = await exec(cmd, opts);
	if (r.code !== 0) throw new Error(`${cmd.join(" ")} exited with ${r.code}\n${r.out}${r.err}`);
	return r.out;
}

async function detachAll(): Promise<void> {
	for (const mount of mounts.splice(0)) {
		for (let attempt = 0; attempt < 5; attempt++) {
			if (Bun.spawnSync(["hdiutil", "detach", mount, attempt === 4 ? "-force" : "-quiet"]).exitCode === 0) break;
			await Bun.sleep(1000 * (attempt + 1));
		}
	}
}

const cleanup = onShutdown(async () => {
	await Promise.all([...running].map((p) => killTree(p.pid, 3000)));
	await detachAll();
});

// ───────────────────────────── arguments ─────────────────────────────

const args = process.argv.slice(2);
function option(name: string): string | undefined {
	const at = args.indexOf(name);
	if (at < 0) return undefined;
	const [, value] = args.splice(at, 2);
	if (value === undefined) throw new Error(`${name} needs a value`);
	return value;
}
const outOption = option("--out");
const scale = Number(option("--scale") ?? 2);
const only = option("--only")?.split(",");
const inputs = args;
if (inputs.length < 1 || inputs.length > 2 || inputs.some((a) => a.startsWith("--")) || !(scale > 0)) {
	console.error("usage: bun scripts/app-shots.ts [--out DIR] [--scale 2] [--only home,chat] <before> [<after>]");
	console.error("       an input is a .dmg, an .app or a release tag such as v0.11.11");
	process.exit(2);
}
const shots = SHOTS.filter((s) => !only || only.includes(s.name));
if (shots.length === 0) throw new Error(`--only names none of: ${SHOTS.map((s) => s.name).join(", ")}`);

// ───────────────────────────── a bundle's server ─────────────────────────────

interface Bundle {
	label: string;
	app: string;
}

/** The app an input stands for: a disk image is mounted read-only (not shown in Finder), a tag's image is downloaded first. */
async function resolveBundle(input: string, scratch: string): Promise<Bundle> {
	let path = input;
	if (/^v\d+\.\d+\.\d+/.test(input)) {
		const dir = mkdtempSync(join(scratch, "dl-"));
		await must(["gh", "release", "download", input, "-p", "*.dmg", "-D", dir]);
		path = join(dir, readdirSync(dir).find((f) => f.endsWith(".dmg")) ?? "missing.dmg");
	}
	path = resolve(path);
	if (!existsSync(path)) throw new Error(`${input} does not exist`);
	let app = path;
	if (path.endsWith(".dmg")) {
		const mount = mkdtempSync(join(scratch, "mnt-"));
		await must([
			"hdiutil",
			"attach",
			path,
			"-readonly",
			"-nobrowse",
			"-noautoopen",
			"-noverify",
			"-mountpoint",
			mount,
			"-quiet",
		]);
		mounts.push(mount);
		app = join(mount, "omp-webui.app");
	}
	if (!existsSync(join(app, "Contents/Resources/omp-webui-server"))) throw new Error(`${app} is not an omp-webui app`);
	const version = (
		await must(["plutil", "-extract", "CFBundleShortVersionString", "raw", "-o", "-", join(app, "Contents/Info.plist")])
	).trim();
	return { label: `v${version}`, app };
}

interface World {
	base: string;
	token: string;
	pages: Pages;
	server: Subprocess;
}

/** The bundle's own server, in a world of its own (see the header); resolves once it says which port it took. */
async function startWorld(bundle: Bundle, scratch: string): Promise<World> {
	const home = mkdtempSync(join(scratch, "world-"));
	const env = await isolatedEnv(home, { login: false });
	seedFixtures(env.PI_CODING_AGENT_DIR);
	const dataDir = join(home, "data");
	mkdirSync(dataDir, { recursive: true });
	// "Guard dangerous commands" holds a risky call for a reviewer; nothing here makes one, and a release that has it would still
	// be asked for nothing. Off, as in the tests.
	const guardFile = `${dataDir}.guard.json`;
	writeFileSync(guardFile, JSON.stringify({ mode: "off" }));
	const token = `tok-${crypto.randomUUID()}`;
	const proc = Bun.spawn([join(bundle.app, "Contents/Resources/omp-webui-server")], {
		cwd: home,
		env: {
			...hostEnv(),
			...env,
			OMP_WEBUI_DATA_DIR: dataDir,
			OMP_WEBUI_DIST: join(bundle.app, "Contents/Resources/web"),
			OMP_WEBUI_PORT: "0",
			OMP_WEBUI_AUTO_PORT: "1",
			OMP_WEBUI_TOKEN: token,
			OMP_WEBUI_GUARD_CONFIG: guardFile,
			OMP_WEBUI_UPDATE_CHECK: "off",
			// The server stops with this script.
			OMP_WEBUI_PARENT_PID: String(process.pid),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	running.add(proc);
	let printed = "";
	const ready = Promise.withResolvers<number>();
	const pump = async (stream: ReadableStream<Uint8Array>) => {
		const decoder = new TextDecoder();
		for await (const chunk of stream) {
			printed += decoder.decode(chunk, { stream: true });
			const line = /OMPW_READY (\{.*\})/.exec(printed);
			if (line) ready.resolve(JSON.parse(line[1]).port);
		}
	};
	void pump(proc.stdout as ReadableStream<Uint8Array>);
	void pump(proc.stderr as ReadableStream<Uint8Array>);
	void proc.exited.then(() =>
		ready.reject(new Error(`the server of ${bundle.label} exited before it was ready:\n${printed}`)),
	);
	const port = await Promise.race([
		ready.promise,
		Bun.sleep(60_000).then(() => {
			throw new Error(`the server of ${bundle.label} was not ready in 60 s:\n${printed}`);
		}),
	]);
	const session = (file: string) => realpathSync(join(env.PI_CODING_AGENT_DIR, "sessions", FIXTURE_BUCKET, file));
	return {
		base: `http://127.0.0.1:${port}`,
		token,
		pages: { alpha: session(FIXTURE_FILES.alpha), epsilon: session(FIXTURE_FILES.epsilon) },
		server: proc,
	};
}

/**
 * The preferences of a picture: its theme and language, every other one forgotten (a page that ran before may have kept
 * some). Only the keys the release has: the server refuses one it does not know, and an older release has fewer.
 */
async function setPrefs(world: World, lang: Lang, theme: Theme): Promise<void> {
	const headers = { "content-type": "application/json", "x-omp-webui": "1", "x-omp-webui-token": world.token };
	const known = await fetch(`${world.base}/api/prefs`, { headers });
	if (!known.ok) throw new Error(`reading the preferences failed: ${known.status} ${await known.text()}`);
	const { values } = (await known.json()) as { values: Record<string, string | null> };
	const changes: Record<string, string | null> = Object.fromEntries(Object.keys(values).map((k) => [k, null]));
	changes["ompw.theme"] = theme;
	changes["ompw.lang"] = lang;
	const res = await fetch(`${world.base}/api/prefs`, { method: "POST", headers, body: JSON.stringify({ changes }) });
	if (!res.ok) throw new Error(`setting the preferences failed: ${res.status} ${await res.text()}`);
}

// ───────────────────────────── main ─────────────────────────────

async function main(): Promise<void> {
	const scratch = mkdtempSync(join(tmpdir(), "ompw-appshots-"));
	console.log(`scratch: ${scratch} (nothing in it is removed)`);
	const harness = join(scratch, "appshots-harness");
	console.log("$ swiftc appshots-harness");
	await must(
		[
			"swiftc",
			"-O",
			"-swift-version",
			"5",
			join(root, "macos/notifications.swift"),
			join(root, "macos/droppaths.swift"),
			join(root, "macos/navigation.swift"),
			join(root, "macos/popout.swift"),
			join(root, "tests/support/swift/appshots-harness.swift"),
			"-o",
			harness,
		],
		{ timeout: 300_000 },
	);

	const bundles: Bundle[] = [];
	for (const input of inputs) bundles.push(await resolveBundle(input, scratch));
	if (bundles.length === 2 && bundles[0].label === bundles[1].label)
		throw new Error(`both inputs are ${bundles[0].label}; there is nothing to compare`);
	const outDir = resolve(outOption ?? join(root, ".tmp", "app-shots", `${bundles.at(-1)?.label}`));
	for (const b of bundles) {
		const dir = join(outDir, b.label);
		if (existsSync(dir) && readdirSync(dir).length > 0)
			throw new Error(`${dir} has files in it already; nothing is replaced`);
		mkdirSync(dir, { recursive: true });
	}

	for (const bundle of bundles) {
		console.log(`\n== ${bundle.label} (${bundle.app})`);
		const world = await startWorld(bundle, scratch);
		console.log(`server of ${bundle.label} on ${world.base}`);
		for (const lang of LANGS) {
			for (const theme of THEMES) {
				for (const shot of shots) {
					await setPrefs(world, lang, theme);
					const name = `${shot.name}-${lang}-${theme}`;
					const job = join(scratch, `${bundle.label}-${name}.json`);
					writeFileSync(
						job,
						JSON.stringify({
							base: world.base,
							token: world.token,
							out: join(outDir, bundle.label),
							...SIZE,
							scale,
							css: CSS,
							timeout: 30,
							settle: 800,
							shots: [{ name, path: shot.path(world.pages), prepare: shot.prepare, waitFor: shot.waitFor }],
						}),
					);
					const r = await exec([harness, "shoot", job], { timeout: 120_000 });
					if (isShuttingDown()) throw new Error("interrupted");
					if (r.code !== 0) throw new Error(`${bundle.label} ${name} failed:\n${r.out}${r.err}`);
					console.log(`${bundle.label} ${name}`);
				}
			}
		}
		await killTree(world.server.pid, 3000);
	}
	await detachAll();

	if (bundles.length === 2) await compareAll(harness, bundles as [Bundle, Bundle], outDir);
	console.log(`\npictures: ${outDir}`);
}

async function compareAll(harness: string, [before, after]: [Bundle, Bundle], outDir: string): Promise<void> {
	const dir = join(outDir, "compare");
	mkdirSync(dir, { recursive: true });
	const rows: string[] = [];
	for (const lang of LANGS)
		for (const theme of THEMES)
			for (const shot of shots) {
				const name = `${shot.name}-${lang}-${theme}.png`;
				const out = await must([
					harness,
					"compare",
					join(outDir, before.label, name),
					join(outDir, after.label, name),
					join(dir, name),
					before.label,
					after.label,
				]);
				const r = JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as {
					changed: number;
					total: number;
					width: number;
					height: number;
				};
				const pct = ((100 * r.changed) / r.total).toFixed(2);
				console.log(`${name}: ${pct}% differ`);
				rows.push(
					`| \`${name}\` | ${r.width}x${r.height} | ${r.changed.toLocaleString("en-US")} / ${r.total.toLocaleString("en-US")} | **${pct}%** |`,
				);
			}
	writeFileSync(
		join(outDir, "index.md"),
		[
			`# macOS app: ${before.label} → ${after.label}`,
			"",
			`Each release's own server and web build, in an isolated HOME, omp agent directory and data directory with the test fixtures, theme and language set through \`POST /api/prefs\`. The page is photographed in a WKWebView set up like the app's window page, never shown: \`WKWebView.takeSnapshot\` at ${SIZE.width}x${SIZE.height} points, ${scale}x. Made by \`scripts/app-shots.ts\`, which needs no screen: it runs with the Mac locked.`,
			"",
			"Not in the pictures: the window frame and title bar, the version line and the scroll-to-bottom arrow (hidden), and macOS notification state (the harness is not an app bundle, so the page is told notifications are unsupported).",
			"",
			"A pixel differs when any RGB channel differs.",
			"",
			"| shot | size | pixels differ | share |",
			"|---|---|---|---|",
			...rows,
			"",
			`Pictures: \`${before.label}/\`, \`${after.label}/\`; side by side (before left, after right): \`compare/\`.`,
			"",
		].join("\n"),
	);
}

try {
	await main();
} finally {
	await cleanup();
}
