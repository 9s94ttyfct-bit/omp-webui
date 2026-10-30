import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import compactStep, { afterToolStep } from "../../server/omp/compact-step/extension.ts";
import {
	COMPACT_STEP_DIALOG_CONTINUE,
	COMPACT_STEP_DIALOG_TITLE,
	COMPACT_STEP_FILE_ENV,
	COMPACT_STEP_LOADED_SUFFIX,
	compactStepFileText,
	parseCompactStepFile,
} from "../../shared/compact-step.ts";

/**
 * The extension that holds a step boundary for a queued compact (#651), as omp drives it, with a stand-in for omp's extension
 * API. What is measured: it holds only at the moment between a step's tools and the next model request, only for the main agent
 * and only while the file asks; the hold ends when the file is taken away or rewritten, or when the server answers; it says that
 * it started.
 */

type Handler = (event: unknown, ctx: unknown) => Promise<undefined>;

interface Dialog {
	title: string;
	options: string[];
	aborted: boolean;
	answer(value: string | undefined): void;
}

function fakeOmp() {
	let context: Handler | undefined;
	const pi = {
		on(event: string, handler: Handler) {
			if (event === "context") context = handler;
		},
	};
	const dialogs: Dialog[] = [];
	const ctx = (over: { kind?: string; hasUI?: boolean } = {}) => ({
		hasUI: over.hasUI ?? true,
		agent: { kind: over.kind ?? "main" },
		ui: {
			select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined> {
				const { promise, resolve } = Promise.withResolvers<string | undefined>();
				const dialog: Dialog = { title, options, aborted: false, answer: resolve };
				dialogs.push(dialog);
				opts?.signal?.addEventListener("abort", () => {
					dialog.aborted = true;
					resolve(undefined);
				});
				return promise;
			},
		},
	});
	return { pi, dialogs, ctx, run: (messages: unknown[], c = ctx()) => context?.({ messages }, c) };
}

const CALL = { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }] };
const RESULT = { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "ok" }] };
const BOUNDARY = [{ role: "user", content: "go" }, CALL, RESULT];

let dir: string;
let file: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompw-compact-step-ext-"));
	file = join(dir, "overlay.yml.compactstep");
	process.env[COMPACT_STEP_FILE_ENV] = file;
});
afterEach(() => {
	delete process.env[COMPACT_STEP_FILE_ENV];
	rmSync(dir, { recursive: true, force: true });
});

const until = async (condition: () => boolean) => {
	const deadline = performance.now() + 5000;
	while (!condition()) {
		if (performance.now() > deadline) throw new Error("the condition never held");
		await new Promise((r) => setTimeout(r, 5));
	}
};

describe("the file", () => {
	test("is a request named by its time, and nothing else is one", () => {
		expect(parseCompactStepFile(compactStepFileText(42))).toEqual({ at: 42 });
		for (const bad of [
			"",
			"not json",
			"[]",
			"{}",
			'{"wanted":false,"at":1}',
			'{"wanted":true}',
			'{"wanted":true,"at":"1"}',
		])
			expect(parseCompactStepFile(bad), bad).toBeNull();
	});
});

describe("afterToolStep", () => {
	test("is true only where an assistant message called tools and results follow it", () => {
		expect(afterToolStep(BOUNDARY)).toBe(true);
		expect(afterToolStep([...BOUNDARY, { role: "toolResult", content: "more" }])).toBe(true);
		// The first request of a turn, a call whose results are not in yet, an answer that asked for no tool.
		expect(afterToolStep([{ role: "user", content: "go" }])).toBe(false);
		expect(afterToolStep([{ role: "user", content: "go" }, CALL])).toBe(false);
		expect(
			afterToolStep([
				{ role: "user", content: "go" },
				{ role: "assistant", content: [{ type: "text", text: "hi" }] },
			]),
		).toBe(false);
		expect(afterToolStep([])).toBe(false);
		// The last assistant message decides: an older step's results do not make a later answer a boundary.
		expect(afterToolStep([...BOUNDARY, { role: "assistant", content: [{ type: "text", text: "done" }] }])).toBe(false);
	});
});

describe("the hold", () => {
	test("says that it started, once its handler is in", () => {
		const omp = fakeOmp();
		compactStep(omp.pi as never);
		expect(existsSync(`${file}${COMPACT_STEP_LOADED_SUFFIX}`)).toBe(true);
	});

	test("with no file named it does nothing and says nothing", async () => {
		delete process.env[COMPACT_STEP_FILE_ENV];
		const omp = fakeOmp();
		compactStep(omp.pi as never);
		expect(await omp.run(BOUNDARY)).toBeUndefined();
		expect(omp.dialogs).toEqual([]);
		expect(existsSync(`${file}${COMPACT_STEP_LOADED_SUFFIX}`)).toBe(false);
	});

	test("waits at a boundary while the file asks, in the dialog the server takes, and ends when the server answers", async () => {
		const omp = fakeOmp();
		compactStep(omp.pi as never);
		writeFileSync(file, compactStepFileText(1));
		let done = false;
		const held = omp.run(BOUNDARY)?.then(() => {
			done = true;
		});
		await until(() => omp.dialogs.length === 1);
		expect(omp.dialogs[0]).toMatchObject({ title: COMPACT_STEP_DIALOG_TITLE, options: [COMPACT_STEP_DIALOG_CONTINUE] });
		await new Promise((r) => setTimeout(r, 30));
		expect(done).toBe(false);
		omp.dialogs[0]?.answer(COMPACT_STEP_DIALOG_CONTINUE);
		await held;
		expect(done).toBe(true);
	});

	test("ends when the request is taken away or is another one", async () => {
		for (const change of [() => rmSync(file), () => writeFileSync(file, compactStepFileText(2))]) {
			const omp = fakeOmp();
			compactStep(omp.pi as never);
			writeFileSync(file, compactStepFileText(1));
			const held = omp.run(BOUNDARY);
			await until(() => omp.dialogs.length === 1);
			change();
			await held;
			expect(omp.dialogs[0]?.aborted).toBe(true);
		}
	});

	test("waits for nothing when no request stands, away from a boundary, in a subagent, or without a UI", async () => {
		const omp = fakeOmp();
		compactStep(omp.pi as never);
		await omp.run(BOUNDARY);
		writeFileSync(file, compactStepFileText(1));
		await omp.run([{ role: "user", content: "go" }]);
		await omp.run([{ role: "user", content: "go" }, CALL]);
		await omp.run(BOUNDARY, omp.ctx({ kind: "sub" }));
		await omp.run(BOUNDARY, omp.ctx({ hasUI: false }));
		expect(omp.dialogs).toEqual([]);
	});

	test("a request that is damaged is none", async () => {
		const omp = fakeOmp();
		compactStep(omp.pi as never);
		writeFileSync(file, "{not json");
		await omp.run(BOUNDARY);
		expect(omp.dialogs).toEqual([]);
	});
});
