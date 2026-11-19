import { expect, test } from "bun:test";
import { buildDiffers, versionNamed } from "../../web/src/lib/page-build.ts";

test("a page that does not know its own version, or runs the server's, has nothing to tell", () => {
	expect(buildDiffers("0.27.0", "")).toBe(false);
	expect(buildDiffers("0.27.0", "0.27.0")).toBe(false);
	expect(buildDiffers("0.27.0", "0.26.0")).toBe(true);
});

test("a report names the page's version beside the server's when they differ, and the one version when they do not", () => {
	expect(versionNamed("0.27.0", "0.27.0")).toBe("0.27.0");
	expect(versionNamed("0.27.0", "")).toBe("0.27.0");
	expect(versionNamed("0.27.0", "0.26.0")).toBe("0.27.0 (page 0.26.0)");
});
