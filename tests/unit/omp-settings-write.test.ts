import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OmpLifecycle } from "../../server/omp/lifecycle.ts";
import type { ServerMessage } from "../../shared/protocol.ts";
import { fakeConfig } from "../support/fake-omp.ts";

/**
 * The lifecycle's two kept settings (`<data dir>/omp.json`). A change that could not be written is refused for good:
 * the request fails, and nothing acts on the value it asked for (#447). The write goes through `omp.json.tmp`, so a
 * directory of that name is what makes it fail here, as a full disk or a read-only data dir does in life.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-omp-settings-"));
let n = 0;
afterAll(() => rmSync(root, { recursive: true, force: true }));

function unwritable(kept?: object) {
	const dir = join(root, `case${++n}`);
	mkdirSync(join(dir, "omp.json.tmp"), { recursive: true });
	if (kept) writeFileSync(join(dir, "omp.json"), JSON.stringify(kept));
	const sent: ServerMessage[] = [];
	const omp = new OmpLifecycle(
		fakeConfig(dir, "omp"),
		{
			busy: () => ({ working: 0, asking: 0, paused: 0 }),
			activate: async () => "unused",
			broadcast: (m) => sent.push(m),
		},
		{ env: { PATH: "", HOME: dir }, home: dir, checkEnabled: false, tickMs: 15 },
	);
	return { dir, omp, sent };
}

test("automatic updates stay off when the choice could not be saved", () => {
	const { omp, sent } = unwritable();
	expect(() => omp.setAutoUpdate(true)).toThrow();
	expect(omp.snapshot().state.autoUpdate).toBe(false);
	// Nothing was announced as changed either: a page would show the box ticked.
	expect(sent.filter((m) => m.t === "omp")).toEqual([]);
});

test("the first-time setup stays pending when finishing it could not be saved", () => {
	const { omp } = unwritable({ autoUpdate: false, onboarding: true });
	expect(omp.snapshot().state.onboarding).toBe(true);
	expect(() => omp.setOnboarding(false)).toThrow();
	expect(omp.snapshot().state.onboarding).toBe(true);
});

test("a change that could be saved is applied, announced and kept", () => {
	const dir = join(root, `case${++n}`);
	mkdirSync(dir, { recursive: true });
	const sent: ServerMessage[] = [];
	const omp = new OmpLifecycle(
		fakeConfig(dir, "omp"),
		{
			busy: () => ({ working: 0, asking: 0, paused: 0 }),
			activate: async () => "unused",
			broadcast: (m) => sent.push(m),
		},
		{ env: { PATH: "", HOME: dir }, home: dir, checkEnabled: false, tickMs: 15 },
	);
	omp.setAutoUpdate(true);
	expect(omp.snapshot().state.autoUpdate).toBe(true);
	expect(JSON.parse(readFileSync(join(dir, "omp.json"), "utf8"))).toEqual({ autoUpdate: true, onboarding: false });
	expect(sent.some((m) => m.t === "omp" && m.state.autoUpdate)).toBe(true);
});
