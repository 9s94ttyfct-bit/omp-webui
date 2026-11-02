import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalStore, ProcessOverlay } from "../../server/omp/approval.ts";
import { type ParkedRecord, ParkedStore } from "../../server/omp/parked.ts";
import { ADVISOR_KEY, advisorOf } from "../../shared/advisor.ts";
import { choiceOf, configKey, defaultWrites, matchesDefault } from "../../shared/session-defaults.ts";

/**
 * The advisor per conversation (omp's `advisor.enabled`): a conversation's own choice is a line of its process's overlay,
 * over omp's configuration and over what the process is held at for another conversation's default; it is kept by session
 * file and in the record of a paused conversation, and the session panel's star writes omp's own setting.
 */

const dirs: string[] = [];
const scratch = () => {
	const dir = mkdtempSync(join(tmpdir(), "ompw-advisor-"));
	dirs.push(dir);
	return dir;
};
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const advisorIn = (file: string): unknown => {
	const yaml = Bun.YAML.parse(readFileSync(file, "utf8")) as { advisor?: Record<string, unknown> } | null;
	return yaml?.advisor?.enabled;
};

test("a choice is true or false, and nothing else is one", () => {
	expect(advisorOf(true)).toBe(true);
	expect(advisorOf(false)).toBe(false);
	for (const bad of ["true", 1, null, undefined, {}]) expect(advisorOf(bad)).toBeNull();
});

test("a conversation's choice is an `advisor.enabled` line of its overlay, over what the process is held at", async () => {
	const file = join(scratch(), "L1.yml");
	const overlay = new ProcessOverlay(file, null, 0);
	expect(advisorIn(file)).toBeUndefined();
	expect(Object.hasOwn(overlay.settings, ADVISOR_KEY)).toBe(false);

	await overlay.setAdvisor(false);
	expect(overlay.settings[ADVISOR_KEY]).toBe(false);
	expect(advisorIn(file)).toBe(false);

	// Another conversation made a default: this process is held at what it had, but its own choice stays on top.
	await overlay.pin({ [ADVISOR_KEY]: true });
	expect(overlay.settings[ADVISOR_KEY]).toBe(false);
	expect(advisorIn(file)).toBe(false);

	await overlay.setAdvisor(true);
	expect(advisorIn(file)).toBe(true);

	// No choice of its own: what it is held at again.
	await overlay.setAdvisor(null);
	expect(overlay.advisor).toBeNull();
	expect(overlay.settings[ADVISOR_KEY]).toBe(true);
});

test("an overlay made for a new or a resumed process starts with the conversation's choice", async () => {
	const data = scratch();
	const store = new ApprovalStore("omp", data, 0);
	const made = await store.create("L1", null, null, null, [], undefined, [], null, null, false);
	expect(advisorIn(made.file)).toBe(false);
	made.remove();
	const restored = store.restore(join(scratch(), "L2.yml"), null, null, null, [], {}, [], null, null, true);
	expect(restored.advisor).toBe(true);
	expect(advisorIn(restored.file)).toBe(true);
});

test("the choice is kept by session file, survives a new server, and null forgets it", () => {
	const data = scratch();
	const store = new ApprovalStore("omp", data, 0);
	expect(store.sessionAdvisor("/s/a.jsonl")).toBeNull();
	store.rememberAdvisor("/s/a.jsonl", false);
	store.rememberAdvisor("/s/b.jsonl", true);
	const next = new ApprovalStore("omp", data, 0);
	expect(next.sessionAdvisor("/s/a.jsonl")).toBe(false);
	expect(next.sessionAdvisor("/s/b.jsonl")).toBe(true);
	next.rememberAdvisor("/s/a.jsonl", null);
	expect(next.sessionAdvisor("/s/a.jsonl")).toBeNull();
	expect(next.sessionAdvisor("/s/b.jsonl")).toBe(true);
});

test("a paused conversation's record keeps its choice; one that is not a choice is none", () => {
	const data = scratch();
	const store = new ParkedStore(data);
	const base: ParkedRecord = {
		version: 2,
		liveId: "L1",
		omp: { pid: 1, identity: "a" },
		relay: { pid: 2, identity: "b" },
		socket: "/tmp/x.sock",
		owner: null,
		cwd: "/",
		args: [],
		env: {},
		mode: "full",
		startedAt: 0,
		pausedAt: 1,
		sessionFile: null,
		sessionId: null,
		streaming: false,
		overlay: { file: "/tmp/L1.yml", mode: null, advisor: false },
		interviewing: false,
		pendingUI: [],
		descendants: [],
	};
	store.save(base);
	store.save({
		...base,
		liveId: "L2",
		pausedAt: 2,
		overlay: { file: "/tmp/L2.yml", mode: null, advisor: "yes" as unknown as boolean },
	});
	const [first, second] = store.list();
	expect(first.overlay?.advisor).toBe(false);
	expect(second.overlay?.advisor).toBeNull();
});

test("the session panel's star writes omp's `advisor.enabled`, and a row on the configured value is the default", () => {
	expect(defaultWrites("advisor", "off")).toEqual([{ key: ADVISOR_KEY, value: false }]);
	expect(defaultWrites("advisor", "on")).toEqual([{ key: ADVISOR_KEY, value: true }]);
	expect(defaultWrites("advisor", "maybe")).toBeNull();
	expect(configKey("advisor")).toBe(ADVISOR_KEY);
	expect(choiceOf("advisor", false)).toBe("off");
	expect(matchesDefault("advisor", "on", null, { [ADVISOR_KEY]: true })).toBe(true);
	expect(matchesDefault("advisor", "off", null, { [ADVISOR_KEY]: true })).toBe(false);
});
