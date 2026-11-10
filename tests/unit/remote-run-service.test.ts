import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HostToolServer } from "../../server/omp/host-tools.ts";
import type { RemoteRunOptions, RemoteRunResult } from "../../server/remote-run/client.ts";
import { RemoteNotSignedIn, RemoteUnsupported } from "../../server/remote-run/client.ts";
import {
	describeRun,
	notSignedIn,
	RemoteRun,
	type RemoteRunConversation,
	RemoteRunError,
	RemoteRunTools,
	WINDOWS_REFUSED,
} from "../../server/remote-run/service.ts";
import { RemoteSignIns } from "../../server/remote-run/sign-ins.ts";
import type { MacRecord } from "../../shared/macs.ts";
import type { LiveInfo } from "../../shared/protocol.ts";
import { REMOTE_RUN_TOOL } from "../../shared/remote-run.ts";
import { expectMode } from "../support/modes.ts";
import { tempDir } from "../support/temp-dirs.ts";

/**
 * Which conversations may run commands on which saved computers, and the `remote_run` tool they are served
 * (`server/remote-run/service.ts`), with stand-ins for the conversations and the remote computer: the choice kept per
 * conversation and pruned with the list, the tool given again on every change (or taken away), never given to a conversation
 * whose server tools are held for something else, refused where a page that is not the person's own has been, and what a
 * call answers. The real `Live` side is `host-tools-served.test.ts`.
 */

const dir = tempDir("ompw-remote-run-service-");
let n = 0;

const macOf = (id: string, name: string, host: string): MacRecord => ({
	id,
	name,
	host,
	lastConnected: null,
	team: null,
	storeId: "A4B2C3D4-0000-4000-8000-0123456789AB",
	added: "2026-11-10T09:00:00Z",
});
const SERVER1 = macOf("6F1C1B7E-7B7A-4E0B-9E27-0C7E0A6C1D11", "Server1", "server1.example.com");
const BUILD = macOf("0F8FAD5B-D9CB-469F-A165-70867728950E", "Build box", "build.example.com");

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const JWT = `${b64url({ alg: "RS256" })}.${b64url({ exp: Math.floor(Date.now() / 1000) + 3600 })}.c2ln`;

function infoOf(liveId: string, sessionFile: string | null): LiveInfo {
	return {
		liveId,
		pid: 1,
		cwd: "/work",
		sessionFile,
		sessionId: null,
		args: [],
		startedAt: 0,
		streaming: false,
		exited: false,
		subscribers: 0,
		pausedAt: null,
		mode: "full",
	};
}

interface FakeConversation extends RemoteRunConversation {
	hostToolServer: HostToolServer | null;
	/** What it was given, in order (null: taken away). */
	served: (HostToolServer | null)[];
}

function conversation(liveId: string, sessionFile: string | null): FakeConversation {
	const c: FakeConversation = {
		info: infoOf(liveId, sessionFile),
		hostToolServer: null,
		served: [],
		async serveHostTools(server) {
			c.served.push(server);
			c.hostToolServer = server;
		},
	};
	return c;
}

function setup(o: { run?: (o: RemoteRunOptions) => Promise<RemoteRunResult>; remote?: Set<string> } = {}) {
	const file = join(mkdtempSync(join(dir, `s${n++}-`)), "remote-run.json");
	let macs: MacRecord[] = [SERVER1, BUILD];
	const lives: FakeConversation[] = [];
	const signIns = new RemoteSignIns();
	const announced: string[] = [];
	let signedOut = 0;
	const runs: RemoteRunOptions[] = [];
	const make = () =>
		new RemoteRun({
			file,
			macs: () => macs,
			signIns,
			live: (id) => lives.find((l) => l.info.liveId === id),
			lives: () => lives,
			heldRemotely: (id) => o.remote?.has(id) ?? false,
			announce: (l) => announced.push(l.info.liveId),
			signedOut: () => signedOut++,
			run: async (opts) => {
				runs.push(opts);
				return (
					o.run?.(opts) ??
					Promise.resolve({ exitCode: 0, output: "ok\n", cut: false, timedOut: false, cancelled: false, ms: 1234 })
				);
			},
		});
	const service = make();
	const add = (liveId: string, sessionFile: string | null) => {
		const c = conversation(liveId, sessionFile);
		lives.push(c);
		return c;
	};
	return {
		file,
		service,
		make,
		add,
		signIns,
		announced,
		runs,
		signedOut: () => signedOut,
		setMacs: (next: MacRecord[]) => {
			macs = next;
		},
		stored: () =>
			JSON.parse(readFileSync(file, "utf8")) as { version: number; conversations: Record<string, string[]> },
	};
}

const signal = () => new AbortController().signal;
const namesOf = (server: HostToolServer | null | undefined) =>
	server instanceof RemoteRunTools ? server.computers : server === null ? null : undefined;
const enumOf = (server: HostToolServer | null | undefined) => {
	const params = server?.tools[0]?.parameters;
	const props = params?.properties;
	return props !== null && typeof props === "object" && "computer" in props ? props.computer : undefined;
};

describe("the choice of computers", () => {
	test("is kept per conversation in a private file, and a new service reads it", async () => {
		const s = setup();
		const c = s.add("L1", "/s/a.jsonl");
		expect(await s.service.choose(c, [SERVER1.id.toLowerCase()])).toEqual([SERVER1.id]);
		expect(s.stored()).toEqual({ version: 1, conversations: { "/s/a.jsonl": [SERVER1.id] } });
		expectMode(s.file, 0o600);
		expect(s.make().computersOf("/s/a.jsonl")).toEqual([SERVER1]);
		expect(s.make().computersOf("/s/other.jsonl")).toEqual([]);
	});

	test("an id not on the list, or what is not a list of ids, is refused with 400 and nothing is kept", async () => {
		const s = setup();
		const c = s.add("L1", "/s/a.jsonl");
		for (const bad of [["0f8fad5b-0000-469f-a165-70867728950e"], "x", [1], null])
			await expect(s.service.choose(c, bad)).rejects.toMatchObject({ status: 400 });
		expect(s.service.computersOf("/s/a.jsonl")).toEqual([]);
		expect(c.served).toEqual([]);
	});

	test("an id that left the list counts for nothing, and is forgotten when its Mac is removed", async () => {
		const s = setup();
		const c = s.add("L1", "/s/a.jsonl");
		const other = s.add("L2", "/s/b.jsonl");
		await s.service.choose(c, [SERVER1.id, BUILD.id]);
		await s.service.choose(other, [BUILD.id]);
		s.setMacs([SERVER1]);
		expect(s.service.computersOf("/s/a.jsonl")).toEqual([SERVER1]);
		await s.service.forget(BUILD.id);
		expect(s.stored().conversations).toEqual({ "/s/a.jsonl": [SERVER1.id] });
		// The conversations that run are served without it at once; one left with none loses the tool.
		expect(namesOf(c.hostToolServer)).toEqual(["Server1"]);
		expect(other.hostToolServer).toBeNull();
		expect(other.info.remoteComputers).toBeUndefined();
	});

	test("follows the conversation to another session file, unless that one has its own", async () => {
		const s = setup();
		const c = s.add("L1", "/s/a.jsonl");
		await s.service.choose(c, [SERVER1.id]);
		s.service.moved("/s/a.jsonl", "/s/a-1.jsonl");
		expect(s.service.computersOf("/s/a-1.jsonl")).toEqual([SERVER1]);
		const d = s.add("L2", "/s/b.jsonl");
		await s.service.choose(d, [BUILD.id]);
		s.service.moved("/s/a.jsonl", "/s/b.jsonl");
		expect(s.service.computersOf("/s/b.jsonl")).toEqual([BUILD]);
	});

	test("a conversation without a session file yet cannot be given any", async () => {
		const s = setup();
		await expect(s.service.choose(s.add("L1", null), [SERVER1.id])).rejects.toMatchObject({ status: 409 });
	});
});

describe("the tool", () => {
	test("is served with the chosen computers' names, served again on every change, and taken away when none is left", async () => {
		const s = setup();
		const c = s.add("L1", "/s/a.jsonl");
		await s.service.choose(c, [SERVER1.id]);
		expect(c.hostToolServer?.tools.map((t) => t.name)).toEqual([REMOTE_RUN_TOOL]);
		expect(enumOf(c.hostToolServer)).toMatchObject({ enum: ["Server1"] });
		expect(c.info.remoteComputers).toEqual([SERVER1.id]);
		expect(c.hostToolServer?.readOnly).toEqual([]);

		await s.service.choose(c, [BUILD.id, SERVER1.id]);
		// In the list's order.
		expect(enumOf(c.hostToolServer)).toMatchObject({ enum: ["Server1", "Build box"] });
		expect(c.info.remoteComputers).toEqual([SERVER1.id, BUILD.id]);

		// A rename on the list reaches the conversation that runs.
		s.setMacs([{ ...SERVER1, name: "Web" }, BUILD]);
		await s.service.macsChanged();
		expect(enumOf(c.hostToolServer)).toMatchObject({ enum: ["Web", "Build box"] });
		// A change of the list that changes no name (a sign-in, a connection) tells omp nothing.
		const served = c.served.length;
		await s.service.macsChanged();
		expect(c.served.length).toBe(served);

		await s.service.choose(c, []);
		expect(c.served.at(-1)).toBeNull();
		expect(c.info.remoteComputers).toBeUndefined();
		expect(s.stored().conversations).toEqual({});
		// Told each time what it has changed: two choices, and none.
		expect(s.announced).toEqual(["L1", "L1", "L1"]);
	});

	test("a conversation given computers is served when its process starts; one given none is not touched", async () => {
		const s = setup();
		const c = s.add("L1", "/s/a.jsonl");
		await s.service.choose(c, [SERVER1.id]);
		const resumed = conversation("L2", "/s/a.jsonl");
		await s.service.started(resumed);
		expect(namesOf(resumed.hostToolServer)).toEqual(["Server1"]);
		expect(resumed.info.remoteComputers).toEqual([SERVER1.id]);
		const plain = conversation("L3", "/s/new.jsonl");
		await s.service.started(plain);
		expect(plain.served).toEqual([]);
		expect(plain.info.remoteComputers).toBeUndefined();
	});

	test("never served to a conversation whose server tools are held for something else, and choosing is refused with 409", async () => {
		const s = setup();
		const c = s.add("L1", "/s/a.jsonl");
		const helper: HostToolServer = { tools: [], readOnly: [], call: async () => ({ text: "" }), ended: () => {} };
		c.hostToolServer = helper;
		await expect(s.service.choose(c, [SERVER1.id])).rejects.toBeInstanceOf(RemoteRunError);
		await expect(s.service.choose(c, [SERVER1.id])).rejects.toMatchObject({ status: 409 });
		expect(c.served).toEqual([]);
		// Even when a choice was kept for its file (from an earlier process), its process is not served.
		const free = conversation("L9", "/s/a.jsonl");
		await s.service.choose(free, [SERVER1.id]);
		await s.service.started(c);
		expect(c.served).toEqual([]);
		expect(c.hostToolServer).toBe(helper);
	});
});

describe("a call", () => {
	async function given(o: Parameters<typeof setup>[0] = {}) {
		const s = setup(o);
		const c = s.add("L1", "/s/a.jsonl");
		await s.service.choose(c, [SERVER1.id, BUILD.id]);
		const call = (args: unknown, sig = signal()) =>
			s.service.call({ liveId: "L1", name: REMOTE_RUN_TOOL, args, signal: sig });
		return { ...s, c, call };
	}

	test("runs on the named computer with its sign-in, and says what came of it", async () => {
		const s = await given();
		s.signIns.set(SERVER1.id, JWT);
		const sig = signal();
		const r = await s.call({ computer: "Server1", command: "uname -a", cwd: "/srv", timeout: 30 }, sig);
		expect(r).toEqual({ text: "Server1 · exit 0 · 1.2s\nok\n" });
		expect(s.runs).toEqual([
			{ host: "server1.example.com", jwt: JWT, command: "uname -a", cwd: "/srv", timeoutMs: 30_000, signal: sig },
		]);
		// The token is in no part of what the agent is told.
		expect(JSON.stringify(r)).not.toContain(JWT);
	});

	test("a command that fails, times out or is cut is an error result that says so", async () => {
		const results: RemoteRunResult[] = [
			{ exitCode: 2, output: "no\n", cut: false, timedOut: false, cancelled: false, ms: 50 },
			{ exitCode: null, output: "started\n", cut: true, timedOut: true, cancelled: false, ms: 120_000 },
		];
		const s = await given({ run: async () => results.shift() as RemoteRunResult });
		s.signIns.set(BUILD.id, JWT);
		expect(await s.call({ computer: "Build box", command: "false" })).toEqual({
			text: "Build box · exit 2 · 0.1s\nno\n",
			isError: true,
		});
		expect(await s.call({ computer: "Build box", command: "sleep 9999" })).toEqual({
			text: "Build box · no exit code · 120.0s · timed out · output cut to the last 64 KB\nstarted\n",
			isError: true,
		});
	});

	test("a computer not signed in, or whose sign-in the computer refuses, says to sign in again; the refused one is forgotten", async () => {
		const s = await given({
			run: async () => {
				throw new RemoteNotSignedIn("refused");
			},
		});
		expect(await s.call({ computer: "Server1", command: "ls" })).toEqual({
			text: notSignedIn("Server1"),
			isError: true,
		});
		expect(s.runs).toEqual([]);
		s.signIns.set(SERVER1.id, JWT);
		expect(await s.call({ computer: "Server1", command: "ls" })).toEqual({
			text: notSignedIn("Server1"),
			isError: true,
		});
		expect(s.signIns.get(SERVER1.id)).toBeNull();
		expect(s.signedOut()).toBe(1);
		expect(notSignedIn("Server1")).toBe(
			"Server1: not signed in (or the sign-in has lapsed). Open its window from the Macs list and sign in, then try again.",
		);
	});

	test("a Windows computer is refused in words", async () => {
		const s = await given({
			run: async () => {
				throw new RemoteUnsupported("win32");
			},
		});
		s.signIns.set(SERVER1.id, JWT);
		expect(await s.call({ computer: "Server1", command: "dir" })).toEqual({ text: WINDOWS_REFUSED, isError: true });
	});

	test("is refused in a conversation a page that is not the person's own has been on, before anything runs", async () => {
		const s = await given({ remote: new Set(["L1"]) });
		s.signIns.set(SERVER1.id, JWT);
		const r = await s.call({ computer: "Server1", command: "ls" });
		expect(r.isError).toBe(true);
		expect(r.text).toContain("not the person's own");
		expect(s.runs).toEqual([]);
	});

	test("names only the conversation's computers as they are now", async () => {
		const s = await given();
		s.signIns.set(SERVER1.id, JWT);
		const unknown = await s.call({ computer: "Elsewhere", command: "ls" });
		expect(unknown.isError).toBe(true);
		expect(unknown.text).toContain('"Server1", "Build box"');
		await s.service.choose(s.c, [BUILD.id]);
		expect((await s.call({ computer: "Server1", command: "ls" })).isError).toBe(true);
		await s.service.choose(s.c, []);
		const none = await s.call({ computer: "Build box", command: "ls" });
		expect(none.text).toContain("no remote computers");
		expect(s.runs).toEqual([]);
	});

	test("describeRun says when the shell ended early, or the call was cancelled", () => {
		const base = { output: "x", cut: false, timedOut: false, ms: 0 };
		expect(describeRun("A", { ...base, exitCode: null, cancelled: true })).toBe(
			"A · no exit code · 0.0s · cancelled\nx",
		);
		expect(describeRun("A", { ...base, exitCode: null, cancelled: false })).toBe(
			"A · no exit code · 0.0s · the shell ended before the command did\nx",
		);
	});
});
