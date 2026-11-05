import { expect, test } from "bun:test";
import { folderLabels, shortPath } from "../../web/src/lib/format.ts";

/** Folders as the page shows them: the home folder as `~`, and the folder filter's rows told apart. */

test("the home folder and the folders inside it are written from ~, and no other folder is", () => {
	const home = "/Users/jdoe";
	expect(shortPath("/Users/jdoe", home)).toBe("~");
	expect(shortPath("/Users/jdoe/app", home)).toBe("~/app");
	expect(shortPath("/Users/jdoe/app", `${home}/`)).toBe("~/app");
	expect(shortPath("/Users/jdoex/app", home)).toBe("/Users/jdoex/app");
	expect(shortPath("/Users/jdoe-work/x", home)).toBe("/Users/jdoe-work/x");
	expect(shortPath("/opt/x", home)).toBe("/opt/x");
	expect(shortPath("/opt/x", undefined)).toBe("/opt/x");
	expect(shortPath("/opt/x", "/")).toBe("/opt/x");
	expect(shortPath("C:\\Users\\jdoe\\app", "C:\\Users\\jdoe")).toBe("~\\app");
	expect(shortPath("C:\\Users\\jdoex\\app", "C:\\Users\\jdoe")).toBe("C:\\Users\\jdoex\\app");
});

test("each folder is named by its last part, and by as many more as tell it from a folder of the same name", () => {
	const labels = folderLabels(
		["/Users/jdoe/a/app", "/Users/jdoe/b/app", "/Users/jdoe/web", "/srv/x/b/app", "/Users/jdoe", "/"],
		"/Users/jdoe",
	);
	expect(Object.fromEntries(labels)).toEqual({
		"/Users/jdoe/a/app": "a/app",
		"/Users/jdoe/b/app": "~/b/app",
		"/srv/x/b/app": "x/b/app",
		"/Users/jdoe/web": "web",
		"/Users/jdoe": "~",
		"/": "/",
	});
	expect(Object.fromEntries(folderLabels(["C:\\w\\a\\app", "C:\\w\\b\\app"], undefined))).toEqual({
		"C:\\w\\a\\app": "a\\app",
		"C:\\w\\b\\app": "b\\app",
	});
});
