import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GuardSettings } from "../../server/guard.ts";
import { ModeStore, readModeFile } from "../../server/offline/settings.ts";
import type { HostToolCall } from "../../server/omp/host-tools.ts";
import { UnattendedStore } from "../../server/omp/unattended/store.ts";
import { UiPrefs } from "../../server/prefs.ts";
import { type SettingsBackends, SettingsCatalog } from "../../server/settings-help/catalog.ts";
import {
	type Clock,
	SETTINGS_PROMPTED_TOOLS,
	SettingsHelp,
	SettingsHelpError,
} from "../../server/settings-help/service.ts";
import type { ApprovalMode } from "../../shared/approval.ts";
import { COMPACT_KEYS } from "../../shared/compact-at.ts";
import { DEFAULT_GUARD_CONFIG } from "../../shared/guard.ts";
import { DEFAULT_OFFLINE } from "../../shared/offline.ts";
import { PREF_KEYS } from "../../shared/prefs.ts";
import { DEFAULT_REMOTE_CONFIG, parseRemoteConfigPatch, type RemoteConfig } from "../../shared/remote.ts";
import { SESSION_DEFAULTS } from "../../shared/session-defaults.ts";
import {
	classOf,
	SETTINGS_CONFIRM_MS,
	SETTINGS_GRANT_MS,
	SETTINGS_TOOL,
	type SettingsHelpState,
} from "../../shared/settings-help.ts";

/**
 * Ask agent for help's server half (`server/settings-help/`) against the real setters of the preferences, the guard,
 * Full / Light and unattended mode (in a temporary data folder) and a clock moved by hand: which setting is which kind,
 * the grant (its 30 minutes, Revoke now, the end of the process, a remote page), the person's Allow / Deny of a sensitive
 * change, the change log and Undo.
 */

// ------------------------------------------------------------------ classification

/** Every setting key the settings modules define (what `tests/unit/agent-docs-sync.test.ts` documents), and the two of this feature. */
const MODULE_KEYS = [
	...PREF_KEYS,
	...Object.keys(DEFAULT_GUARD_CONFIG).map((k) => `guard.json:${k}`),
	...Object.keys(DEFAULT_REMOTE_CONFIG).map((k) => `remote.json:${k}`),
	...Object.keys(readModeFile({ version: 2 }))
		.filter((k) => k !== "offline" && k !== "migrated")
		.map((k) => `mode.json:${k}`),
	...Object.keys(DEFAULT_OFFLINE).map((k) => `mode.json:offline.${k}`),
	...Object.keys(SESSION_DEFAULTS).map((k) => `session:${k}`),
	...Object.values(COMPACT_KEYS).map((k) => `omp:${k}`),
	"approval.json:default",
	"unattended.json:instruction",
];

/**
 * The security-sensitive settings, written out: a field added to the guard's, remote access's or another security module
 * changes what `classOf` answers (every field of those files is sensitive by rule), and this list must then be read again
 * and updated on purpose, with docs/agents/settings-help.md.
 */
const SENSITIVE = [
	"approval.json:default",
	"guard.json:askWhenDenied",
	"guard.json:askWhenUnavailable",
	"guard.json:mode",
	"guard.json:reviewer",
	"mode.json:offline.baseUrls",
	"mode.json:offline.mcp",
	"mode.json:offline.skills",
	"mode.json:offline.tools",
	"ompw.appUpdateCheck",
	"ompw.keepAwake",
	"ompw.notify",
	"ompw.unattended",
	"remote.json:aud",
	"remote.json:autostart",
	"remote.json:confirmRisky",
	"remote.json:emails",
	"remote.json:enabled",
	"remote.json:fileTransfer",
	"remote.json:hostname",
	"remote.json:remoteShell",
	"remote.json:team",
	"unattended.json:instruction",
];

describe("which setting is which kind", () => {
	test("every key of every settings module is classified", () => {
		expect(MODULE_KEYS.filter((k) => classOf(k) === null)).toEqual([]);
	});

	test("the security-sensitive settings are exactly the reviewed list", () => {
		expect(MODULE_KEYS.filter((k) => classOf(k) === "sensitive").sort()).toEqual(SENSITIVE);
	});

	test("every field of the guard's and remote access's files is sensitive, a field added later included", () => {
		for (const k of Object.keys(DEFAULT_GUARD_CONFIG)) expect(classOf(`guard.json:${k}`)).toBe("sensitive");
		for (const k of Object.keys(DEFAULT_REMOTE_CONFIG)) expect(classOf(`remote.json:${k}`)).toBe("sensitive");
		expect(classOf("guard.json:somethingNew")).toBe("sensitive");
		expect(classOf("remote.json:somethingNew")).toBe("sensitive");
	});

	test("omp's own configuration is not changeable here, and what is not a setting is unknown", () => {
		expect(classOf("omp:compaction.thresholdPercent")).toBe("unavailable");
		expect(classOf("session:autoRetry")).toBe("unavailable");
		expect(classOf("ompw.cwd")).toBe("unavailable");
		expect(classOf("ompw.nope")).toBeNull();
		expect(classOf("guard.json:")).toBeNull();
		expect(classOf("../guard.json")).toBeNull();
		expect(classOf("mode.json:offline.nope")).toBeNull();
	});

	test("the conversation asks the person before omp's tools that could write a settings file or run a command", () => {
		const prompted: readonly string[] = SETTINGS_PROMPTED_TOOLS;
		for (const tool of ["bash", "edit", "write", "eval", "python", "task"]) expect(prompted).toContain(tool);
		expect(prompted).not.toContain(SETTINGS_TOOL);
	});
});

// ------------------------------------------------------------------ the service

class FakeClock implements Clock {
	at = 1_800_000_000_000;
	private timers: { at: number; fn: () => void; live: boolean }[] = [];
	now(): number {
		return this.at;
	}
	after(ms: number, fn: () => void): () => void {
		const timer = { at: this.at + ms, fn, live: true };
		this.timers.push(timer);
		return () => {
			timer.live = false;
		};
	}
	/** Move on by `ms`, running every timer that comes due on the way. */
	advance(ms: number): void {
		this.at += ms;
		for (const timer of this.timers.filter((t) => t.live && t.at <= this.at)) {
			timer.live = false;
			timer.fn();
		}
	}
}

let dir: string;
let clock: FakeClock;
let prefs: UiPrefs;
let guard: GuardSettings;
let modes: ModeStore;
let unattended: UnattendedStore;
let remote: RemoteConfig;
let approvalMode: ApprovalMode | null;
let remotelyHeld: Set<string>;
let told: SettingsHelpState[];
let help: SettingsHelp;

function backends(): SettingsBackends {
	return {
		prefs: { values: () => prefs.snapshot().values, apply: (changes) => void prefs.apply(changes) },
		guard: { get: () => guard.get(), set: (patch) => void guard.set(patch) },
		remote: {
			get: async () => remote,
			save: async (patch) => {
				remote = { ...remote, ...parseRemoteConfigPatch(patch) };
			},
		},
		mode: {
			get: () => ({ mode: modes.mode, lightModels: modes.lightModels, offline: modes.offline }),
			update: (patch) => void modes.update(patch),
		},
		approval: {
			get: () => approvalMode,
			set: (mode) => {
				approvalMode = mode;
			},
		},
		unattended: {
			get: () => {
				const s = unattended.settings();
				return s.custom ? s.instruction : null;
			},
			set: (text) => void unattended.setInstruction(text),
		},
	};
}

function make(): SettingsHelp {
	return new SettingsHelp(
		new SettingsCatalog(backends()),
		{ dataDir: dir, folder: join(dir, "settings-help") },
		{
			open: async () => {
				throw new Error("not in this test");
			},
			heldRemotely: (liveId) => remotelyHeld.has(liveId),
			changed: (state) => {
				told.push(state);
				for (const listener of [...listeners]) listener(state);
			},
		},
		clock,
	);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompw-settings-help-"));
	clock = new FakeClock();
	prefs = new UiPrefs(dir);
	guard = new GuardSettings(dir);
	modes = new ModeStore(dir);
	unattended = new UnattendedStore(dir);
	remote = { ...DEFAULT_REMOTE_CONFIG };
	approvalMode = null;
	remotelyHeld = new Set();
	listeners.clear();
	told = [];
	help = make();
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

/** A call of the tool by conversation `liveId`; `abort` gives the call up as omp does when the turn is stopped. */
function call(liveId: string, args: unknown, abort = new AbortController()) {
	const c: HostToolCall = { liveId, name: SETTINGS_TOOL, args, signal: abort.signal };
	return help.call(c);
}

const set = (liveId: string, changes: { key: string; value: unknown }[], abort?: AbortController) =>
	call(liveId, { action: "set", changes }, abort);

/** What is told of every change of the state, besides `told`. */
const listeners = new Set<(state: SettingsHelpState) => void>();

/** The id of the first sensitive change that waits for the person, once one does (the call reads the value before it asks). */
function waitingRequest(): Promise<string> {
	const now = help.state().requests[0];
	if (now) return Promise.resolve(now.id);
	const { promise, resolve } = Promise.withResolvers<string>();
	const listener = (state: SettingsHelpState) => {
		const request = state.requests[0];
		if (!request) return;
		listeners.delete(listener);
		resolve(request.id);
	};
	listeners.add(listener);
	return promise;
}

describe("the grant", () => {
	test("a conversation that was not given access is refused, and one that was can read the settings", async () => {
		const refused = await call("L1", { action: "get" });
		expect(refused.isError).toBe(true);
		expect(refused.text).toContain("not started from Settings");

		help.grant("L1");
		const got = await call("L1", { action: "get", keys: ["ompw.theme", "guard.json:mode"] });
		expect(got.isError).toBeUndefined();
		const read = JSON.parse(got.text) as { accessEndsInMinutes: number; settings: unknown[] };
		expect(read.accessEndsInMinutes).toBe(30);
		expect(read.settings).toEqual([
			{ key: "ompw.theme", class: "normal", value: null },
			{ key: "guard.json:mode", class: "sensitive", value: "reviewer" },
		]);
		// Another conversation is not let in by the first one's access.
		expect((await call("L2", { action: "get" })).isError).toBe(true);
	});

	test("the access ends after 30 minutes: the tool then says so, and changes nothing", async () => {
		help.grant("L1");
		clock.advance(SETTINGS_GRANT_MS - 1);
		expect((await call("L1", { action: "get" })).isError).toBeUndefined();
		clock.advance(1);
		const refused = await set("L1", [{ key: "ompw.theme", value: "dark" }]);
		expect(refused.isError).toBe(true);
		expect(refused.text).toContain("30 minutes");
		expect(prefs.snapshot().values["ompw.theme"]).toBeNull();
		expect(help.state().grants).toEqual([]);
		expect(help.state().ended).toMatchObject([{ liveId: "L1", reason: "expired" }]);
	});

	test("a late timer does not keep the access: the clock decides at the call", async () => {
		help.grant("L1");
		// The clock is past the end, the timer has not run (a sleeping Mac).
		clock.at += SETTINGS_GRANT_MS + 1;
		expect((await call("L1", { action: "get" })).text).toContain("30 minutes");
	});

	test("Revoke now ends it at once, with a clear error, and denies what waited", async () => {
		help.grant("L1");
		const pending = set("L1", [{ key: "guard.json:mode", value: "off" }]);
		await waitingRequest();
		expect(help.revoke("L1", "revoked")).toBe(true);
		const result = JSON.parse((await pending).text) as { results: { outcome: string }[] };
		expect(result.results[0]?.outcome).toBe("denied");
		expect(guard.get().mode).toBe("reviewer");
		const refused = await call("L1", { action: "get" });
		expect(refused.isError).toBe(true);
		expect(refused.text).toContain("revoked");
		expect(help.revoke("L1", "revoked")).toBe(false);
	});

	test("the conversation's process ending takes the access with it", async () => {
		help.grant("L1");
		help.ended("L1");
		expect(help.state().ended).toMatchObject([{ liveId: "L1", reason: "ended" }]);
		expect((await call("L1", { action: "get" })).isError).toBe(true);
	});

	test("a conversation a remote page has been on is refused", async () => {
		help.grant("L1");
		remotelyHeld.add("L1");
		const refused = await set("L1", [{ key: "ompw.theme", value: "dark" }]);
		expect(refused.isError).toBe(true);
		expect(refused.text).toContain("not on this computer");
		expect(prefs.snapshot().values["ompw.theme"]).toBeNull();
	});

	test("a server that starts again holds no access: the grant is not kept anywhere", async () => {
		help.grant("L1");
		help = make();
		expect((await call("L1", { action: "get" })).isError).toBe(true);
	});
});

describe("changes", () => {
	beforeEach(() => {
		help.grant("L1");
	});

	test("a normal setting is changed at once through its setter, and logged as the agent's", async () => {
		const result = await set("L1", [{ key: "ompw.theme", value: "dark" }]);
		expect(result.isError).toBeUndefined();
		expect(JSON.parse(result.text)).toEqual({
			results: [{ key: "ompw.theme", outcome: "applied", old: null, new: "dark" }],
		});
		// The real store's file holds it.
		expect(new UiPrefs(dir).snapshot().values["ompw.theme"]).toBe("dark");
		expect(help.state().changes).toMatchObject([
			{ liveId: "L1", key: "ompw.theme", old: null, new: "dark", confirmedBy: "agent", undoneAt: null },
		]);
		expect(told.length).toBeGreaterThan(0);
	});

	test("a sensitive setting waits for the person: Allow applies it, logged as theirs", async () => {
		const pending = set("L1", [{ key: "guard.json:mode", value: "ask" }]);
		const id = await waitingRequest();
		expect(help.state().requests).toMatchObject([
			{ id, liveId: "L1", key: "guard.json:mode", old: "reviewer", new: "ask" },
		]);
		// Nothing is written while it waits.
		expect(guard.get().mode).toBe("reviewer");
		help.answer(id, true);
		const result = JSON.parse((await pending).text) as { results: { outcome: string }[] };
		expect(result.results[0]?.outcome).toBe("applied");
		expect(new GuardSettings(dir).get().mode).toBe("ask");
		expect(help.state().requests).toEqual([]);
		expect(help.state().changes[0]).toMatchObject({ key: "guard.json:mode", confirmedBy: "person" });
	});

	test("Deny leaves the value as it was, and logs nothing", async () => {
		const pending = set("L1", [{ key: "remote.json:remoteShell", value: false }]);
		help.answer(await waitingRequest(), false);
		const result = await pending;
		expect(result.isError).toBe(true);
		expect(JSON.parse(result.text).results[0].outcome).toBe("denied");
		expect(remote.remoteShell).toBe(true);
		expect(help.state().changes).toEqual([]);
	});

	test("no answer within the time is a Deny", async () => {
		const pending = set("L1", [{ key: "ompw.unattended", value: "on" }]);
		await waitingRequest();
		clock.advance(SETTINGS_CONFIRM_MS);
		expect(JSON.parse((await pending).text).results[0].outcome).toBe("denied");
		expect(prefs.snapshot().values["ompw.unattended"]).toBeNull();
	});

	test("a stopped turn gives the question up: denied", async () => {
		const abort = new AbortController();
		const pending = set("L1", [{ key: "approval.json:default", value: "yolo" }], abort);
		await waitingRequest();
		abort.abort();
		expect(JSON.parse((await pending).text).results[0].outcome).toBe("denied");
		expect(approvalMode).toBeNull();
	});

	test("normal and sensitive in one call: the normal one applies at once, the sensitive one waits for its own answer", async () => {
		const pending = set("L1", [
			{ key: "ompw.palette", value: "terminal" },
			{ key: "mode.json:offline.baseUrls", value: { ollama: "http://127.0.0.1:11434" } },
		]);
		await waitingRequest();
		expect(prefs.snapshot().values["ompw.palette"]).toBe("terminal");
		help.answer(help.state().requests[0]?.id, false);
		const result = JSON.parse((await pending).text) as { results: { key: string; outcome: string }[] };
		expect(result.results.map((r) => r.outcome)).toEqual(["applied", "denied"]);
		expect(modes.offline.baseUrls.ollama).toBeNull();
	});

	test("an unknown key, a key that is not changeable here, or a value the setter refuses refuses the whole call", async () => {
		for (const changes of [
			[
				{ key: "ompw.theme", value: "dark" },
				{ key: "ompw.nope", value: "x" },
			],
			[
				{ key: "ompw.theme", value: "dark" },
				{ key: "ompw.cwd", value: "/tmp" },
			],
			[
				{ key: "ompw.theme", value: "dark" },
				{ key: "omp:compaction.thresholdPercent", value: 80 },
			],
			[
				{ key: "ompw.theme", value: "dark" },
				{ key: "ompw.palette", value: "neon" },
			],
			[
				{ key: "ompw.theme", value: "dark" },
				{ key: "guard.json:mode", value: "sometimes" },
			],
			[
				{ key: "ompw.theme", value: "dark" },
				{ key: "remote.json:hostname", value: "not a host" },
			],
			[
				{ key: "ompw.theme", value: "dark" },
				{ key: "ompw.theme", value: "light" },
			],
		]) {
			const result = await set("L1", changes);
			expect(result.isError, JSON.stringify(changes)).toBe(true);
		}
		expect(prefs.snapshot().values["ompw.theme"]).toBeNull();
		expect(help.state().requests).toEqual([]);
		expect(help.state().changes).toEqual([]);
	});

	test("a value equal to the current one is left alone", async () => {
		const result = await set("L1", [{ key: "guard.json:mode", value: "reviewer" }]);
		expect(JSON.parse(result.text).results[0].outcome).toBe("unchanged");
		expect(help.state().requests).toEqual([]);
	});
});

describe("the log and undo", () => {
	beforeEach(() => {
		help.grant("L1");
	});

	test("Undo puts the old value back through the setter, once", async () => {
		await set("L1", [{ key: "ompw.theme", value: "dark" }]);
		const id = help.state().changes[0]?.id as string;
		const undone = await help.undo(id);
		expect(undone.undoneAt).toBe(clock.now());
		expect(new UiPrefs(dir).snapshot().values["ompw.theme"]).toBeNull();
		await expect(help.undo(id)).rejects.toThrow(SettingsHelpError);
	});

	test("Undo of a sensitive change restores it without asking (it is the person's own act)", async () => {
		const pending = set("L1", [{ key: "guard.json:askWhenDenied", value: false }]);
		help.answer(await waitingRequest(), true);
		await pending;
		expect(guard.get().askWhenDenied).toBe(false);
		await help.undo(help.state().changes[0]?.id);
		expect(new GuardSettings(dir).get().askWhenDenied).toBe(true);
	});

	test("Undo is refused when the setting was changed again since", async () => {
		await set("L1", [{ key: "ompw.palette", value: "terminal" }]);
		prefs.apply({ "ompw.palette": "omp" });
		await expect(help.undo(help.state().changes[0]?.id)).rejects.toThrow("changed again");
		expect(prefs.snapshot().values["ompw.palette"]).toBe("omp");
	});

	test("Undo all of a conversation goes newest first, so changes of one key unwind in order", async () => {
		await set("L1", [{ key: "ompw.palette", value: "terminal" }]);
		await set("L1", [{ key: "ompw.palette", value: "omp" }]);
		await set("L1", [{ key: "mode.json:offline.thinking", value: "high" }]);
		help.grant("L2");
		await set("L2", [{ key: "ompw.theme", value: "light" }]);
		expect(await help.undoAll("L1")).toEqual({ undone: 3, failed: [] });
		expect(prefs.snapshot().values["ompw.palette"]).toBeNull();
		expect(modes.offline.thinking).toBe("medium");
		// Another conversation's change stands.
		expect(prefs.snapshot().values["ompw.theme"]).toBe("light");
		await expect(help.undoAll("L1")).rejects.toThrow(SettingsHelpError);
	});

	test("the log outlives the server, in the data folder, and Undo still works from it", async () => {
		const pending = set("L1", [{ key: "unattended.json:instruction", value: "Stop at the first failing test." }]);
		help.answer(await waitingRequest(), true);
		expect(JSON.parse((await pending).text).results[0].outcome).toBe("applied");
		const file = JSON.parse(readFileSync(join(dir, "settings-help.json"), "utf8")) as { changes: unknown[] };
		expect(file.changes.length).toBe(help.state().changes.length);
		help = make();
		const [entry] = help.state().changes;
		expect(entry).toMatchObject({ key: "unattended.json:instruction", old: null, confirmedBy: "person" });
		await help.undo(entry?.id);
		expect(unattended.settings().custom).toBe(false);
	});
});
