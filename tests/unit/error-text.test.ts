import { afterAll, beforeAll, expect, test } from "bun:test";
import { OfflineError, queryBackend } from "../../server/offline/backend.ts";
import { chooseModel } from "../../server/offline/index.ts";
import { mergeOffline, normalizeBaseUrl, SettingsError } from "../../server/offline/settings.ts";
import { CodedError, ERROR_CODES, errorInfoOf } from "../../shared/error-info.ts";
import { DEFAULT_OFFLINE } from "../../shared/offline.ts";
import { en as enErrors } from "../../web/src/i18n/errors.ts";
import { showLang } from "../../web/src/i18n/index.ts";
import { zh as zhErrors } from "../../web/src/i18n/zh-CN/errors.ts";
import { ApiError } from "../../web/src/lib/api.ts";
import { codedText, errorText, jobErrorText } from "../../web/src/lib/error-text.ts";
import { ReplyError } from "../../web/src/lib/ws.ts";

/**
 * Errors the user is meant to read travel as a code and parameters, and the page words them in its own language, so
 * 中文 never shows the server's English, and no sentence names a setting by its key path (`baseUrls.omlx`) (#300).
 */

function thrown(fn: () => unknown): CodedError {
	try {
		fn();
	} catch (e) {
		if (e instanceof CodedError) return e;
		throw e;
	}
	throw new Error("did not throw");
}

beforeAll(() => showLang("zh-CN"));
afterAll(() => showLang("en"));

test("refused settings carry a code and the parameters of their sentence", () => {
	expect(errorInfoOf(thrown(() => normalizeBaseUrl("omlx", "not a url")))).toEqual({
		code: "settingsAddressInvalid",
		params: { backend: "omlx" },
	});
	expect(errorInfoOf(thrown(() => normalizeBaseUrl("omlx", "http://169.254.169.254/v1")))).toEqual({
		code: "settingsAddressLinkLocal",
		params: { backend: "omlx", host: "169.254.169.254" },
	});
	expect(errorInfoOf(thrown(() => mergeOffline(DEFAULT_OFFLINE, { tools: [] })))).toEqual({
		code: "settingsToolsNone",
		params: {},
	});
	expect(errorInfoOf(thrown(() => mergeOffline(DEFAULT_OFFLINE, { mcp: "x" })))).toEqual({
		code: "settingsListInvalid",
		params: { field: "mcp" },
	});
	expect(thrown(() => mergeOffline(DEFAULT_OFFLINE, { baseUrls: { ollama: "ftp://h" } }))).toBeInstanceOf(
		SettingsError,
	);
	// The English message is what it always was, for logs and API users.
	expect(thrown(() => normalizeBaseUrl("omlx", "not a url")).message).toBe(
		"baseUrls.omlx must be an address like http://127.0.0.1:11434/v1",
	);
});

test("a backend that does not answer, and a model it does not serve, carry codes", async () => {
	const down = await queryBackend("omlx", { baseUrl: "http://127.0.0.1:1/v1", apiKey: null }).catch((e) => e);
	expect(down).toBeInstanceOf(OfflineError);
	expect(errorInfoOf(down)).toEqual({
		code: "offlineUnreachableRefused",
		params: { backend: "omlx", url: "http://127.0.0.1:1/v1" },
	});
	expect(errorInfoOf(thrown(() => chooseModel("ollama", "ollama/x", ["a", "b"])))).toEqual({
		code: "offlineModelNotServed",
		params: { backend: "ollama", id: "x", served: "a, b" },
	});
	expect(errorInfoOf(thrown(() => chooseModel("ollama", null, [])))).toEqual({
		code: "offlineNoModels",
		params: { backend: "ollama" },
	});
});

test("the page words them in 中文, with the server's name for the address and no key path", () => {
	const unreachable = new ApiError(
		"oMLX is not reachable at http://127.0.0.1:1/v1 (connection refused). Start the oMLX server, or switch to Full mode.",
		400,
		"offlineUnreachableRefused",
		{ backend: "omlx", url: "http://127.0.0.1:1/v1" },
	);
	expect(errorText(unreachable)).toBe(
		"无法连接到 http://127.0.0.1:1/v1 上的 oMLX（连接被拒绝）。请启动 oMLX 服务器，或切换到完整模式。",
	);
	const invalid = new ApiError(
		"baseUrls.omlx must be an address like http://127.0.0.1:11434/v1",
		400,
		"settingsAddressInvalid",
		{
			backend: "omlx",
		},
	);
	expect(errorText(invalid)).toBe("oMLX 地址必须形如 http://127.0.0.1:11434/v1。");
	expect(errorText(invalid)).not.toContain("baseUrls");
	const linkLocal = new ReplyError("…", "settingsAddressLinkLocal", { backend: "ollama", host: "169.254.169.254" });
	expect(errorText(linkLocal)).toBe("Ollama 地址是链路本地地址（169.254.169.254），那里不会有模型服务器。");
	// A list setting is named as the page names it.
	expect(codedText("settingsListInvalid", { field: "mcp" }, "")).toBe("MCP 服务器必须是名称列表。");
});

test("an error with no code, or one this page does not know, shows the server's own words", () => {
	expect(errorText(new Error("disk full"))).toBe("disk full");
	expect(errorText(new ApiError("Not found", 404))).toBe("Not found");
	expect(errorText(new ReplyError("Live session not found", "not-a-code"))).toBe("Live session not found");
	expect(errorText("plain")).toBe("plain");
});

test("an omp update that failed is worded in 中文 around omp's own output", () => {
	const job = {
		error: "omp update exited with code 1:\nnetwork unreachable",
		errorInfo: {
			code: "jobExitedOutput" as const,
			params: { command: "omp update", code: 1, output: "network unreachable" },
		},
	};
	expect(jobErrorText(job)).toBe("omp update 退出，退出码 1：\nnetwork unreachable");
	expect(jobErrorText({ error: "Cancelled", errorInfo: { code: "jobCancelled" } })).toBe("已取消");
	// A job from a server that sends no code shows its text as it is.
	expect(jobErrorText({ error: "something odd" })).toBe("something odd");
});

test("a paused conversation's refusals are worded in 中文, the one that says to Resume included (#309)", () => {
	expect(errorText(new ReplyError("English", "paused"))).toBe("这个对话已暂停；请先点“继续”再进行操作。");
	const due = errorText(new ReplyError("English", "pausedRetryDue"));
	expect(due).toContain("请点“继续”，让它重试");
	expect(due).not.toMatch(/[A-Za-z]{4}/);
});

test("every code has a sentence in both languages, with the same parameters, and none names a key path", () => {
	const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
	for (const code of ERROR_CODES) {
		expect(zhErrors[code], code).toBeTruthy();
		expect(placeholders(zhErrors[code]), code).toEqual(placeholders(enErrors[code]));
		expect(enErrors[code], code).not.toMatch(/baseUrls|modelRoles|\bmcp\.|\btools\./);
		expect(zhErrors[code], code).not.toMatch(/baseUrls|modelRoles/);
	}
});
