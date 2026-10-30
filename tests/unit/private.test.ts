import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../server/config.ts";
import { ensurePrivateDir } from "../../server/private.ts";
import { SessionStore } from "../../server/sessions/store.ts";

/** The data dir holds the search index (the text of every conversation), so it is for its owner alone. */

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const scratch = () => {
	const dir = mkdtempSync(join(tmpdir(), "ompw-private-"));
	dirs.push(dir);
	return dir;
};
const mode = (path: string) => statSync(path).mode & 0o777;

test("a data dir that is created is 0700, however deep it is", () => {
	const root = scratch();
	const data = join(root, "a", "b", "data");
	loadConfig({ OMP_WEBUI_DATA_DIR: data, PI_CODING_AGENT_DIR: join(root, "agent") });
	expect(mode(data)).toBe(0o700);
});

test("one an earlier version made with the default modes is closed, and so is what is in it; links are not followed", () => {
	const root = scratch();
	const data = join(root, "data");
	mkdirSync(join(data, "exports"), { recursive: true });
	chmodSync(data, 0o755);
	chmodSync(join(data, "exports"), 0o755);
	for (const name of ["index.db", "index.db-wal", "index.db-shm", "approval.json", "pins.json"]) {
		writeFileSync(join(data, name), "x");
		chmodSync(join(data, name), 0o644);
	}
	writeFileSync(join(data, "helper"), "#!/bin/sh\n");
	chmodSync(join(data, "helper"), 0o755);
	const outside = join(root, "outside.txt");
	writeFileSync(outside, "not ours to change");
	chmodSync(outside, 0o644);
	symlinkSync(outside, join(data, "link"));

	ensurePrivateDir(data);

	expect(mode(data)).toBe(0o700);
	expect(mode(join(data, "exports"))).toBe(0o700);
	for (const name of ["index.db", "index.db-wal", "index.db-shm", "approval.json", "pins.json"]) {
		expect(mode(join(data, name)), name).toBe(0o600);
	}
	// What the owner could run, the owner still can.
	expect(mode(join(data, "helper"))).toBe(0o700);
	expect(mode(outside)).toBe(0o644);
});

test("a directory that is somebody else's is left as it is", () => {
	// root-owned /usr: not ours to change, and nothing here may throw.
	if (process.getuid?.() === 0) return;
	const before = mode("/usr");
	ensurePrivateDir("/usr");
	expect(mode("/usr")).toBe(before);
});

test("the search index and its journal files are 0600 when they are created, and tightened when an earlier version left them open", () => {
	const root = scratch();
	const fresh = new SessionStore(join(root, "sessions"), join(root, "fresh.db"));
	expect(fresh).toBeDefined();
	for (const name of ["fresh.db", "fresh.db-wal", "fresh.db-shm"]) {
		expect(mode(join(root, name)), name).toBe(0o600);
	}

	// An index from before: the first store makes it, then it is left readable by everyone.
	const old = new SessionStore(join(root, "sessions"), join(root, "old.db"));
	expect(old).toBeDefined();
	for (const name of ["old.db", "old.db-wal", "old.db-shm"]) chmodSync(join(root, name), 0o644);
	const reopened = new SessionStore(join(root, "sessions"), join(root, "old.db"));
	expect(reopened).toBeDefined();
	for (const name of ["old.db", "old.db-wal", "old.db-shm"]) {
		expect(mode(join(root, name)), name).toBe(0o600);
	}
});
