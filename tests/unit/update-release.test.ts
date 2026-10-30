import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
	DEFAULT_API,
	fetchLatest,
	installerName,
	installerUrlAllowed,
	isNewer,
	parseRelease,
	redirectAllowed,
	splitNotes,
} from "../../server/update/release.ts";
import { RELEASE_BODY } from "../support/fake-releases.ts";

/**
 * What the app makes of GitHub's answer when it looks for a newer release of itself (#571): which release, which asset,
 * where it may be downloaded from, the notes in each language, and every way the look can fail. The requests are
 * answered by a `fetch` the test passes in; nothing reaches the network.
 */

const SHA = createHash("sha256").update("installer").digest("hex");
const API = "http://127.0.0.1:9999";

function release(over: Record<string, unknown> = {}, assets?: unknown[]): unknown {
	return {
		tag_name: "v0.12.0",
		draft: false,
		prerelease: false,
		html_url: "https://github.com/9s94ttyfct-bit/omp-webui/releases/tag/v0.12.0",
		published_at: "2026-10-21T08:00:00Z",
		body: RELEASE_BODY,
		assets: assets ?? [
			{
				name: "omp-webui-v0.12.0.dmg",
				state: "uploaded",
				size: 4096,
				digest: `sha256:${SHA}`,
				browser_download_url: `${API}/download/omp-webui-v0.12.0.dmg`,
			},
		],
		...over,
	};
}

test("the installer is the asset named for the version, with its size and the SHA-256 GitHub lists", () => {
	const parsed = parseRelease(release(), API);
	expect(parsed?.release.tag).toBe("v0.12.0");
	expect(parsed?.release.version).toBe("0.12.0");
	expect(parsed?.release.asset).toEqual({ name: installerName("0.12.0"), size: 4096 });
	expect(parsed?.installer).toEqual({ url: `${API}/download/omp-webui-v0.12.0.dmg`, sha256: SHA });
});

test("another file in the release is no installer: only the one named for this version is", () => {
	const other = { name: "omp-webui-v0.11.9.dmg", size: 10, browser_download_url: `${API}/download/x` };
	const parsed = parseRelease(release({}, [other, { name: "notes.txt", size: 5 }]), API);
	expect(parsed?.release.asset).toBeNull();
	expect(parsed?.installer).toBeNull();
	// …and the release is still one: its notes are shown, with no install button.
	expect(parsed?.release.notes.en).toContain("updates itself");
});

test("an upload that is not finished is no installer yet; a digest that is not a sha256 is not one either", () => {
	const url = `${API}/download/omp-webui-v0.12.0.dmg`;
	const asset = { name: "omp-webui-v0.12.0.dmg", size: 10, browser_download_url: url };
	expect(parseRelease(release({}, [{ ...asset, state: "starter" }]), API)?.installer).toBeNull();
	expect(parseRelease(release({}, [{ ...asset, digest: "md5:abc" }]), API)?.installer?.sha256).toBeNull();
	expect(
		parseRelease(release({}, [{ ...asset, digest: `SHA256:${SHA.toUpperCase()}` }]), API)?.installer?.sha256,
	).toBeNull();
	expect(parseRelease(release({}, [{ ...asset, digest: `sha256:${SHA.toUpperCase()}` }]), API)?.installer?.sha256).toBe(
		SHA,
	);
});

test("a release this app cannot use is no release: no vX.Y.Z tag, a draft, a prerelease, a size that is no size", () => {
	for (const bad of [
		release({ tag_name: "0.12.0" }),
		release({ tag_name: "v0.12" }),
		release({ tag_name: "v0.12.0-rc.1" }),
		release({ draft: true }),
		release({ prerelease: true }),
		release({}, [{ name: "omp-webui-v0.12.0.dmg", size: 0, browser_download_url: `${API}/d` }]),
		release({}, [{ name: "omp-webui-v0.12.0.dmg", size: "big", browser_download_url: `${API}/d` }]),
		null,
		[],
		"v0.12.0",
	]) {
		expect(parseRelease(bad, API), JSON.stringify(bad)).toBeNull();
	}
});

test("the installer may only come from this repository's downloads on github.com, or, in a test, from the API's own host", () => {
	const repo = "https://github.com/9s94ttyfct-bit/omp-webui/releases/download/v0.12.0/omp-webui-v0.12.0.dmg";
	expect(installerUrlAllowed(repo, DEFAULT_API)).toBe(true);
	for (const url of [
		"https://github.com/someone-else/omp-webui/releases/download/v0.12.0/omp-webui-v0.12.0.dmg",
		"https://github.com/9s94ttyfct-bit/omp-webui/raw/main/x.dmg",
		"https://evil.example/9s94ttyfct-bit/omp-webui/releases/download/v0.12.0/a.dmg",
		"http://github.com/9s94ttyfct-bit/omp-webui/releases/download/v0.12.0/a.dmg",
		"https://github.com.evil.example/9s94ttyfct-bit/omp-webui/releases/download/v0.12.0/a.dmg",
		"file:///etc/passwd",
		"not a url",
		`${API}/download/a.dmg`,
	]) {
		expect(installerUrlAllowed(url, DEFAULT_API), url).toBe(false);
	}
	expect(installerUrlAllowed(`${API}/download/a.dmg`, API)).toBe(true);
	expect(installerUrlAllowed("http://127.0.0.1:1/download/a.dmg", API)).toBe(false);
	// The refusal reaches the parse: a release whose installer is somewhere else is none.
	const elsewhere = [
		{ name: "omp-webui-v0.12.0.dmg", size: 10, browser_download_url: "https://evil.example/omp-webui-v0.12.0.dmg" },
	];
	expect(parseRelease(release({}, elsewhere), DEFAULT_API)).toBeNull();
});

test("never a downgrade: only a newer version is newer, a prerelease of the running version is not", () => {
	const v = (version: string) => ({ version });
	expect(isNewer(v("0.12.0"), "0.11.9")).toBe(true);
	expect(isNewer(v("1.0.0"), "0.99.99")).toBe(true);
	expect(isNewer(v("0.11.9"), "0.11.9")).toBe(false);
	expect(isNewer(v("0.11.8"), "0.11.9")).toBe(false);
	expect(isNewer(v("0.9.9"), "0.11.9")).toBe(false);
	// A running version that is no version (a development build) is never replaced by guesswork.
	expect(isNewer(v("0.12.0"), "unknown")).toBe(false);
});

// ------------------------------------------------------------------ notes

test("the notes are the two language sections, without the install steps release-local appends", () => {
	const notes = splitNotes(RELEASE_BODY);
	expect(notes.en).toBe("### Added\n- The app updates itself from GitHub Releases.");
	expect(notes.zh).toBe("### 新增\n- 应用可以从 GitHub Releases 自行更新。");
});

test("a release made by Actions (no installer yet) shows its notes, not the line that says there is none", () => {
	const body = `## English\n\nFixed a thing.\n\n## 中文\n\n修了一个问题。\n\n---\n\nThis release has no installer yet: the macOS app is signed with a certificate…\n`;
	expect(splitNotes(body)).toEqual({ en: "Fixed a thing.", zh: "修了一个问题。" });
});

test("a rule inside the notes stays: only a trailing one, with what release-local appends, is cut", () => {
	const body = `## English\n\nTop\n\n---\n\nBelow the rule\n\n## 中文\n\n上面\n\n---\n\n规则下面\n`;
	const notes = splitNotes(body);
	expect(notes.en).toBe("Top\n\n---\n\nBelow the rule");
	expect(notes.zh).toBe("上面\n\n---\n\n规则下面");
});

test("notes with only one language, none, or a body that is not in sections are all shown as they are", () => {
	expect(splitNotes("## English\n\nOnly this.\n")).toEqual({ en: "Only this.", zh: "" });
	expect(splitNotes("## 中文\n\n只有这个。\n")).toEqual({ en: "", zh: "只有这个。" });
	expect(splitNotes("Plain notes.\n\n- one\n- two\n")).toEqual({ en: "Plain notes.\n\n- one\n- two", zh: "" });
	expect(splitNotes(null)).toEqual({ en: "", zh: "" });
	expect(splitNotes("  \n")).toEqual({ en: "", zh: "" });
	expect(splitNotes("## English\r\n\r\nWindows line ends.\r\n\r\n## 中文\r\n\r\n行尾。\r\n")).toEqual({
		en: "Windows line ends.",
		zh: "行尾。",
	});
	// A heading that is a name of Object.prototype is just a heading.
	expect(splitNotes("## English\n\nA\n\n## constructor\n\nB\n").en).toBe("A");
});

// ------------------------------------------------------------------ the look

function answering(status: number, headers: Record<string, string> = {}, body: unknown = release()) {
	const seen: { url: string; headers: Record<string, string> }[] = [];
	const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
		seen.push({ url: String(url), headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as object)) });
		return new Response(status === 304 ? null : typeof body === "string" ? body : JSON.stringify(body), {
			status,
			headers,
		});
	}) as unknown as typeof fetch;
	return { fetcher, seen };
}

const base = { api: API, userAgent: "omp-webui/0.11.9" };

test("a look asks for the repository's latest release, says who asks, and sends the ETag it has", async () => {
	const { fetcher, seen } = answering(200, { etag: 'W/"abc"' });
	const answer = await fetchLatest({ ...base, etag: 'W/"old"', fetch: fetcher });
	expect(answer.kind).toBe("release");
	expect(answer.kind === "release" && answer.etag).toBe('W/"abc"');
	expect(seen[0]?.url).toBe(`${API}/repos/9s94ttyfct-bit/omp-webui/releases/latest`);
	expect(seen[0]?.headers["user-agent"]).toBe("omp-webui/0.11.9");
	expect(seen[0]?.headers["if-none-match"]).toBe('W/"old"');
	expect(seen[0]?.headers.authorization).toBeUndefined();
});

test("each way a look fails is a failure that says which, and 404 is 'no release', not an error", async () => {
	const look = async (status: number, headers: Record<string, string> = {}, body: unknown = "{}") => {
		const { fetcher } = answering(status, headers, body);
		const answer = await fetchLatest({ ...base, etag: null, fetch: fetcher, now: () => 1_000_000 });
		return answer.kind === "failure" ? answer.failure : answer.kind;
	};
	expect(await look(304)).toBe("notModified");
	expect(await look(404)).toEqual({ code: "noRelease" });
	expect(await look(500)).toEqual({ code: "http", status: 500 });
	expect(await look(403)).toEqual({ code: "http", status: 403 });
	expect(await look(200, {}, "not json")).toEqual({ code: "badAnswer" });
	// The budget is spent: the reset time GitHub names, or the seconds it asks to wait.
	expect(await look(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700000" })).toEqual({
		code: "rateLimited",
		retryAt: 1_700_000_000,
	});
	expect(await look(403, { "retry-after": "120" })).toEqual({ code: "rateLimited", retryAt: 1_000_000 + 120_000 });
	expect(await look(429, { "x-ratelimit-reset": "1700000" })).toEqual({ code: "rateLimited", retryAt: 1_700_000_000 });
	// A 429 that says nothing about when: not before an hour has passed.
	expect(await look(429)).toEqual({ code: "rateLimited", retryAt: 1_000_000 + 3_600_000 });
});

test("a look that cannot reach GitHub is 'offline', and one that hangs is given up on", async () => {
	const refused = (async () => {
		throw new TypeError("fetch failed");
	}) as unknown as typeof fetch;
	expect(await fetchLatest({ ...base, etag: null, fetch: refused })).toMatchObject({ failure: { code: "offline" } });
	const hangs = ((_url: unknown, init?: RequestInit) =>
		new Promise((_, reject) => {
			init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "TimeoutError")));
		})) as unknown as typeof fetch;
	const started = Date.now();
	expect(await fetchLatest({ ...base, etag: null, fetch: hangs, timeoutMs: 60 })).toMatchObject({
		failure: { code: "offline" },
	});
	expect(Date.now() - started).toBeLessThan(2000);
});

test("a spent budget on an answer that did work is remembered too", async () => {
	const { fetcher } = answering(200, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1700000" });
	const answer = await fetchLatest({ ...base, etag: null, fetch: fetcher });
	expect(answer.rate.blockedUntil).toBe(1_700_000_000);
	const open = answering(200, { "x-ratelimit-remaining": "12", "x-ratelimit-reset": "1700000" });
	expect((await fetchLatest({ ...base, etag: null, fetch: open.fetcher })).rate.blockedUntil).toBeNull();
});

// ------------------------------------------------------------------ what a hostile answer could point the app at

test("an installer that lists more than 500 MB is refused: the size is the only bound on what is written before it is checked", () => {
	const asset = (size: number) => [
		{ name: "omp-webui-v0.12.0.dmg", size, browser_download_url: `${API}/download/omp-webui-v0.12.0.dmg` },
	];
	expect(parseRelease(release({}, asset(500 * 1024 * 1024)), API)?.release.asset?.size).toBe(500 * 1024 * 1024);
	expect(parseRelease(release({}, asset(500 * 1024 * 1024 + 1)), API)).toBeNull();
	expect(parseRelease(release({}, asset(Number.MAX_SAFE_INTEGER)), API)).toBeNull();
});

test("the release page the card links to is GitHub's: another host, or plain http, is replaced by this repository's page for the tag", () => {
	const own = "https://github.com/9s94ttyfct-bit/omp-webui/releases/tag/v0.12.0";
	expect(
		parseRelease(release({ html_url: "https://github.com/9s94ttyfct-bit/omp-webui/releases/tag/v0.12.0" }), API)
			?.release.url,
	).toBe(own);
	for (const url of [
		"https://evil.example/releases/tag/v0.12.0",
		"http://github.com/9s94ttyfct-bit/omp-webui/releases/tag/v0.12.0",
		"https://github.com.evil.example/x",
		"javascript:alert(1)",
		"file:///etc/passwd",
		42,
		null,
	]) {
		expect(parseRelease(release({ html_url: url }), API)?.release.url, String(url)).toBe(own);
	}
});

test("a redirect may only go on to GitHub's own hosts over https", () => {
	for (const url of [
		"https://github.com/9s94ttyfct-bit/omp-webui/releases/download/v0.12.0/omp-webui-v0.12.0.dmg",
		"https://objects.githubusercontent.com/github-production-release-asset/1",
		"https://release-assets.githubusercontent.com/github-production-release-asset/1",
	]) {
		expect(redirectAllowed(new URL(url)), url).toBe(true);
	}
	for (const url of [
		"http://github.com/x",
		"http://objects.githubusercontent.com/x",
		"https://evil.example/x",
		"https://github.com.evil.example/x",
		"https://evilgithubusercontent.com/x",
		"https://githubusercontent.com.evil.example/x",
		"https://api.github.com.evil.example/x",
		"http://127.0.0.1:9999/x",
		"ftp://github.com/x",
		"file:///etc/passwd",
	]) {
		expect(redirectAllowed(new URL(url)), url).toBe(false);
	}
});
