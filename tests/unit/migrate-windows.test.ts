// A backup and a restore on Windows, where a full path starts with a drive (`C:\`) or a share (`\\host\share\`), not
// with `/`: the paths are worked out with `path.win32`, as the server on Windows does with `node:path`.
import { describe, expect, test } from "bun:test";
import { posix, win32 } from "node:path";
import { under } from "../../server/migrate/layout.ts";
import { backupCopy, listedPaths } from "../../server/migrate/restore.ts";

describe("where a backup keeps the copy of a file", () => {
	test("on Windows the drive letter is a folder of its own, so the copy has a path Windows can make", () => {
		const dir = "C:\\Users\\jdoe\\.omp-webui\\migration-backups\\stamp";
		expect(backupCopy(dir, "C:\\Users\\jdoe\\.omp\\agent\\config.yml", win32)).toBe(
			"C:\\Users\\jdoe\\.omp-webui\\migration-backups\\stamp\\files\\C\\Users\\jdoe\\.omp\\agent\\config.yml",
		);
		expect(backupCopy(dir, "D:\\work\\a.txt", win32)).toBe(
			"C:\\Users\\jdoe\\.omp-webui\\migration-backups\\stamp\\files\\D\\work\\a.txt",
		);
	});

	test("a file on a share is kept under UNC, its host and its share", () => {
		expect(backupCopy("C:\\b", "\\\\server\\home\\jdoe\\a.yml", win32)).toBe(
			"C:\\b\\files\\UNC\\server\\home\\jdoe\\a.yml",
		);
	});

	test("on macOS and Linux it is the file's path under files/, as it always was", () => {
		const dir = "/Users/jdoe/.omp-webui/migration-backups/stamp";
		expect(backupCopy(dir, "/Users/jdoe/.omp/agent/config.yml", posix)).toBe(
			"/Users/jdoe/.omp-webui/migration-backups/stamp/files/Users/jdoe/.omp/agent/config.yml",
		);
	});
});

describe("the lists a restore reads", () => {
	test("on Windows the full paths of changed.txt and created.txt are put back or removed", () => {
		const text = "C:\\Users\\jdoe\\.omp\\agent\\config.yml\n\\\\server\\home\\a.yml\nrelative\\x\n\nC:no-root\n";
		expect(listedPaths(text, win32)).toEqual(["C:\\Users\\jdoe\\.omp\\agent\\config.yml", "\\\\server\\home\\a.yml"]);
	});

	test("on macOS and Linux a line that does not start with / is passed over", () => {
		expect(listedPaths("/Users/jdoe/a\nrelative/b\n\n/c\n", posix)).toEqual(["/Users/jdoe/a", "/c"]);
	});
});

describe("whether a path is in a folder", () => {
	test("on Windows a path in the plugins' folder is in it, with Windows' separator", () => {
		const plugins = "C:\\Users\\jdoe\\.omp\\plugins";
		expect(under(plugins, "C:\\Users\\jdoe\\.omp\\plugins\\node_modules\\x", win32)).toBe(true);
		expect(under(plugins, plugins, win32)).toBe(false);
		expect(under(plugins, "C:\\Users\\jdoe\\.omp\\plugins-old\\x", win32)).toBe(false);
	});

	test("on macOS and Linux the same", () => {
		expect(under("/Users/jdoe/.omp/plugins", "/Users/jdoe/.omp/plugins/x", posix)).toBe(true);
		expect(under("/Users/jdoe/.omp/plugins", "/Users/jdoe/.omp/plugins", posix)).toBe(false);
		expect(under("/Users/jdoe/.omp/plugins", "/Users/jdoe/.omp/plugins2/x", posix)).toBe(false);
	});
});
