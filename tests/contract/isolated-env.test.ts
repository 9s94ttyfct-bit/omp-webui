// needs: isolatedEnvironment
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { LiveInfo } from "../../shared/protocol.ts";
import { pollUntil } from "../support/poll.ts";
import { proxiedClient } from "../support/remote-client.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { connect, request } from "../support/ws.ts";

/**
 * A project folder's isolated environment (docs/superpowers/specs/2026-11-14-isolated-project-env-design.md): New chat
 * switches it for the folder before omp starts there, and omp (and what it runs) gets the variables that keep installs and
 * downloads inside the folder. No model is called: omp's own `!` bash shows the environment.
 */

let s: TestServer;

beforeAll(async () => {
	s = await startTestServer();
}, 90_000);
afterAll(async () => {
	await s?.stop();
});

const env = async (ws: WebSocket, liveId: string, name: string): Promise<string> => {
	const ran = await request<{ output?: string }>(ws, {
		t: "rpc",
		liveId,
		command: { type: "bash", command: `printf %s "$${name}"` },
	});
	return String(ran.output ?? "").trim();
};

const listed = async (ws: WebSocket, liveId: string) =>
	(await request<LiveInfo[]>(ws, { t: "list_lives" })).find((l) => l.liveId === liveId);

test("a folder switched on in New chat runs omp isolated; switched off, the process started before says it needs a restart", async () => {
	const folder = join(s.work, "iso-project");
	mkdirSync(folder, { recursive: true });
	const real = realpathSync(folder);
	const ws = await connect(s);
	const on = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: folder, isolated: true } });
	expect(existsSync(join(real, ".ompw-env", "ompw-env.json"))).toBe(true);
	expect(on.isolated).toBe(real);
	expect(await env(ws, on.liveId, "CARGO_HOME")).toBe(join(real, ".ompw-env", "cargo"));
	expect(await env(ws, on.liveId, "HF_HUB_CACHE")).toBe(join(real, ".ompw-env", "huggingface", "hub"));
	expect(await env(ws, on.liveId, "OMPW_ISOLATED_NOTE")).toContain("Isolated project environment");
	// A program a global install puts in the project is found first by omp's own commands.
	expect((await env(ws, on.liveId, "PATH")).split(":")[0]).toBe(join(real, ".ompw-env", "npm", "bin"));

	// Another New chat in the same folder, switched off: the folder is no longer isolated, and the first process, which still
	// runs with it, says a restart applies the change.
	const off = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: folder, isolated: false } });
	expect(off.liveId).not.toBe(on.liveId);
	expect(off.isolated).toBeUndefined();
	expect(await env(ws, off.liveId, "CARGO_HOME")).not.toContain(".ompw-env");
	expect((await listed(ws, on.liveId))?.isolationStale).toBe(true);
	for (const id of [on.liveId, off.liveId]) await request(ws, { t: "close", liveId: id }).catch(() => {});
	ws.close();
}, 120_000);

test("a warm-up process left by a page is not handed to a New chat that switched the folder's isolation", async () => {
	const folder = join(s.work, "iso-spare");
	mkdirSync(folder, { recursive: true });
	const first = await connect(s);
	const plain = await request<LiveInfo>(first, { t: "open", target: { kind: "new", cwd: folder } });
	first.close();
	const second = await connect(s);
	const isolated = await request<LiveInfo>(second, { t: "open", target: { kind: "new", cwd: folder, isolated: true } });
	expect(isolated.liveId).not.toBe(plain.liveId);
	expect(isolated.isolated).toBe(realpathSync(folder));
	await request(second, { t: "close", liveId: isolated.liveId }).catch(() => {});
	await request(second, { t: "close", liveId: plain.liveId }).catch(() => {});
	second.close();
}, 120_000);

test("the home folder cannot be made isolated, and the reason comes back", async () => {
	const ws = await connect(s);
	await expect(
		request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: s.home, isolated: true } }),
	).rejects.toThrow(/cannot have an isolated environment/);
	const state = (await (
		await fetch(`${s.url}/api/isolation?folder=${encodeURIComponent(s.home)}`, {
			headers: { "x-omp-webui-token": s.accessToken },
		})
	).json()) as { root: string | null; refused: string | null };
	expect(state).toMatchObject({ root: null, refused: "protected" });
	ws.close();
}, 60_000);

test("a running conversation's folder is switched from This session: the process says a restart applies it; a remote page and the home folder are refused", async () => {
	const folder = join(s.work, "iso-later");
	mkdirSync(folder, { recursive: true });
	const real = realpathSync(folder);
	const ws = await connect(s);
	const live = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: folder } });
	expect(live.isolated).toBeUndefined();

	// A page that is not the person's own changes nothing.
	const phone = await proxiedClient(s).socket();
	if (!phone) throw new Error("the proxied page could not connect");
	await expect(request(phone, { t: "set_isolation", liveId: live.liveId, on: true })).rejects.toThrow(
		/switched on the computer omp-webui runs on/,
	);
	phone.close();
	expect(existsSync(join(real, ".ompw-env", "ompw-env.json"))).toBe(false);

	// The person's page switches the folder on: the process keeps what it started with and says a restart applies it.
	const after = await request<LiveInfo>(ws, { t: "set_isolation", liveId: live.liveId, on: true });
	expect(existsSync(join(real, ".ompw-env", "ompw-env.json"))).toBe(true);
	expect(after.isolationStale).toBe(true);
	expect((await listed(ws, live.liveId))?.isolationStale).toBe(true);
	expect(await env(ws, live.liveId, "CARGO_HOME")).not.toContain(".ompw-env");
	// Switched off again, the folder is what the process has: nothing to apply.
	const back = await request<LiveInfo>(ws, { t: "set_isolation", liveId: live.liveId, on: false });
	expect(back.isolationStale).toBeUndefined();
	await request(ws, { t: "close", liveId: live.liveId }).catch(() => {});

	const home = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: s.home } });
	await expect(request(ws, { t: "set_isolation", liveId: home.liveId, on: true })).rejects.toThrow(
		/cannot have an isolated environment/,
	);
	await request(ws, { t: "close", liveId: home.liveId }).catch(() => {});
	ws.close();
}, 120_000);

test("the Terminal tab of an isolated folder has the variables, with the project's programs first after the login shell's startup", async () => {
	const folder = join(s.work, "iso-terminal");
	mkdirSync(folder, { recursive: true });
	const real = realpathSync(folder);
	const ws = await connect(s);
	const opened = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: folder, isolated: true } });
	let out = "";
	ws.addEventListener("message", (ev) => {
		const m = JSON.parse(String(ev.data));
		if (m.t === "pty_data") out += m.data;
	});
	const { ptyId } = await request<{ ptyId: string }>(ws, {
		t: "pty_open",
		args: [],
		cwd: folder,
		shell: true,
		cols: 200,
		rows: 30,
	});
	await pollUntil(() => out.length > 0, "the shell printed its prompt");
	// biome-ignore lint/suspicious/noTemplateCurlyInString: the shell's own parameter expansion, typed into the terminal.
	ws.send(JSON.stringify({ t: "pty_input", ptyId, data: 'printf "FIRST=%s GOPATH=%s\\n" "${PATH%%:*}" "$GOPATH"\r' }));
	const want = `FIRST=${join(real, ".ompw-env", "npm", "bin")} GOPATH=${join(real, ".ompw-env", "go")}`;
	await pollUntil(() => out.includes(want), `the terminal printed ${want}`, 20_000);
	ws.send(JSON.stringify({ t: "pty_kill", ptyId }));
	await request(ws, { t: "close", liveId: opened.liveId }).catch(() => {});
	ws.close();
}, 120_000);
