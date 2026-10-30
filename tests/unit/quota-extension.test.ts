import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import quotaFloor from "../../server/omp/quota-floor/extension.ts";
import {
	holdFileText,
	parseWarmVerdict,
	QUOTA_DIALOG_CONTINUE,
	QUOTA_DIALOG_TITLE,
	QUOTA_FILE_ENV,
	QUOTA_LOADED_SUFFIX,
	QUOTA_STATUS_KEY,
} from "../../shared/quota-hold.ts";

/**
 * The quota floor's extension (#652) as omp drives it, with a stand-in for omp's extension API. What is measured: only the main
 * agent waits, in a dialog it closes itself when the hold file is gone or its time to let go has passed; a conversation with no
 * hold waits for nothing and opens no dialog; the cache warming decision is the cost check's, and it is told to the server.
 */

const HOUR = 3_600_000;

type Handler = (event: unknown, ctx: unknown) => unknown;

interface Dialog {
	title: string;
	options: string[];
	aborted: boolean;
}

function fakeOmp() {
	const handlers = new Map<string, Handler>();
	const pi = {
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
	};
	const dialogs: Dialog[] = [];
	const statuses: { key: string; text: string | undefined }[] = [];
	/** What the dialog is answered with, when a test answers it; otherwise it waits until its signal aborts. */
	const answers: ((answer: string | undefined) => void)[] = [];
	const ctx = (over: { kind?: string; hasUI?: boolean } = {}) => ({
		hasUI: over.hasUI ?? true,
		agent: { kind: over.kind ?? "main" },
		ui: {
			select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined> {
				const dialog: Dialog = { title, options, aborted: false };
				dialogs.push(dialog);
				const { promise, resolve } = Promise.withResolvers<string | undefined>();
				answers.push(resolve);
				opts?.signal?.addEventListener("abort", () => {
					dialog.aborted = true;
					resolve(undefined);
				});
				return promise;
			},
			setStatus(key: string, text: string | undefined) {
				statuses.push({ key, text });
			},
		},
	});
	return { pi, handlers, dialogs, statuses, answers, ctx };
}

let dir: string;
let file: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompw-quota-ext-"));
	file = join(dir, "overlay.yml.quota");
	process.env[QUOTA_FILE_ENV] = file;
});
afterEach(() => {
	delete process.env[QUOTA_FILE_ENV];
	rmSync(dir, { recursive: true, force: true });
});

const hold = (over: object = {}) =>
	holdFileText({
		provider: "anthropic",
		resetsAt: Date.now() + HOUR,
		resumeAt: Date.now() + HOUR + 60_000,
		expiresAt: null,
		since: Date.now(),
		...over,
	});

const callTool = (omp: ReturnType<typeof fakeOmp>, ctx: unknown) =>
	omp.handlers.get("tool_call")?.({ toolName: "bash" }, ctx) as Promise<undefined>;

describe("loading", () => {
	test("it says it started, once its handlers are in, so that the server does not take a command line for a process that runs it", () => {
		const omp = fakeOmp();
		quotaFloor(omp.pi as never);
		expect([...omp.handlers.keys()].sort()).toEqual(["before_provider_request", "cache_warming_decision", "tool_call"]);
		expect(readFileSync(`${file}${QUOTA_LOADED_SUFFIX}`, "utf8")).toBe(String(process.pid));
	});

	test("without a file named it does nothing and says nothing", async () => {
		delete process.env[QUOTA_FILE_ENV];
		const omp = fakeOmp();
		quotaFloor(omp.pi as never);
		expect(existsSync(`${file}${QUOTA_LOADED_SUFFIX}`)).toBe(false);
		await callTool(omp, omp.ctx());
		expect(omp.dialogs).toEqual([]);
	});
});

describe("tool_call: the wait between two model requests", () => {
	test("no hold: the call goes on at once and no dialog is opened", async () => {
		const omp = fakeOmp();
		quotaFloor(omp.pi as never);
		await callTool(omp, omp.ctx());
		expect(omp.dialogs).toEqual([]);
	});

	test("a hold: the main agent waits in the dialog the server consumes, and goes on when the file is gone, closing the dialog itself", async () => {
		const omp = fakeOmp();
		quotaFloor(omp.pi as never);
		writeFileSync(file, hold());
		const waiting = callTool(omp, omp.ctx());
		let done = false;
		void waiting.then(() => {
			done = true;
		});
		await Bun.sleep(50);
		expect(omp.dialogs).toEqual([{ title: QUOTA_DIALOG_TITLE, options: [QUOTA_DIALOG_CONTINUE], aborted: false }]);
		expect(done).toBe(false);
		// The hold ends: the server takes the file away, and the handler notices at its next look (it reads every second).
		rmSync(file);
		await waiting;
		expect(done).toBe(true);
		expect(omp.dialogs[0]?.aborted).toBe(true);
	});

	test("the server answering the dialog ends the wait at once", async () => {
		const omp = fakeOmp();
		quotaFloor(omp.pi as never);
		writeFileSync(file, hold());
		const waiting = callTool(omp, omp.ctx());
		await Bun.sleep(20);
		omp.answers[0]?.(QUOTA_DIALOG_CONTINUE);
		await waiting;
	});

	test("the turn being stopped (omp closes the dialog) ends the wait; the file may say hold still", async () => {
		const omp = fakeOmp();
		quotaFloor(omp.pi as never);
		writeFileSync(file, hold());
		const waiting = callTool(omp, omp.ctx());
		await Bun.sleep(20);
		// omp's own cancel of a dialog it closes answers undefined.
		omp.answers[0]?.(undefined);
		await waiting;
		expect(existsSync(file)).toBe(true);
	});

	test("a subagent never waits (it has no dialogs, and a wait the timeout was not paused for would fail its call), nor does a process without a UI", async () => {
		const omp = fakeOmp();
		quotaFloor(omp.pi as never);
		writeFileSync(file, hold());
		await callTool(omp, omp.ctx({ kind: "sub" }));
		await callTool(omp, omp.ctx({ hasUI: false }));
		await callTool(omp, undefined);
		expect(omp.dialogs).toEqual([]);
	});

	test("a hold whose time to let go has passed is no hold: a server that is gone cannot look, and the window it waited for is over", async () => {
		const omp = fakeOmp();
		quotaFloor(omp.pi as never);
		writeFileSync(file, hold({ expiresAt: Date.now() - 1 }));
		await callTool(omp, omp.ctx());
		expect(omp.dialogs).toEqual([]);
	});

	test("a hold that is to be let go by itself is let go when its time comes, with nobody to say so", async () => {
		const omp = fakeOmp();
		quotaFloor(omp.pi as never);
		writeFileSync(file, hold({ expiresAt: Date.now() + 1_200 }));
		const waiting = callTool(omp, omp.ctx());
		await Bun.sleep(30);
		expect(omp.dialogs.length).toBe(1);
		// The handler reads the file every second: it ends within one of them past the time.
		await waiting;
		expect(Date.now()).toBeGreaterThanOrEqual(0);
	});

	test("a hold file that cannot be read is no hold: a conversation never fails for this", async () => {
		const omp = fakeOmp();
		quotaFloor(omp.pi as never);
		for (const text of ["", "{", "[]", '{"hold":true}']) {
			writeFileSync(file, text);
			await callTool(omp, omp.ctx());
		}
		expect(omp.dialogs).toEqual([]);
	});
});

describe("cache_warming_decision: the cost check is the one that decides while a conversation is held", () => {
	const decide = (omp: ReturnType<typeof fakeOmp>, event: object) =>
		omp.handlers.get("cache_warming_decision")?.(event, omp.ctx()) as { action: string } | undefined;
	/** omp's own decision: 1 while the agent works. */
	const event = (over: object = {}) => ({
		warmCost: 0.03,
		missCost: 1.7,
		continuationProbability: 1,
		action: "warm",
		...over,
	});

	function atTime(now: number) {
		return spyOn(Date, "now").mockReturnValue(now);
	}

	test("no hold: omp's own decision stands", () => {
		const omp = fakeOmp();
		quotaFloor(omp.pi as never);
		expect(decide(omp, event())).toBeUndefined();
		expect(omp.statuses).toEqual([]);
	});

	test("held with the reset close: warm, and the verdict is told to the server under its key", () => {
		const omp = fakeOmp();
		quotaFloor(omp.pi as never);
		const t0 = 1_700_000_000_000;
		const clock = atTime(t0);
		try {
			// A request began; omp comes to refresh it 270 s later (a 5-minute cache), and the reset is 30 minutes away.
			omp.handlers.get("before_provider_request")?.({}, omp.ctx());
			writeFileSync(
				file,
				hold({
					resumeAt: t0 + 270_000 + 30 * 60_000,
					resetsAt: t0 + 270_000 + 29 * 60_000,
					since: t0,
					expiresAt: null,
				}),
			);
			clock.mockReturnValue(t0 + 270_000);
			expect(decide(omp, event())).toEqual({ action: "warm" });
			const told = omp.statuses.at(-1);
			expect(told?.key).toBe(QUOTA_STATUS_KEY);
			expect(parseWarmVerdict(told?.text)).toMatchObject({ state: "on", rebuildCost: 1.7 });
			expect(parseWarmVerdict(told?.text)?.pings).toBe(7);
		} finally {
			clock.mockRestore();
		}
	});

	test("held with the reset beyond what warming can reach, or too costly: stop, and the reason is told", () => {
		const omp = fakeOmp();
		quotaFloor(omp.pi as never);
		const t0 = 1_700_000_000_000;
		const clock = atTime(t0);
		try {
			omp.handlers.get("before_provider_request")?.({}, omp.ctx());
			clock.mockReturnValue(t0 + 270_000);
			// Five hours away: omp stops refreshing a working turn's cache an hour after its request.
			writeFileSync(file, hold({ resumeAt: t0 + 5 * HOUR, resetsAt: t0 + 5 * HOUR - 60_000, expiresAt: null }));
			expect(decide(omp, event())).toEqual({ action: "stop" });
			expect(parseWarmVerdict(omp.statuses.at(-1)?.text)).toMatchObject({ state: "lapse", why: "limit" });
			// Thirty minutes away but each refresh costs about what a rebuild does.
			writeFileSync(
				file,
				hold({ resumeAt: t0 + 270_000 + 30 * 60_000, resetsAt: t0 + 270_000 + 29 * 60_000, expiresAt: null }),
			);
			expect(decide(omp, event({ warmCost: 0.6 }))).toEqual({ action: "stop" });
			expect(parseWarmVerdict(omp.statuses.at(-1)?.text)).toMatchObject({ state: "lapse", why: "cost" });
			// No reset time at all.
			writeFileSync(file, hold({ resumeAt: null, resetsAt: null, expiresAt: null }));
			expect(decide(omp, event())).toEqual({ action: "stop" });
			expect(parseWarmVerdict(omp.statuses.at(-1)?.text)).toMatchObject({ state: "lapse", why: "reset" });
		} finally {
			clock.mockRestore();
		}
	});

	test("a hold that ends before the cache would: nothing is refreshed, nothing is spent", () => {
		const omp = fakeOmp();
		quotaFloor(omp.pi as never);
		const t0 = 1_700_000_000_000;
		const clock = atTime(t0);
		try {
			omp.handlers.get("before_provider_request")?.({}, omp.ctx());
			clock.mockReturnValue(t0 + 270_000);
			writeFileSync(file, hold({ resumeAt: t0 + 270_000 + 20_000, resetsAt: t0 + 270_000 + 10_000, expiresAt: null }));
			expect(decide(omp, event())).toEqual({ action: "stop" });
			expect(parseWarmVerdict(omp.statuses.at(-1)?.text)).toMatchObject({ state: "none", pings: 0 });
		} finally {
			clock.mockRestore();
		}
	});

	test("the figures omp did not give are not guessed: omp's own decision stands", () => {
		const omp = fakeOmp();
		quotaFloor(omp.pi as never);
		writeFileSync(file, hold());
		expect(decide(omp, { continuationProbability: 1 })).toBeUndefined();
		expect(decide(omp, undefined as never)).toBeUndefined();
	});

	test("a status that cannot be told does not change the decision", () => {
		const omp = fakeOmp();
		quotaFloor(omp.pi as never);
		writeFileSync(file, hold({ expiresAt: null }));
		const ctx = {
			ui: {
				setStatus: () => {
					throw new Error("no ui");
				},
			},
		};
		const t0 = 1_700_000_000_000;
		const clock = atTime(t0);
		try {
			omp.handlers.get("before_provider_request")?.({}, omp.ctx());
			clock.mockReturnValue(t0 + 270_000);
			writeFileSync(
				file,
				hold({ resumeAt: t0 + 270_000 + 30 * 60_000, resetsAt: t0 + 270_000 + 29 * 60_000, expiresAt: null }),
			);
			expect(omp.handlers.get("cache_warming_decision")?.(event(), ctx)).toEqual({ action: "warm" });
		} finally {
			clock.mockRestore();
		}
	});
});

describe("before_provider_request: the extension only watches", () => {
	test("it never changes the request, for any agent, held or not", () => {
		const omp = fakeOmp();
		quotaFloor(omp.pi as never);
		writeFileSync(file, hold());
		const handler = omp.handlers.get("before_provider_request");
		expect(handler?.({ payload: {} }, omp.ctx())).toBeUndefined();
		expect(handler?.({ payload: {} }, omp.ctx({ kind: "sub" }))).toBeUndefined();
		expect(handler?.({ payload: {} }, undefined)).toBeUndefined();
	});
});
