import { createHash } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { basename } from "node:path";

/**
 * A stand-in for the part of GitHub the app's updater talks to (#571), for specs and contract tests: it answers
 * `GET /repos/9s94ttyfct-bit/omp-webui/releases/latest` as the API does (an ETag and `If-None-Match`, the rate-limit
 * headers, a release's assets with their size and `sha256:` digest) and serves the installer under `/download/<name>`.
 * The server under test is pointed at it with `OMP_WEBUI_APP_UPDATE_API=<url>`; it never reaches the real GitHub.
 * Plain `node:http`, so that it runs under Playwright (Node) and Bun alike.
 */

const LATEST = "/repos/9s94ttyfct-bit/omp-webui/releases/latest";

/** A body as `scripts/release-local.ts` makes one: the notes in both languages, then the install steps. */
export const RELEASE_BODY = `## English

### Added
- The app updates itself from GitHub Releases.

## 中文

### 新增
- 应用可以从 GitHub Releases 自行更新。

---

## Install the macOS app

1. Download \`omp-webui-vX.Y.Z.dmg\` and open it.

## 安装 macOS 应用

1. 下载 \`omp-webui-vX.Y.Z.dmg\` 并打开。
`;

export interface FakeRelease {
	tag: string;
	/** The release's body (notes); `RELEASE_BODY` by default. */
	body?: string;
	/** The installer's file on disk; none: the release has no installer attached yet. */
	dmg?: string;
	/** What the asset is called; `omp-webui-<tag>.dmg` by default. */
	assetName?: string;
	/** The digest the API lists: of the file (default), none, or a given text (a wrong one). */
	digest?: "file" | "none" | string;
	/** The size the API lists: the file's (default), or another number (the download then is not that size). */
	size?: number;
	draft?: boolean;
	prerelease?: boolean;
	/** Where the asset is downloaded from, when it is not this server. */
	downloadUrl?: string;
}

export interface FakeRequest {
	method: string;
	path: string;
	headers: IncomingHttpHeaders;
}

export interface FakeReleases {
	/** The server's address: the value of `OMP_WEBUI_APP_UPDATE_API`. */
	url: string;
	/** Everything it was asked, in order. */
	requests: FakeRequest[];
	/** The latest release from now on (a new ETag). */
	publish(release: FakeRelease): void;
	/** Answer the next lookups with this status and headers instead (404, 403 with a spent budget…); `publish` ends it. */
	answer(status: number, headers?: Record<string, string>, body?: string): void;
	/** Serve the installer `chunkBytes` at a time, `everyMs` apart: a download that can be watched and cancelled. */
	throttle(chunkBytes: number, everyMs: number): void;
	/** How many times `path` (a lookup or a download) was asked for. */
	count(path: string): number;
	stop(): Promise<void>;
}

export async function startFakeReleases(): Promise<FakeReleases> {
	const requests: FakeRequest[] = [];
	let latest: FakeRelease | null = null;
	let forced: { status: number; headers: Record<string, string>; body: string } | null = null;
	let version = 0;
	let throttled: { chunkBytes: number; everyMs: number } | null = null;
	const files = new Map<string, string>();

	const server: Server = createServer((req, res) => {
		const path = req.url ?? "";
		requests.push({ method: req.method ?? "GET", path, headers: req.headers });
		if (path === LATEST) {
			if (forced) {
				res.writeHead(forced.status, { "content-type": "application/json", ...forced.headers });
				res.end(forced.body);
				return;
			}
			if (!latest) {
				res.writeHead(404, { "content-type": "application/json" });
				res.end('{"message":"Not Found"}');
				return;
			}
			const etag = `W/"fake-${version}"`;
			const rate = { "x-ratelimit-limit": "60", "x-ratelimit-remaining": "59" };
			if (req.headers["if-none-match"] === etag) {
				res.writeHead(304, { etag, ...rate });
				res.end();
				return;
			}
			res.writeHead(200, { "content-type": "application/json", etag, ...rate });
			res.end(JSON.stringify(describe(latest, origin(), files)));
			return;
		}
		const m = /^\/download\/([^/?]+)/.exec(path);
		const file = m ? files.get(decodeURIComponent(m[1] as string)) : undefined;
		if (!file) {
			res.writeHead(404);
			res.end();
			return;
		}
		const size = statSync(file).size;
		res.writeHead(200, { "content-type": "application/x-apple-diskimage", "content-length": String(size) });
		if (!throttled) {
			createReadStream(file).pipe(res);
			return;
		}
		const { chunkBytes, everyMs } = throttled;
		const bytes = readFileSync(file);
		let offset = 0;
		const timer = setInterval(() => {
			if (offset >= bytes.length) {
				clearInterval(timer);
				res.end();
				return;
			}
			res.write(bytes.subarray(offset, offset + chunkBytes));
			offset += chunkBytes;
		}, everyMs);
		res.on("close", () => clearInterval(timer));
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	const origin = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

	return {
		url: origin(),
		requests,
		publish(release) {
			latest = release;
			forced = null;
			version++;
			if (release.dmg) files.set(release.assetName ?? `omp-webui-${release.tag}.dmg`, release.dmg);
		},
		answer(status, headers = {}, body = "{}") {
			forced = { status, headers, body };
		},
		throttle(chunkBytes, everyMs) {
			throttled = { chunkBytes, everyMs };
		},
		count: (path) => requests.filter((r) => r.path === path).length,
		stop() {
			const closed = Promise.withResolvers<void>();
			server.close(() => closed.resolve());
			server.closeAllConnections();
			return closed.promise;
		},
	};
}

/** The API's JSON for `release`, with the asset's address on this server. */
function describe(release: FakeRelease, origin: string, files: Map<string, string>): unknown {
	const name = release.assetName ?? `omp-webui-${release.tag}.dmg`;
	const assets: unknown[] = [];
	if (release.dmg) {
		const bytes = readFileSync(release.dmg);
		const digest =
			release.digest === "none"
				? undefined
				: release.digest === undefined || release.digest === "file"
					? `sha256:${createHash("sha256").update(bytes).digest("hex")}`
					: release.digest;
		assets.push({
			name,
			state: "uploaded",
			size: release.size ?? bytes.length,
			browser_download_url: release.downloadUrl ?? `${origin}/download/${encodeURIComponent(basename(name))}`,
			...(digest ? { digest } : {}),
		});
		files.set(name, release.dmg);
	}
	return {
		tag_name: release.tag,
		name: `omp-webui ${release.tag}`,
		draft: release.draft ?? false,
		prerelease: release.prerelease ?? false,
		html_url: `https://github.com/9s94ttyfct-bit/omp-webui/releases/tag/${release.tag}`,
		published_at: "2026-10-21T08:00:00Z",
		body: release.body ?? RELEASE_BODY,
		assets,
	};
}
