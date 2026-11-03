import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { PREF, PREFS_ELEMENT_ID, type PrefsSnapshot } from "../../shared/prefs.ts";
import { type AppServer, startAppServer } from "../support/app-server.ts";
import { isolatedEnv } from "../support/omp-env.ts";

/**
 * The UI's preferences live in the server's data dir, so they are the same on whatever port the server comes up on (the
 * macOS app takes another when its own is taken). Two real servers, one after the other, on one data dir; the real
 * index.html is what they serve (no model calls).
 */

const root = mkdtempSync(join(tmpdir(), "ompw-prefs-contract-"));
const dist = join(root, "dist");
let env: Record<string, string>;
const procs: Subprocess[] = [];

beforeAll(async () => {
	env = await isolatedEnv(root);
	mkdirSync(dist, { recursive: true });
	copyFileSync(join(import.meta.dir, "../../web/index.html"), join(dist, "index.html"));
});
afterEach(async () => {
	for (const p of procs.splice(0)) {
		p.kill("SIGTERM");
		await p.exited;
	}
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function start(dataDir: string, port = 0, extra: Record<string, string> = {}): Promise<AppServer> {
	const server = await startAppServer(env, dataDir, port, { OMP_WEBUI_DIST: dist, ...extra });
	procs.push(server.proc);
	return server;
}

const dataDir = (name: string) => {
	const d = join(root, name);
	mkdirSync(d, { recursive: true });
	return d;
};

/** Requests as the app's page makes them: the cookie from the token link; a change also carries the CSRF header. */
const as = (s: AppServer) => ({ cookie: `ompw_token=${s.token}` });
const setPrefs = (s: AppServer, changes: unknown, headers: Record<string, string> = { "x-omp-webui": "1" }) =>
	fetch(`http://127.0.0.1:${s.port}/api/prefs`, {
		method: "POST",
		headers: { ...as(s), "content-type": "application/json", ...headers },
		body: JSON.stringify({ changes }),
	});

/** The snapshot a served page carries, and the page. */
async function page(s: AppServer, headers: Record<string, string> = as(s)) {
	const res = await fetch(`http://127.0.0.1:${s.port}/`, { headers });
	const html = await res.text();
	const open = `<script type="application/json" id="${PREFS_ELEMENT_ID}">`;
	const at = html.indexOf(open);
	const snapshot: PrefsSnapshot | null =
		at < 0 ? null : JSON.parse(html.slice(at + open.length, html.indexOf("</script>", at)));
	return { res, html, snapshot, at };
}

test("what is chosen on one port is in the page the server serves on another, ahead of the script that paints it", async () => {
	const dir = dataDir("two-ports");
	const first = await start(dir);
	const before = await page(first);
	expect(before.snapshot?.rev).toBe(0);
	expect(Object.values(before.snapshot?.values ?? { x: "y" }).every((v) => v === null)).toBe(true);

	const set = await setPrefs(first, {
		[PREF.theme]: "light",
		[PREF.palette]: "terminal",
		[PREF.lang]: "zh-CN",
		[PREF.sidebarWidth]: "412",
		[PREF.panelWidth]: "530",
	});
	expect(set.status).toBe(200);
	expect(((await set.json()) as PrefsSnapshot).rev).toBe(1);

	// Hold the former port so the next OS-assigned listener must use a different origin.
	first.proc.kill("SIGTERM");
	await first.proc.exited;
	const occupied = Bun.serve({ port: first.port, hostname: "127.0.0.1", fetch: () => new Response("occupied") });
	let second: AppServer;
	try {
		second = await start(dir);
	} finally {
		occupied.stop(true);
	}
	expect(second.port).not.toBe(first.port);

	const after = await page(second);
	expect(after.snapshot?.id).toBe(before.snapshot?.id);
	expect(after.snapshot?.rev).toBe(1);
	expect(after.snapshot?.values[PREF.theme]).toBe("light");
	expect(after.snapshot?.values[PREF.palette]).toBe("terminal");
	expect(after.snapshot?.values[PREF.lang]).toBe("zh-CN");
	expect(after.snapshot?.values[PREF.sidebarWidth]).toBe("412");
	expect(after.snapshot?.values[PREF.panelWidth]).toBe("530");
	expect(after.snapshot?.values[PREF.cwd]).toBeNull();
	// Ahead of every script of the page: nothing reads storage before it has been applied.
	expect(after.at).toBeGreaterThan(0);
	expect(after.at).toBeLessThan(after.html.indexOf("<script>"));
	expect(after.html.indexOf("<script>")).toBeLessThan(after.html.indexOf('<script type="module"'));
	expect(after.res.headers.get("cache-control")).toBe("no-store");
	// The GET endpoint says the same.
	const api = await fetch(`http://127.0.0.1:${second.port}/api/prefs`, { headers: as(second) });
	expect(await api.json()).toEqual(after.snapshot);
});

test("the page's CSP still allows its own inline script, and nothing else inline", async () => {
	const s = await start(dataDir("csp"));
	await setPrefs(s, { [PREF.theme]: "dark" });
	const served = await page(s);
	const inline = /<script>([\s\S]*?)<\/script>/.exec(readFileSync(join(dist, "index.html"), "utf8"))?.[1] ?? "";
	const hash = `'sha256-${createHash("sha256").update(inline).digest("base64")}'`;
	const csp = served.res.headers.get("content-security-policy") ?? "";
	expect(csp).toContain(`script-src 'self' ${hash};`);
	// The page as served is the file plus the data block: the inline script is byte for byte the one that is hashed.
	expect(served.html).toContain(`<script>${inline}</script>`);
	expect(served.html.match(/<script/g)).toHaveLength(3);
});

test("a value cannot end the data block or add a script to the page", async () => {
	const s = await start(dataDir("hostile"));
	const hostile = `</script><script>alert(document.cookie)</script><!--`;
	expect((await setPrefs(s, { [PREF.cwd]: hostile })).status).toBe(200);
	const served = await page(s);
	expect(served.snapshot?.values[PREF.cwd]).toBe(hostile);
	expect(served.html.match(/<script/g)).toHaveLength(3);
	expect(served.html).not.toContain("alert(document.cookie)</script>");
});

test("a request without the access token learns nothing and changes nothing", async () => {
	const s = await start(dataDir("closed"));
	await setPrefs(s, { [PREF.cwd]: "/very/private/project" });

	const anonymous = await page(s, {});
	expect(anonymous.res.status).toBe(200);
	expect(anonymous.snapshot).toBeNull();
	expect(anonymous.html).not.toContain("/very/private/project");
	expect(anonymous.html).not.toContain('type="application/json"');

	const url = `http://127.0.0.1:${s.port}/api/prefs`;
	expect((await fetch(url)).status).toBe(401);
	const post = await fetch(url, {
		method: "POST",
		headers: { "x-omp-webui": "1", "content-type": "application/json" },
		body: JSON.stringify({ changes: { [PREF.cwd]: "/elsewhere" } }),
	});
	expect(post.status).toBe(401);
	// Cookies ignore ports: a page of another origin cannot change them even with the cookie.
	const crossOrigin = await setPrefs(
		s,
		{ [PREF.cwd]: "/elsewhere" },
		{ "x-omp-webui": "1", origin: "http://127.0.0.1:3000" },
	);
	expect(crossOrigin.status).toBe(403);
	// Not a form post either: the CSRF header is required.
	expect((await setPrefs(s, { [PREF.cwd]: "/elsewhere" }, {})).status).toBe(403);
	expect((await page(s)).snapshot?.values[PREF.cwd]).toBe("/very/private/project");
});

test("changes the store does not keep are refused whole", async () => {
	const s = await start(dataDir("strict"));
	await setPrefs(s, { [PREF.theme]: "dark" });
	const bad: unknown[] = [
		{ [PREF.theme]: "light", "ompw.unknown": "x" },
		{ [PREF.theme]: "light", [PREF.cwd]: 5 },
		{ [PREF.theme]: "light", [PREF.cwd]: "x".repeat(20_000) },
		["ompw.theme"],
		null,
	];
	for (const changes of bad) {
		const res = await setPrefs(s, changes);
		expect(res.status, JSON.stringify(changes)?.slice(0, 60)).toBe(400);
	}
	expect((await page(s)).snapshot?.values[PREF.theme]).toBe("dark");
	// null forgets a key.
	await setPrefs(s, { [PREF.theme]: null });
	expect((await page(s)).snapshot?.values[PREF.theme]).toBeNull();
	// A value the app never writes for its key is refused like an unknown key.
	for (const changes of [{ [PREF.theme]: "blue" }, { [PREF.palette]: "neon" }, { [PREF.panelWidth]: "wide" }]) {
		expect((await setPrefs(s, changes)).status, JSON.stringify(changes)).toBe(400);
	}
	expect((await page(s)).snapshot?.values[PREF.theme]).toBeNull();
});

test('the macOS shell asks what quitting does with its own token header, and "Don\'t ask again" writes the preference Settings shows', async () => {
	const s = await start(dataDir("quit-action"));
	// The four requests the shell makes when it is asked to quit (macos/quit.swift): the token header, no cookie, no page.
	const header = { "x-omp-webui-token": s.token };
	for (const path of ["/api/lives", "/api/omp", "/api/prefs", "/api/remote"]) {
		const res = await fetch(`http://127.0.0.1:${s.port}${path}`, { headers: header });
		expect(res.status, path).toBe(200);
	}
	const read = async () =>
		((await (await fetch(`http://127.0.0.1:${s.port}/api/prefs`, { headers: header })).json()) as PrefsSnapshot).values;
	expect((await read())[PREF.quitAction]).toBeNull();

	const write = (changes: unknown) =>
		fetch(`http://127.0.0.1:${s.port}/api/prefs`, {
			method: "POST",
			headers: { ...header, "content-type": "application/json", "x-omp-webui": "1" },
			body: JSON.stringify({ changes }),
		});
	expect((await write({ [PREF.quitAction]: "background" })).status).toBe(200);
	expect((await read())[PREF.quitAction]).toBe("background");
	// The page the server serves next carries it, so that Settings shows it.
	expect((await page(s)).snapshot?.values[PREF.quitAction]).toBe("background");
	expect((await write({ [PREF.quitAction]: "quit" })).status).toBe(200);
	expect((await read())[PREF.quitAction]).toBe("quit");
	// Only the three answers are kept, and a change to it does not touch the others.
	expect((await write({ [PREF.quitAction]: "sometimes" })).status).toBe(400);
	expect((await read())[PREF.quitAction]).toBe("quit");
	expect((await write({ [PREF.quitAction]: "ask" })).status).toBe(200);
	expect((await read())[PREF.quitAction]).toBe("ask");
});

test("two servers on one data dir keep each other's changes, and the revision only goes up", async () => {
	const dir = dataDir("two-live");
	// A server whose app is still running is not left over: the next one leaves it be (server/instance.ts), as with a
	// second copy of the app. This test process stands in for that app.
	const a = await start(dir, 0, { OMP_WEBUI_PARENT_PID: String(process.pid) });
	const b = await start(dir);
	expect(a.port).not.toBe(b.port);

	const first = (await (await setPrefs(a, { [PREF.palette]: "terminal" })).json()) as PrefsSnapshot;
	expect(first.rev).toBe(1);
	// `b` started before that and has not been asked anything since: its page already carries it.
	expect((await page(b)).snapshot?.values[PREF.palette]).toBe("terminal");

	const second = (await (await setPrefs(b, { [PREF.theme]: "light" })).json()) as PrefsSnapshot;
	expect(second.rev).toBe(2);
	expect(second.values[PREF.palette]).toBe("terminal");
	const third = (await (await setPrefs(a, { [PREF.lang]: "zh-CN" })).json()) as PrefsSnapshot;
	expect(third.rev).toBe(3);
	expect([third.values[PREF.palette], third.values[PREF.theme], third.values[PREF.lang]]).toEqual([
		"terminal",
		"light",
		"zh-CN",
	]);
	expect((await page(b)).snapshot).toEqual(third);
});

/** The messages a page's WebSocket receives, from the moment it is open. */
async function listen(s: AppServer): Promise<{ messages: { t: string; snapshot?: PrefsSnapshot }[]; close(): void }> {
	const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`, {
		headers: { Origin: `http://127.0.0.1:${s.port}`, Cookie: `ompw_token=${s.token}` },
	} as unknown as string[]);
	const messages: { t: string; snapshot?: PrefsSnapshot }[] = [];
	ws.onmessage = (ev) => messages.push(JSON.parse(String(ev.data)));
	await new Promise<void>((resolve, reject) => {
		ws.onopen = () => resolve();
		ws.onerror = () => reject(new Error("WebSocket refused"));
	});
	// `hello` is the first thing a server says: from here on every message is news.
	const until = Date.now() + 5000;
	while (!messages.some((m) => m.t === "hello") && Date.now() < until) await Bun.sleep(20);
	messages.length = 0;
	return { messages, close: () => ws.close() };
}

test("a change is told to every open page, and only a change that alters something", async () => {
	const s = await start(dataDir("broadcast"));
	const one = await listen(s);
	const two = await listen(s);
	const set = await setPrefs(s, { [PREF.palette]: "hermes" });
	const snapshot = (await set.json()) as PrefsSnapshot;
	const told = async (l: typeof one, n: number) => {
		const until = Date.now() + 5000;
		while (l.messages.filter((m) => m.t === "prefs").length < n && Date.now() < until) await Bun.sleep(20);
		return l.messages.filter((m) => m.t === "prefs");
	};
	expect(await told(one, 1)).toEqual([{ t: "prefs", snapshot }]);
	expect(await told(two, 1)).toEqual([{ t: "prefs", snapshot }]);

	// Neither the same value again nor a refused request is news; a later change is.
	await setPrefs(s, { [PREF.palette]: "hermes" });
	await setPrefs(s, { [PREF.theme]: "blue" });
	const later = (await (await setPrefs(s, { [PREF.theme]: "light" })).json()) as PrefsSnapshot;
	expect(later.rev).toBe(2);
	expect((await told(one, 2)).map((m) => m.snapshot?.rev)).toEqual([1, 2]);
	one.close();
	two.close();
});
