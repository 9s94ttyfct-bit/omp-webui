import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../server/config.ts";
import { ModeService } from "../../server/offline/index.ts";
import type { ModeState } from "../../shared/offline.ts";
import { modeSuperseded } from "../../web/src/lib/offline-format.ts";

/**
 * The mode reaches a page twice over: announced on the socket when anything changes, and as the answer to a request.
 * The answer is the state as of the moment the server handled the request and travels on another connection, so it can
 * arrive after an announcement that is newer: taking it would show the old state (a stale checkbox) and build the next
 * save from it. The server numbers every state it says, and a page drops one that is older than the one it holds (#303).
 */

let root: string;
let cfg: Config;
let svc: ModeService;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "ompw-mode-order-"));
	cfg = {
		ompBin: "omp",
		agentDir: join(root, "user"),
		sessionsDir: join(root, "user", "sessions"),
		dataDir: join(root, "data"),
		host: "127.0.0.1",
		port: 0,
		distDir: root,
		autoPort: false,
		parentPid: null,
	};
	mkdirSync(cfg.agentDir, { recursive: true });
	mkdirSync(cfg.dataDir, { recursive: true });
	writeFileSync(join(cfg.agentDir, "mcp.json"), JSON.stringify({ mcpServers: { a: {}, b: {} } }));
	svc = new ModeService(cfg);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("every state the server says is numbered after the one before, within one run", () => {
	const first = svc.state();
	const announced: ModeState[] = [];
	svc.onChange((s) => announced.push(s));
	const answer = svc.update({ offline: { mcp: ["b"] } });
	const read = svc.state();
	expect(first.boot).toBeTruthy();
	expect([answer.boot, read.boot, announced[0]?.boot]).toEqual([first.boot, first.boot, first.boot]);
	// A read made before the change is older than the announcement and the answer; one made after is newer.
	expect(first.rev).toBeLessThan(announced[0]?.rev ?? 0);
	expect(announced[0]).toBe(answer);
	expect(read.rev).toBeGreaterThan(answer.rev);
	// Asking again changes nothing but the number.
	expect(svc.state().rev).toBeGreaterThan(read.rev);
});

test("a change is announced with a state that already holds it, each numbered after the last", () => {
	const announced: ModeState[] = [];
	svc.onChange((s) => announced.push(s));
	svc.update({ offline: { mcp: ["a", "b"] } });
	svc.update({ offline: { mcp: ["a"] } });
	expect(announced.map((s) => s.offline.mcp)).toEqual([["a", "b"], ["a"]]);
	expect(announced[1]?.rev).toBeGreaterThan(announced[0]?.rev ?? 0);
});

test("another run of the server is a new boot, so its numbers are not compared with the old run's", () => {
	expect(new ModeService(cfg).state().boot).not.toBe(svc.state().boot);
});

const state = (boot: string, rev: number): ModeState => ({ ...svc.state(), boot, rev });

test("a page drops a state older than the one it holds, takes an equal or newer one, and takes any from a new run", () => {
	expect(modeSuperseded(null, state("a", 1))).toBe(false);
	expect(modeSuperseded(state("a", 5), state("a", 4))).toBe(true);
	expect(modeSuperseded(state("a", 5), state("a", 5))).toBe(false);
	expect(modeSuperseded(state("a", 5), state("a", 6))).toBe(false);
	// The server restarted: its numbers begin again, and the new run's first state is the newest there is.
	expect(modeSuperseded(state("a", 50), state("b", 1))).toBe(false);
});
