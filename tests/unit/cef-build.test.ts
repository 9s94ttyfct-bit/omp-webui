import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CEF_API_VERSION } from "../../server/browser/install.ts";

/**
 * The CEF the server installs must be one the Mac app can load: the app is built against third_party/cef's headers at one
 * API version (scripts/app.ts reads it from cef-build.json), and the server only offers builds that list the version it
 * names (`CEF_API_VERSION`). The two must be the same, and the headers must know it.
 */

const cef = join(import.meta.dir, "../../third_party/cef");

test("the server installs CEF builds of the API version the app is built against", () => {
	const build = JSON.parse(readFileSync(join(cef, "cef-build.json"), "utf8")) as {
		version: string;
		apiVersion: number;
	};
	expect(build.apiVersion).toBe(CEF_API_VERSION);
	const versions = readFileSync(join(cef, "include", "cef_api_versions.h"), "utf8");
	expect(versions).toMatch(new RegExp(`#define CEF_API_VERSION_${CEF_API_VERSION}\\b`));
	// The headers are the release's whose version the build names.
	expect(readFileSync(join(cef, "include", "cef_version.h"), "utf8")).toContain(`"${build.version}"`);
});
