import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { profileDirs, relativeTo, SessionRoots } from "../../server/sessions/roots.ts";
import { removeScratch } from "../support/scratch.ts";

/** Which root a session file is in is decided with the path rules of the system: Windows separates with a backslash (#361). */

test("a file is inside a folder by the separator of the system, on Windows too", () => {
	const dir = "C:\\Users\\jdoe\\.omp\\profiles\\work\\agent\\sessions";
	const file = `${dir}\\-C--work\\2026-11-01T00-00-00-000Z_01a.jsonl`;
	expect(relativeTo(dir, file, path.win32)).toBe("-C--work\\2026-11-01T00-00-00-000Z_01a.jsonl");
	// Not the folder itself, not a sibling that starts with its name, not another drive, not above it.
	expect(relativeTo(dir, dir, path.win32)).toBeNull();
	expect(relativeTo(dir, `${dir}-other\\a.jsonl`, path.win32)).toBeNull();
	expect(relativeTo(dir, "D:\\a.jsonl", path.win32)).toBeNull();
	expect(relativeTo(dir, "C:\\Users\\jdoe\\.omp\\profiles\\work\\agent\\a.jsonl", path.win32)).toBeNull();
	// A file whose name starts with two dots is inside.
	expect(relativeTo(dir, `${dir}\\..hidden.jsonl`, path.win32)).toBe("..hidden.jsonl");
});

test("the same on POSIX paths", () => {
	expect(relativeTo("/s/a", "/s/a/b/c.jsonl", path.posix)).toBe("b/c.jsonl");
	expect(relativeTo("/s/a", "/s/a", path.posix)).toBeNull();
	expect(relativeTo("/s/a", "/s/ab/c.jsonl", path.posix)).toBeNull();
	expect(relativeTo("/s/a", "/s/c.jsonl", path.posix)).toBeNull();
});

const root = mkdtempSync(path.join(tmpdir(), "ompw-roots-paths-"));
afterAll(() => removeScratch(root));

test("the images of every known agent directory are looked in: the server's own and each profile's", () => {
	const home = path.join(root, "home");
	const agentDir = path.join(home, ".omp", "agent");
	const dataDir = path.join(root, "data");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(dataDir, { recursive: true });
	const roots = new SessionRoots(dataDir, home, agentDir);
	expect(roots.blobFolders()).toEqual([path.join(agentDir, "blobs")]);
	roots.note(["--profile=work"], root);
	roots.note(["--profile=work"], root);
	expect(roots.blobFolders()).toEqual([
		path.join(agentDir, "blobs"),
		path.join(profileDirs("work", home, {}).agentDir, "blobs"),
	]);
});
