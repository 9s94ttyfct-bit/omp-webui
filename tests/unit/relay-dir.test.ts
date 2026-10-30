import { afterEach, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { privateDir, pruneRelayDir, relayDir, relayDirPath, relaySocket } from "../../server/omp/relay-client.ts";

/**
 * Where relay sockets live: in the data dir when a socket path fits, otherwise in a short directory of the user's own
 * in the temp dir, which nothing another user does there may keep from being made or trusted.
 */

const uid = process.getuid?.() as number;
const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A short directory to stand for /tmp (a path the temp dir of the machine running the tests need not fit in). */
function tmp(): string {
	const dir = mkdtempSync("/tmp/ompw-rd-");
	dirs.push(dir);
	return dir;
}

/** A data dir too deep for a socket path to be in it. */
const deep = (base: string) => join(base, "d".repeat(100));
const mode = (path: string) => statSync(path).mode & 0o777;

test("a data dir that has room for a socket keeps its relay directory, private to the user", () => {
	const base = tmp();
	const dir = relayDir(base, { tmp: base, uid });
	expect(dir).toBe(join(base, "relay"));
	expect(mode(dir)).toBe(0o700);
});

test("one that has not gets a short directory in a per-user, private one: not a name anyone else can make for it", () => {
	const base = tmp();
	const where = { tmp: base, uid };
	const data = deep(base);
	const dir = relayDir(data, where);
	expect(dir.startsWith(join(base, `ompw-${uid}`))).toBe(true);
	expect(mode(join(base, `ompw-${uid}`))).toBe(0o700);
	expect(mode(dir)).toBe(0o700);
	expect(relaySocket(data, "L123456-abcdefgh", where).length).toBeLessThan(100);
	// The same data dir is the same directory, whether or not it exists yet.
	expect(relayDirPath(data, where)).toBe(dir);
	expect(relayDir(data, where)).toBe(dir);
});

test("a directory a relay left empty is removed when the server ends, one that still holds a socket is not", () => {
	const base = tmp();
	const where = { tmp: base, uid };
	const data = deep(base);
	const dir = relayDir(data, where);
	writeFileSync(join(dir, "L1.sock"), "");
	pruneRelayDir(data, where);
	expect(readdirSync(dir)).toEqual(["L1.sock"]);
	rmSync(join(dir, "L1.sock"));
	pruneRelayDir(data, where);
	expect(existsSync(dir)).toBe(false);
	// And nothing is the matter with there being none to remove.
	expect(() => pruneRelayDir(data, where)).not.toThrow();
});

test("a directory left behind with loose permissions is tightened, not trusted as it is", () => {
	const base = tmp();
	const where = { tmp: base, uid };
	const data = deep(base);
	const root = join(base, `ompw-${uid}`);
	mkdirSync(join(root, "x"), { recursive: true });
	chmodSync(root, 0o755);
	expect(relayDir(data, where).startsWith(root)).toBe(true);
	expect(mode(root)).toBe(0o700);
});

test("a link where the per-user directory should be, or a directory that is not the user's, does not keep a conversation from starting", () => {
	const base = tmp();
	const data = deep(base);
	const elsewhere = join(base, "elsewhere");
	mkdirSync(elsewhere);
	symlinkSync(elsewhere, join(base, `ompw-${uid}`));

	const dir = relayDir(data, { tmp: base, uid });
	// A directory of its own, made for this and nothing else; nothing was made through the link.
	expect(dir.startsWith(elsewhere)).toBe(false);
	expect(dir.startsWith(join(base, "ompw-"))).toBe(true);
	expect(readdirSync(elsewhere)).toEqual([]);
	expect(mode(dir)).toBe(0o700);
	expect(relayDir(data, { tmp: base, uid })).toBe(dir);
	pruneRelayDir(data, { tmp: base, uid });
	expect(existsSync(dir)).toBe(false);

	// The same when the directory is a real one that belongs to someone else (here: we are someone else).
	const other = deep(join(base, "o"));
	mkdirSync(join(base, "o"));
	const stranger = { tmp: base, uid: uid + 1 };
	mkdirSync(join(base, `ompw-${uid + 1}`));
	const moved = relayDir(other, stranger);
	expect(moved.startsWith(join(base, `ompw-${uid + 1}`))).toBe(false);
	expect(mode(moved)).toBe(0o700);
});

test("a directory is made only where nothing but the user's own directory can be", () => {
	const base = tmp();
	expect(privateDir(join(base, "a"), uid)).toBe(true);
	expect(privateDir(join(base, "a"), uid)).toBe(true);
	expect(privateDir(join(base, "a"), uid + 1)).toBe(false);
	writeFileSync(join(base, "file"), "");
	expect(privateDir(join(base, "file"), uid)).toBe(false);
	// No directory above it to make it in.
	expect(privateDir(join(base, "none", "a"), uid)).toBe(false);
	// Where the system has no such thing as a user, any directory is the user's.
	expect(privateDir(join(base, "a"), undefined)).toBe(true);
});
