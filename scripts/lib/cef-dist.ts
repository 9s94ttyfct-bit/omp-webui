import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * The Chromium Embedded Framework the Mac app ships in `Contents/Frameworks` (scripts/app.ts): the framework of the minimal
 * macOS arm64 build of the version third_party/cef/cef-build.json pins. CEF's build index names the file and its size and
 * SHA-1; the download is checked against both, and the build's `include/cef_api_versions.h` must list the API version the
 * app is compiled against. Only the framework is kept, in `.tmp/cef-dist/<version>/`, so a build downloads it once per
 * version (about 135 MB).
 */

const CEF_INDEX_URL = "https://cef-builds.spotifycdn.com/index.json";
const CEF_FILES = "https://cef-builds.spotifycdn.com/";
export const FRAMEWORK = "Chromium Embedded Framework.framework";

export interface CefBuildFile {
	name: string;
	sha1: string;
	size: number;
}

/** What scripts/app.ts reads of CEF's build index (`index.json`). */
export interface CefIndex {
	macosarm64?: { versions?: { cef_version: string; files: (CefBuildFile & { type: string })[] }[] };
}

/** The minimal macOS arm64 file of `version` in CEF's build index; an error when the index has none. */
export function minimalFileOf(index: CefIndex, version: string): CefBuildFile {
	const build = index.macosarm64?.versions?.find((v) => v.cef_version === version);
	const file = build?.files.find((f) => f.type === "minimal");
	if (!file) throw new Error(`CEF's build index has no minimal macOS arm64 build of ${version}`);
	return { name: file.name, sha1: file.sha1, size: file.size };
}

/** The folder that holds the framework of `version`, downloaded and checked the first time. */
export async function cefFramework(root: string, version: string, apiVersion: number): Promise<string> {
	const dir = join(root, ".tmp", "cef-dist", version);
	if (existsSync(join(dir, FRAMEWORK, "Libraries", "libcef_sandbox.dylib"))) return dir;
	rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	const res = await fetch(CEF_INDEX_URL);
	if (!res.ok) throw new Error(`CEF's build index answered ${res.status}`);
	// The index's shape is CEF's; a file it does not name, or names differently, is refused below.
	const index: CefIndex = await res.json();
	const file = minimalFileOf(index, version);
	const archive = join(dir, "download.tar.bz2");
	console.log(`Downloading ${file.name} (${Math.round(file.size / 1e6)} MB) into ${dir}`);
	await download(`${CEF_FILES}${encodeURIComponent(file.name)}`, archive, file);
	const top = file.name.replace(/\.tar\.bz2$/, "");
	const unpacked = join(dir, "unpacked");
	mkdirSync(unpacked);
	const header = `${top}/include/cef_api_versions.h`;
	const tar = Bun.spawn(["tar", "xjf", archive, "-C", unpacked, header, `${top}/Release/${FRAMEWORK}`], {
		stdout: "inherit",
		stderr: "inherit",
	});
	if ((await tar.exited) !== 0) throw new Error(`Unpacking ${file.name} failed`);
	if (!new RegExp(`\\bCEF_API_VERSION_${apiVersion}\\b`).test(readFileSync(join(unpacked, header), "utf8")))
		throw new Error(`CEF ${version} does not list API version ${apiVersion}`);
	renameSync(join(unpacked, top, "Release", FRAMEWORK), join(dir, FRAMEWORK));
	rmSync(unpacked, { recursive: true, force: true });
	rmSync(archive, { force: true });
	return dir;
}

/** `url` into `file`; an error unless exactly `expected.size` bytes with `expected.sha1` came. */
async function download(url: string, file: string, expected: CefBuildFile): Promise<void> {
	const res = await fetch(url, { redirect: "error" });
	if (!res.ok || !res.body) throw new Error(`${url} answered ${res.status}`);
	const out = Bun.file(file).writer();
	const sha1 = createHash("sha1");
	let received = 0;
	for await (const chunk of res.body) {
		received += chunk.byteLength;
		if (received > expected.size) throw new Error(`${url} is longer than CEF's index says`);
		sha1.update(chunk);
		out.write(chunk);
	}
	await out.end();
	if (received !== expected.size || sha1.digest("hex") !== expected.sha1)
		throw new Error(`${url} is damaged (size or SHA-1 differs from CEF's index)`);
}
