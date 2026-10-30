import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AppUpdateState, UpdateFailure, UpdateFailureCode, UpdateOutcome } from "../../shared/update.ts";
import { en } from "../../web/src/i18n/update.ts";
import { zh } from "../../web/src/i18n/zh-CN/update.ts";
import {
	BLOCK_KEYS,
	canCancel,
	failureMessage,
	formatBytes,
	formatProgress,
	notesFor,
	OUTCOME_KEYS,
	outcomeMessage,
	PHASE_KEYS,
	progressPercent,
	refusalMessage,
	replyingOf,
	shortHash,
	UPDATE_FAILURE_CODES,
	versionOfTag,
} from "../../web/src/lib/app-update.ts";
import {
	AppUpdateRequestError,
	appUpdateApi,
	onAppUpdateMessage,
	setAppUpdateSnapshot,
	supersededUpdate,
	useAppUpdate,
} from "../../web/src/store/app-update.ts";

function state(over: Partial<AppUpdateState> = {}): AppUpdateState {
	return {
		boot: "a",
		rev: 1,
		installed: "0.11.0",
		install: { allowed: true },
		checking: false,
		checkedAt: null,
		latest: null,
		newer: false,
		failure: null,
		job: null,
		failed: null,
		outcome: null,
		...over,
	};
}

beforeEach(() => useAppUpdate.setState({ state: null, loaded: false }));

describe("supersededUpdate", () => {
	test("nothing held: nothing is older", () => {
		expect(supersededUpdate(null, state({ rev: 0 }))).toBe(false);
	});
	test("a lower rev of the same boot is older; the same rev and a higher one are not", () => {
		expect(supersededUpdate(state({ rev: 5 }), state({ rev: 4 }))).toBe(true);
		expect(supersededUpdate(state({ rev: 5 }), state({ rev: 5 }))).toBe(false);
		expect(supersededUpdate(state({ rev: 5 }), state({ rev: 6 }))).toBe(false);
	});
	test("a state of another run of the server is never older, whatever its rev (the app restarted)", () => {
		expect(supersededUpdate(state({ boot: "a", rev: 90 }), state({ boot: "b", rev: 1 }))).toBe(false);
	});
});

describe("the store", () => {
	test("a socket message is taken, and a stale one arriving after it is dropped", () => {
		onAppUpdateMessage(state({ rev: 3, job: null, failed: { code: "digest", tag: "v0.12.0", params: {} } }));
		// The answer of a request made before that failure, read after it: it still says the install is running.
		onAppUpdateMessage(
			state({
				rev: 2,
				job: { id: "j", tag: "v0.12.0", phase: "downloading", received: 1, total: 2, startedAt: 0 },
			}),
		);
		const held = useAppUpdate.getState().state;
		expect(held?.rev).toBe(3);
		expect(held?.job).toBeNull();
		expect(held?.failed?.code).toBe("digest");
	});

	test("the answer of a request folds in the same way", () => {
		onAppUpdateMessage(state({ rev: 7, newer: true }));
		setAppUpdateSnapshot({ state: state({ rev: 6, newer: false }) });
		expect(useAppUpdate.getState().state?.newer).toBe(true);
		setAppUpdateSnapshot({ state: state({ rev: 8, newer: false }) });
		expect(useAppUpdate.getState().state?.newer).toBe(false);
	});

	test("after the server restarts its first state is taken although its rev is low", () => {
		onAppUpdateMessage(state({ boot: "a", rev: 40 }));
		onAppUpdateMessage(state({ boot: "b", rev: 0, outcome: { ok: true, from: "0.11.0", to: "0.12.0", at: 1 } }));
		expect(useAppUpdate.getState().state?.outcome?.ok).toBe(true);
	});
});

describe("the requests", () => {
	const realFetch = globalThis.fetch;
	const calls: { url: string; init?: RequestInit }[] = [];
	function answer(status: number, body: unknown) {
		globalThis.fetch = (async (url: string, init?: RequestInit) => {
			calls.push({ url, init });
			return Response.json(body, { status });
		}) as typeof fetch;
	}
	afterEach(() => {
		calls.length = 0;
		globalThis.fetch = realFetch;
	});
	afterAll(() => {
		globalThis.fetch = realFetch;
	});

	test("load asks with a GET, folds the answer in, and marks the first look as over", async () => {
		answer(200, { state: state({ rev: 2, newer: true }) });
		await appUpdateApi.load();
		expect(calls[0]).toMatchObject({ url: "/api/update" });
		expect(calls[0].init).toBeUndefined();
		expect(useAppUpdate.getState()).toMatchObject({ loaded: true, state: { newer: true } });
	});

	test("load that fails still ends the wait", async () => {
		answer(500, { error: "boom" });
		await expect(appUpdateApi.load()).rejects.toThrow("boom");
		expect(useAppUpdate.getState().loaded).toBe(true);
		expect(useAppUpdate.getState().state).toBeNull();
	});

	test("install posts the tag with the CSRF header, and `anyway` only when it is true", async () => {
		answer(200, { state: state() });
		await appUpdateApi.install("v0.12.0");
		await appUpdateApi.install("v0.12.0", true);
		expect(calls.map((c) => c.init?.method)).toEqual(["POST", "POST"]);
		expect(new Headers(calls[0].init?.headers).get("x-omp-webui")).toBe("1");
		expect(JSON.parse(String(calls[0].init?.body))).toEqual({ tag: "v0.12.0" });
		expect(JSON.parse(String(calls[1].init?.body))).toEqual({ tag: "v0.12.0", anyway: true });
	});

	test("a refusal carries its status, code and params, and leaves the state alone", async () => {
		useAppUpdate.setState({ state: state({ rev: 4 }) });
		answer(409, { error: "replying", code: "replying", params: { working: 2, paused: 1 } });
		const error = await appUpdateApi.install("v0.12.0").catch((e) => e);
		expect(error).toBeInstanceOf(AppUpdateRequestError);
		expect(error).toMatchObject({ status: 409, code: "replying", params: { working: 2, paused: 1 } });
		expect(useAppUpdate.getState().state?.rev).toBe(4);
	});

	test("check, cancel and dismiss post to their own routes", async () => {
		answer(200, { state: state() });
		await appUpdateApi.check();
		await appUpdateApi.cancel();
		await appUpdateApi.dismiss();
		expect(calls.map((c) => c.url)).toEqual(["/api/update/check", "/api/update/cancel", "/api/update/dismiss"]);
	});
});

describe("notesFor", () => {
	const both = { en: "English notes", zh: "中文说明" };
	test("each language reads its own notes", () => {
		expect(notesFor(both, "en")).toBe("English notes");
		expect(notesFor(both, "zh-CN")).toBe("中文说明");
	});
	test("a release without a 中文 section shows English to a Chinese reader, and the reverse", () => {
		expect(notesFor({ en: "English notes", zh: "" }, "zh-CN")).toBe("English notes");
		expect(notesFor({ en: "", zh: "中文说明" }, "en")).toBe("中文说明");
	});
	test("a release without notes is empty, not a placeholder", () => {
		expect(notesFor({ en: "", zh: "" }, "en")).toBe("");
		expect(notesFor({ en: "  \n", zh: "" }, "zh-CN")).toBe("");
	});
});

describe("progress", () => {
	test("sizes in MB with one decimal, GB from 1024 MB", () => {
		expect(formatBytes(0)).toBe("0 MB");
		expect(formatBytes(54.2 * 1024 * 1024)).toBe("54.2 MB");
		expect(formatBytes(50 * 1024 * 1024)).toBe("50 MB");
		expect(formatBytes(1.5 * 1024 * 1024 * 1024)).toBe("1.5 GB");
		expect(formatBytes(Number.NaN)).toBe("?");
		// A small file is in KB, so that it does not read as nothing.
		expect(formatBytes(640 * 1024)).toBe("640 KB");
		expect(formatBytes(1024 * 1024)).toBe("1 MB");
	});
	test("the download reads `received / total MB`, and just what is in while the total is unknown", () => {
		const MB = 1024 * 1024;
		expect(formatProgress(12.3 * MB, 54.2 * MB)).toBe("12.3 / 54.2 MB");
		expect(formatProgress(5 * MB, 0)).toBe("5 MB");
		// More received than announced (a wrong size) never reads as more than the whole.
		expect(formatProgress(60 * MB, 54 * MB)).toBe("54 / 54 MB");
		expect(formatProgress(100 * 1024, 640 * 1024)).toBe("100 / 640 KB");
	});
	test("the bar is a percentage clamped to 0..100, and none without a total", () => {
		expect(progressPercent(0, 100)).toBe(0);
		expect(progressPercent(1, 3)).toBe(33);
		expect(progressPercent(250, 100)).toBe(100);
		expect(progressPercent(-5, 100)).toBe(0);
		expect(progressPercent(10, 0)).toBeNull();
	});
	test("only the download and its check can be cancelled", () => {
		expect(canCancel("downloading")).toBe(true);
		expect(canCancel("verifying")).toBe(true);
		expect(canCancel("staging")).toBe(false);
		expect(canCancel("handover")).toBe(false);
	});
	test("every phase has a sentence in both languages", () => {
		for (const key of Object.values(PHASE_KEYS)) {
			const name = key.replace("update.", "") as keyof typeof en;
			expect(en[name]).toBeTruthy();
			expect(zh[name]).toBeTruthy();
		}
	});
});

/** What each code sends, as the server words it (shared/update.ts). */
const SAMPLE_PARAMS: Record<UpdateFailureCode, Record<string, string | number>> = {
	download: { reason: "timeout", status: 503 },
	size: { expected: 56_000_000, actual: 41_000_000 },
	digest: { expected: "a".repeat(64), actual: "b".repeat(64) },
	mount: { detail: "hdiutil: attach failed" },
	noApp: {},
	signature: { detail: "a sealed resource is missing" },
	bundleId: { expected: "com.example.omp-webui", found: "com.example.other" },
	version: { tag: "v0.12.0", found: "0.11.9" },
	notNewer: { found: "0.10.0", installed: "0.11.0" },
	requirement: { expected: "c".repeat(40), found: "ad hoc" },
	adHoc: {},
	space: { needed: 200 * 1024 * 1024, free: 12 * 1024 * 1024 },
	notWritable: { dir: "/Applications" },
	stage: { detail: "ditto: no space left" },
};

const PLACEHOLDER = /\{(\w+)\}/g;
const placeholders = (s: string) => [...s.matchAll(PLACEHOLDER)].map((m) => m[1]);
const dictionaries = { en, zh } as Record<"en" | "zh", Record<string, string>>;

describe("what a failed install says", () => {
	test("the list of codes is the shared one: a code without a sentence fails here", () => {
		expect([...UPDATE_FAILURE_CODES].sort()).toEqual((Object.keys(SAMPLE_PARAMS) as UpdateFailureCode[]).sort());
	});

	for (const code of UPDATE_FAILURE_CODES) {
		test(`${code}: its sentence exists in both languages and every value in it is filled`, () => {
			const { key, vars } = failureMessage({ code, params: SAMPLE_PARAMS[code] });
			expect(key.startsWith("update.")).toBe(true);
			const name = key.slice("update.".length);
			for (const lang of ["en", "zh"] as const) {
				const sentence = dictionaries[lang][name];
				expect(sentence, `${lang} ${name}`).toBeTruthy();
				for (const p of placeholders(sentence)) expect(Object.keys(vars), `${lang} ${name} {${p}}`).toContain(p);
			}
		});

		test(`${code}: a value the server left out shows as ?, never as {name}`, () => {
			const { key, vars } = failureMessage({ code, params: {} });
			const sentence = en[key.slice("update.".length) as keyof typeof en];
			for (const p of placeholders(sentence)) expect(vars[p]).toBe("?");
		});
	}

	test("every sentence of the language packs uses the same values in both languages", () => {
		for (const name of Object.keys(en) as (keyof typeof en)[]) {
			expect(placeholders(zh[name]).sort(), String(name)).toEqual(placeholders(en[name]).sort());
		}
	});

	test("a code this page does not know says so with the code, instead of an empty line", () => {
		const unknown = { code: "teapot", params: {} } as unknown as UpdateFailure;
		expect(failureMessage(unknown)).toEqual({ key: "update.failedUnknown", vars: { code: "teapot" } });
	});

	test("sizes are in MB and hashes are cut to 12 characters", () => {
		expect(failureMessage({ code: "space", params: SAMPLE_PARAMS.space }).vars).toEqual({
			needed: "200 MB",
			free: "12 MB",
		});
		const digest = failureMessage({ code: "digest", params: SAMPLE_PARAMS.digest }).vars;
		expect(digest).toEqual({ expected: `${"a".repeat(12)}…`, actual: `${"b".repeat(12)}…` });
		// `ad hoc` is a word, not a hash.
		expect(failureMessage({ code: "requirement", params: SAMPLE_PARAMS.requirement }).vars).toEqual({
			expected: `${"c".repeat(12)}…`,
			found: "ad hoc",
		});
	});

	test("a size mismatch says the exact byte counts, which a rounded MB would hide", () => {
		expect(failureMessage({ code: "size", params: { expected: 56_000_000, actual: 55_999_000 } }).vars).toEqual({
			expected: "56000000",
			actual: "55999000",
		});
	});

	test("a failed download names the reason and the HTTP status when there is one", () => {
		expect(failureMessage({ code: "download", params: { reason: "http", status: 404 } })).toEqual({
			key: "update.failedDownload",
			vars: { detail: "http, HTTP 404" },
		});
		expect(failureMessage({ code: "download", params: {} }).key).toBe("update.failedDownloadPlain");
	});

	test("a long tool output is cut", () => {
		const { vars } = failureMessage({ code: "signature", params: { detail: "x".repeat(2000) } });
		expect(String(vars.detail).length).toBeLessThan(400);
	});

	test("the folder a tool worked in is left out of what it said: the app is all that is named", () => {
		const said = "/var/folders/xx/T/ompw-e2e-AbC/data/update/mount-1/omp-webui.app: invalid signature";
		expect(failureMessage({ code: "signature", params: { detail: said } }).vars).toEqual({
			detail: "omp-webui.app: invalid signature",
		});
	});

	test("shortHash leaves short and non-hex text alone and drops the sha256: prefix", () => {
		expect(shortHash("ad hoc")).toBe("ad hoc");
		expect(shortHash("abc123")).toBe("abc123");
		expect(shortHash(`sha256:${"d".repeat(64)}`)).toBe(`${"d".repeat(12)}…`);
	});
});

describe("the rest of what the card says by a code", () => {
	test("every way the copy cannot install has a sentence in both languages", () => {
		for (const key of Object.values(BLOCK_KEYS)) {
			const name = key.slice("update.".length);
			expect(dictionaries.en[name]).toBeTruthy();
			expect(dictionaries.zh[name]).toBeTruthy();
		}
		expect(Object.keys(BLOCK_KEYS).sort()).toEqual(["adHoc", "notApp", "notWritable", "translocated"]);
	});

	test("the outcome of an update names the versions, and a problem has its own sentence", () => {
		const base: UpdateOutcome = { ok: true, from: "v0.11.0", to: "v0.12.0", at: 1 };
		expect(outcomeMessage(base)).toEqual({ key: "update.outcomeOk", vars: { from: "0.11.0", to: "0.12.0" } });
		expect(outcomeMessage({ ...base, ok: false }).key).toBe("update.outcomeFailed");
		for (const [problem, key] of Object.entries(OUTCOME_KEYS)) {
			expect(outcomeMessage({ ...base, ok: false, problem: problem as keyof typeof OUTCOME_KEYS }).key).toBe(key);
			const name = key.slice("update.".length) as keyof typeof en;
			expect(en[name]).toBeTruthy();
			expect(zh[name]).toBeTruthy();
		}
		const unknownProblem = { ...base, ok: false, problem: "newKind" } as unknown as UpdateOutcome;
		expect(outcomeMessage(unknownProblem).key).toBe("update.outcomeFailed");
	});

	test("refusals other than `replying` have a sentence; a blocked one names the reason", () => {
		expect(refusalMessage("busy", undefined, "0.12.0")?.key).toBe("update.refusedBusy");
		expect(refusalMessage("nothingToInstall", {}, "0.12.0")?.key).toBe("update.refusedNothing");
		expect(refusalMessage("blocked", { reason: "translocated" }, "0.12.0")).toEqual({
			key: "update.blockedTranslocated",
			vars: { version: "0.12.0" },
		});
		expect(refusalMessage("blocked", { reason: "somethingNew" }, "0.12.0")?.key).toBe("update.refusedBlocked");
		expect(refusalMessage("replying", {}, "0.12.0")).toBeNull();
		expect(refusalMessage(undefined, undefined, "0.12.0")).toBeNull();
	});

	test("conversations that are replying are stopped, paused and waiting ones stay", () => {
		expect(replyingOf({ working: 2, asking: 1, paused: 3, waiting: 1 })).toEqual({ stopped: 3, staying: 4 });
		expect(replyingOf({ working: "2", paused: -1 })).toEqual({ stopped: 0, staying: 0 });
		expect(replyingOf(undefined)).toEqual({ stopped: 0, staying: 0 });
	});

	test("a tag loses its v", () => {
		expect(versionOfTag("v0.12.0")).toBe("0.12.0");
		expect(versionOfTag("0.12.0")).toBe("0.12.0");
	});
});
