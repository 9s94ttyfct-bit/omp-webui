import { isRecord } from "../../shared/guards.ts";
import { compareVersions, parseVersion } from "../../shared/omp-install.ts";
import { type AppRelease, type CheckFailure, UPDATE_REPO, type UpdateNotes } from "../../shared/update.ts";

/**
 * Looking for a newer release of the app (#571): `GET <api>/repos/<repo>/releases/latest` without credentials (the
 * repository's releases are public), kept cheap by an ETag and the rate-limit headers. What the answer says is parsed here
 * and nowhere else; the installer's address is checked before anyone downloads from it.
 */

/** GitHub's API. `OMP_WEBUI_APP_UPDATE_API` replaces it for tests (a local server that serves the same paths). */
export const DEFAULT_API = "https://api.github.com";

/** The tag a release of this app has: `vX.Y.Z` (release-local.ts and release.yml refuse anything else). */
const TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

/** The installer a release carries. */
export const installerName = (version: string): string => `omp-webui-v${version}.dmg`;

/** The largest installer taken at its word (the app's own is about 100 MB): a release that lists more is refused. */
export const MAX_INSTALLER_BYTES = 500 * 1024 * 1024;

/**
 * Whether a download may be sent on to `url` by a redirect: GitHub's own hosts over https. A release asset's address on
 * github.com answers with a redirect to GitHub's asset storage (`objects.githubusercontent.com`, and now
 * `release-assets.githubusercontent.com`); anything else — another host, plain http — is where only a hostile answer sends it.
 */
export function redirectAllowed(url: URL): boolean {
	return (
		url.protocol === "https:" && (url.hostname === "github.com" || url.hostname.endsWith(".githubusercontent.com"))
	);
}

/** What the release lists for its installer, and where to get it. */
export interface Installer {
	url: string;
	/** Lower-case hex SHA-256 GitHub computed, when it lists one. */
	sha256: string | null;
}

export interface ParsedRelease {
	release: AppRelease;
	installer: Installer | null;
}

const text = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * Whether the installer may be downloaded from `url`: from this repository's release downloads on github.com, or, for a
 * test's own server, from the address the API itself is at. Anything else in an answer is refused, however it got there.
 */
export function installerUrlAllowed(url: string, api: string): boolean {
	let target: URL;
	try {
		target = new URL(url);
	} catch {
		return false;
	}
	if (target.protocol !== "https:" && target.protocol !== "http:") return false;
	if (api === DEFAULT_API) {
		return (
			target.protocol === "https:" &&
			target.host === "github.com" &&
			target.pathname.startsWith(`/${UPDATE_REPO}/releases/download/`)
		);
	}
	try {
		return target.origin === new URL(api).origin;
	} catch {
		return false;
	}
}

/** A trailing `---` rule with what a release's body is given after the notes (the install steps, or "no installer yet"). */
function withoutTail(section: string): string {
	const lines = section.split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		if (!/^-{3,}\s*$/.test(lines[i] as string)) continue;
		const after = lines
			.slice(i + 1)
			.join("\n")
			.trim();
		if (after === "" || after.startsWith("This release has no installer yet"))
			return lines.slice(0, i).join("\n").trim();
		break;
	}
	return section.trim();
}

/** The headings `_install.md` adds to a release's body: how to open the app by hand, which the app does itself. */
const INSTALL_HEADINGS: Record<string, true> = { "Install the macOS app": true, "安装 macOS 应用": true };

/**
 * The release notes by language. A release body is `## English` + `## 中文` sections (scripts/check-release-notes.ts), then
 * the install steps `scripts/release-local.ts` appends (or a line that no installer is attached yet): neither of those is
 * notes. A body with neither section (older notes) is shown whole, as English.
 */
export function splitNotes(body: string | null): UpdateNotes {
	if (!body?.trim()) return { en: "", zh: "" };
	const sections = new Map<string, string[]>();
	const before: string[] = [];
	let current: string | null = null;
	for (const line of body.replace(/\r\n/g, "\n").split("\n")) {
		const heading = /^## +(.+?) *$/.exec(line);
		if (heading) {
			current = heading[1] as string;
			if (!sections.has(current)) sections.set(current, []);
		} else if (current === null) {
			before.push(line);
		} else if (!Object.hasOwn(INSTALL_HEADINGS, current)) {
			sections.get(current)?.push(line);
		}
	}
	const english = sections.get("English");
	const chinese = sections.get("中文");
	if (english === undefined && chinese === undefined) {
		// Not bilingual: what comes before the install steps, in full. The tail rule is cut as for a section.
		const rest = [...before];
		for (const [name, lines] of sections) if (!Object.hasOwn(INSTALL_HEADINGS, name)) rest.push(`## ${name}`, ...lines);
		return { en: withoutTail(rest.join("\n")), zh: "" };
	}
	return { en: withoutTail((english ?? []).join("\n")), zh: withoutTail((chinese ?? []).join("\n")) };
}

/**
 * The release in a `releases/latest` answer; null when it is none this app can use: no `vX.Y.Z` tag, a draft or a
 * prerelease (the API never answers one, a stand-in might), or an installer at an address `installerUrlAllowed` refuses.
 * A release without the installer is a release (the notes are shown) with no installer.
 */
export function parseRelease(json: unknown, api: string): ParsedRelease | null {
	if (!isRecord(json)) return null;
	const tag = text(json.tag_name);
	const m = tag === null ? null : TAG.exec(tag);
	if (tag === null || !m) return null;
	if (json.draft === true || json.prerelease === true) return null;
	const version = `${m[1]}.${m[2]}.${m[3]}`;
	let url = text(json.html_url);
	// The page the card links to: GitHub's, for this app (anything else in an answer is not a place to send the user).
	if (url === null || !url.startsWith("https://github.com/"))
		url = `https://github.com/${UPDATE_REPO}/releases/tag/${tag}`;

	let asset: AppRelease["asset"] = null;
	let installer: Installer | null = null;
	const wanted = installerName(version);
	for (const item of Array.isArray(json.assets) ? json.assets : []) {
		if (!isRecord(item) || item.name !== wanted) continue;
		// An upload that is not finished is no installer yet.
		if (item.state !== undefined && item.state !== "uploaded") continue;
		const size = item.size;
		const downloadUrl = text(item.browser_download_url);
		if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0 || size > MAX_INSTALLER_BYTES) return null;
		if (downloadUrl === null) return null;
		if (!installerUrlAllowed(downloadUrl, api)) return null;
		const digest = /^sha256:([0-9a-fA-F]{64})$/.exec(text(item.digest) ?? "");
		asset = { name: wanted, size };
		installer = { url: downloadUrl, sha256: digest ? (digest[1] as string).toLowerCase() : null };
		break;
	}
	return {
		release: {
			tag,
			version,
			publishedAt: text(json.published_at),
			url,
			notes: splitNotes(text(json.body)),
			asset,
		},
		installer,
	};
}

/** Whether `release` is newer than the running `installed` version (never an older or equal one: no downgrade). */
export function isNewer(release: Pick<AppRelease, "version">, installed: string): boolean {
	return parseVersion(installed) !== null && compareVersions(release.version, installed) > 0;
}

/** What GitHub says of the request budget, from the headers of any answer. */
export interface RateLimit {
	/** Epoch ms before which no request should be made, when the budget is spent; null otherwise. */
	blockedUntil: number | null;
}

function rateLimitOf(headers: Headers, status: number, now: number): RateLimit {
	const retryAfter = Number(headers.get("retry-after"));
	if (headers.has("retry-after") && Number.isFinite(retryAfter) && retryAfter >= 0)
		return { blockedUntil: now + retryAfter * 1000 };
	const reset = Number(headers.get("x-ratelimit-reset"));
	const spent = headers.get("x-ratelimit-remaining") === "0" || status === 429;
	if (spent && Number.isFinite(reset) && reset > 0) return { blockedUntil: reset * 1000 };
	return { blockedUntil: status === 429 ? now + 60 * 60_000 : null };
}

export type Fetched =
	| { kind: "release"; etag: string | null; body: unknown; rate: RateLimit }
	| { kind: "notModified"; rate: RateLimit }
	| { kind: "failure"; failure: CheckFailure; rate: RateLimit };

export interface FetchOptions {
	api: string;
	/** The ETag of the answer this one may be, for `If-None-Match`. */
	etag: string | null;
	userAgent: string;
	fetch?: typeof fetch;
	now?: () => number;
	timeoutMs?: number;
}

/** One request for the latest release. Never throws: every way it can go wrong is a `failure` that says which. */
export async function fetchLatest(opts: FetchOptions): Promise<Fetched> {
	const now = opts.now ?? Date.now;
	const none: RateLimit = { blockedUntil: null };
	const headers: Record<string, string> = {
		accept: "application/vnd.github+json",
		"x-github-api-version": "2022-11-28",
		"user-agent": opts.userAgent,
	};
	if (opts.etag) headers["if-none-match"] = opts.etag;
	let res: Response;
	try {
		res = await (opts.fetch ?? fetch)(`${opts.api}/repos/${UPDATE_REPO}/releases/latest`, {
			headers,
			signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
		});
	} catch {
		return { kind: "failure", failure: { code: "offline" }, rate: none };
	}
	const rate = rateLimitOf(res.headers, res.status, now());
	if (res.status === 304) return { kind: "notModified", rate };
	if (res.status === 404) return { kind: "failure", failure: { code: "noRelease" }, rate };
	if (res.status === 429 || (res.status === 403 && rate.blockedUntil !== null)) {
		return { kind: "failure", failure: { code: "rateLimited", retryAt: rate.blockedUntil }, rate };
	}
	if (res.status !== 200) return { kind: "failure", failure: { code: "http", status: res.status }, rate };
	let body: unknown;
	try {
		body = await res.json();
	} catch {
		return { kind: "failure", failure: { code: "badAnswer" }, rate };
	}
	return { kind: "release", etag: res.headers.get("etag"), body, rate };
}
