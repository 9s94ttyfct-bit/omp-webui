import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { minimalFileOf } from "../../scripts/lib/cef-dist.ts";
import { APP_CEF_VERSION } from "../../server/browser/install.ts";
import build from "../../third_party/cef/cef-build.json";

/**
 * The Mac app ships the CEF it is built against (scripts/app.ts): third_party/cef's headers and wrapper, and the framework of
 * the same release in Contents/Frameworks, whose helpers run in Chrome's macOS sandbox (#168). What the server reports as
 * the app's CEF is that release too.
 */

const root = join(import.meta.dir, "../..");
const cef = join(root, "third_party", "cef");

test("the app's headers, its API version and the version the server reports are one CEF release", () => {
	expect(readFileSync(join(cef, "include", "cef_version.h"), "utf8")).toContain(`"${build.version}"`);
	expect(readFileSync(join(cef, "include", "cef_api_versions.h"), "utf8")).toMatch(
		new RegExp(`#define CEF_API_VERSION_${build.apiVersion}\\b`),
	);
	expect(APP_CEF_VERSION).toBe(build.version);
});

test("the framework the build ships is the minimal macOS arm64 build of exactly the pinned version", () => {
	const file = (type: string, name: string) => ({ type, name, sha1: `${name}-sha1`, size: name.length });
	const index = {
		macosarm64: {
			versions: [
				{ cef_version: "999.0.0+gnewer+chromium-999.0.0.0", files: [file("minimal", "newer.tar.bz2")] },
				{
					cef_version: build.version,
					files: [file("standard", "standard.tar.bz2"), file("minimal", "pinned_minimal.tar.bz2")],
				},
			],
		},
	};
	expect(minimalFileOf(index, build.version)).toEqual({
		name: "pinned_minimal.tar.bz2",
		sha1: "pinned_minimal.tar.bz2-sha1",
		size: "pinned_minimal.tar.bz2".length,
	});
	expect(() => minimalFileOf({ macosarm64: { versions: [] } }, build.version)).toThrow(/no minimal macOS arm64 build/);
});

test("the helpers enter the sandbox before they load the framework from the app's bundle, and the app never turns it off", () => {
	const helper = readFileSync(join(root, "macos", "cef", "helper.mm"), "utf8");
	const sandbox = helper.indexOf("sandbox.Initialize(argc, argv)");
	const load = helper.indexOf("library.LoadInHelper()");
	expect(sandbox).toBeGreaterThan(-1);
	expect(load).toBeGreaterThan(sandbox);
	expect(helper).not.toContain("ompw-framework");
	const host = readFileSync(join(root, "macos", "cef", "CEFHost.mm"), "utf8");
	expect(host).not.toMatch(/no_sandbox|framework_dir_path|ompw-framework/);
	// The build puts the framework where both load it: the app's Contents/Frameworks, before the bundle is signed.
	const app = readFileSync(join(root, "scripts", "app.ts"), "utf8");
	const copy = app.indexOf('join(contents, "Frameworks", FRAMEWORK)');
	expect(copy).toBeGreaterThan(-1);
	expect(app.indexOf("signBundle(app)")).toBeGreaterThan(copy);
});
