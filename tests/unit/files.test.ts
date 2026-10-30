import { afterEach, expect, setSystemTime, test, vi } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FileIndex, type ReadDir, SCAN_LIMITS, scanFiles, suggestFiles } from "../../server/files.ts";

/** `@` file completion: a bounded walk that skips hidden and heavy directories before entering them. */

/** A scripted file system: directory path -> entry names (a trailing `/` marks a directory). */
function fakeFs(dirs: Record<string, string[]>) {
	const reads: string[] = [];
	const readDir: ReadDir = async (dir) => {
		reads.push(dir);
		return (dirs[dir] ?? []).map((name) => ({
			name: name.replace(/\/$/, ""),
			isDirectory: () => name.endsWith("/"),
			isFile: () => !name.endsWith("/"),
		}));
	};
	return { readDir, reads };
}

/** Every directory holds five subdirectories and five files, without end. */
function endlessFs() {
	const reads: string[] = [];
	const readDir: ReadDir = async (dir) => {
		reads.push(dir);
		const names = ["d0/", "d1/", "d2/", "d3/", "d4/", "f0", "f1", "f2", "f3", "f4"];
		return names.map((name) => ({
			name: name.replace(/\/$/, ""),
			isDirectory: () => name.endsWith("/"),
			isFile: () => !name.endsWith("/"),
		}));
	};
	return { readDir, reads };
}

const depth = (path: string) => path.split("/").length;

test("hidden and dependency directories are skipped before they are read", async () => {
	const { readDir, reads } = fakeFs({
		"/p": [
			"src/",
			"node_modules/",
			".git/",
			".cache/",
			".github/",
			"dist/",
			"build/",
			"target/",
			"__pycache__/",
			"constructor/",
			".env",
			"README.md",
		],
		"/p/src": ["app.ts", "node_modules/"],
		"/p/.github": ["ci.yml"],
		"/p/constructor": ["x.ts"],
		// Never to be read:
		"/p/node_modules": ["huge.js"],
		"/p/.git": ["HEAD"],
		"/p/.cache": ["blob"],
		"/p/dist": ["a.js"],
		"/p/build": ["a.o"],
		"/p/target": ["a.rs"],
		"/p/__pycache__": ["a.pyc"],
		"/p/src/node_modules": ["dep.js"],
	});

	const { files } = await scanFiles("/p", SCAN_LIMITS, readDir);

	// Hidden files are suggested; of the hidden directories only `.github` is walked; a directory named
	// like an Object.prototype member is an ordinary directory.
	expect(files).toEqual([".env", ".github/ci.yml", "README.md", "constructor/x.ts", "src/app.ts"]);
	expect([...reads].sort()).toEqual(["/p", "/p/.github", "/p/constructor", "/p/src"]);
});

test.skipIf(process.platform !== "darwin")(
	"~/Library is not walked when the home folder is the working directory",
	async () => {
		const home = realpathSync(homedir());
		const { readDir, reads } = fakeFs({
			[home]: ["Library/", "Documents/"],
			[`${home}/Library`]: ["Caches/"],
			[`${home}/Documents`]: ["notes.txt"],
		});

		expect((await scanFiles(home, SCAN_LIMITS, readDir)).files).toEqual(["Documents/notes.txt"]);
		expect(reads).not.toContain(`${home}/Library`);
	},
);

test("the walk stops at the entry limit and keeps the shallowest files", async () => {
	const { readDir, reads } = endlessFs();

	const { files, complete } = await scanFiles("/w", { maxFiles: 1_000_000, maxEntries: 200, maxMs: 60_000 }, readDir);

	// 10 entries at the root, 50 one level down, 250 below that: the limit falls inside the third level.
	expect(Math.max(...files.map(depth))).toBeLessThanOrEqual(3);
	expect(files.length).toBeGreaterThan(30);
	expect(files.length).toBeLessThanOrEqual(200);
	expect(reads.length).toBeLessThan(40);
	expect(complete).toBe(false);
});

test("the walk stops at the file limit", async () => {
	const { readDir } = endlessFs();
	const { files, complete } = await scanFiles("/w", { maxFiles: 3, maxEntries: 1_000_000, maxMs: 60_000 }, readDir);
	expect(files.length).toBe(3);
	expect(complete).toBe(false);
});

test("a walk that reached every directory says it is complete", async () => {
	const { readDir } = fakeFs({ "/p": ["src/", "a.txt"], "/p/src": ["b.txt"] });
	expect(await scanFiles("/p", SCAN_LIMITS, readDir)).toEqual({ files: ["a.txt", "src/b.txt"], complete: true });
});

test("a directory that never answers does not hold the walk beyond the time limit", async () => {
	// A real event-loop turn, taken before the clock is faked: lets the reachable directories be read.
	const realSetImmediate = setImmediate;
	const settle = async () => {
		const turn = Promise.withResolvers<void>();
		realSetImmediate(turn.resolve);
		await turn.promise;
	};
	vi.useFakeTimers();
	try {
		const { readDir } = fakeFs({ "/p": ["hung/", "ok/", "a.txt"], "/p/ok": ["b.txt"] });
		const hangs: ReadDir = (dir) => (dir === "/p/hung" ? new Promise(() => {}) : readDir(dir));

		const walk = scanFiles("/p", { ...SCAN_LIMITS, maxMs: 1500 }, hangs);
		await settle();
		vi.advanceTimersByTime(1500);

		expect(await walk).toEqual({ files: ["a.txt", "ok/b.txt"], complete: false });
	} finally {
		vi.useRealTimers();
	}
});

test("concurrent requests for one directory share one scan; its result is then cached", async () => {
	const gate = Promise.withResolvers<void>();
	const scanned: string[] = [];
	const index = new FileIndex(async (dir) => {
		scanned.push(dir);
		await gate.promise;
		return { files: [`${dir}/a.ts`], complete: true };
	});

	const together = Promise.all([index.list("/p"), index.list("/p")]);
	const other = index.list("/q");
	gate.resolve();
	const [first, second] = await together;
	await other;

	expect(second).toBe(first);
	expect([...scanned].sort()).toEqual(["/p", "/q"]);
	await index.list("/p");
	expect(scanned.length).toBe(2);
});

test("a scan that fails is not remembered", async () => {
	let failing = true;
	const index = new FileIndex(async () => {
		if (failing) throw new Error("boom");
		return { files: ["a.ts"], complete: true };
	});

	await expect(index.list("/p")).rejects.toThrow("boom");
	failing = false;
	expect(await index.list("/p")).toEqual(["a.ts"]);
});

test("a file added after the last walk is offered by the next request once the burst is over", async () => {
	const onDisk = ["a.ts"];
	const scanned: string[] = [];
	const index = new FileIndex(async (dir) => {
		scanned.push(dir);
		return { files: [...onDisk], complete: true };
	});
	const start = Date.now();
	try {
		expect(await index.list("/p")).toEqual(["a.ts"]);
		onDisk.push("newfile.ts");
		// The keystrokes after `@` come within a moment of each other: one walk serves them.
		setSystemTime(start + 200);
		expect(await index.list("/p")).toEqual(["a.ts"]);
		expect(scanned.length).toBe(1);
		// The next `@`, a few seconds later (the agent wrote the file in between), walks again.
		setSystemTime(start + 3000);
		expect(await index.list("/p")).toEqual(["a.ts", "newfile.ts"]);
		expect(scanned.length).toBe(2);
	} finally {
		setSystemTime();
	}
});

test("a fresh walk skips what is kept and what is being walked, and an older walk that ends after it does not take its place", async () => {
	const onDisk = ["a.ts"];
	const gates: { resolve: () => void }[] = [];
	const index = new FileIndex(async () => {
		const seen = [...onDisk];
		const gate = Promise.withResolvers<void>();
		gates.push(gate);
		await gate.promise;
		return { files: seen, complete: true };
	});
	// The first walk is slow and read the folder before the file was added.
	const older = index.walk("/p");
	onDisk.push("newfile.ts");
	const newer = index.walk("/p", true);
	expect(gates).toHaveLength(2);
	gates[1].resolve();
	expect((await newer).files).toEqual(["a.ts", "newfile.ts"]);
	gates[0].resolve();
	expect((await older).files).toEqual(["a.ts"]);
	// What the next request is given is the newer walk's, not the older one's that ended last.
	expect((await index.walk("/p")).files).toEqual(["a.ts", "newfile.ts"]);
	expect(gates).toHaveLength(2);
});

test("a walk that a limit cut short is not kept for the next request", async () => {
	let complete = false;
	let walks = 0;
	const index = new FileIndex(async () => {
		walks++;
		return { files: ["shallow.ts"], complete };
	});

	await index.list("/p");
	await index.list("/p");
	expect(walks).toBe(2);

	// Once a walk gets to the end, its list is kept for the burst like any other.
	complete = true;
	await index.list("/p");
	await index.list("/p");
	expect(walks).toBe(3);
});

test("only a few directories are cached; the oldest is scanned again", async () => {
	const scanned: string[] = [];
	const index = new FileIndex(async (dir) => {
		scanned.push(dir);
		return { files: [], complete: true };
	});

	for (let i = 0; i < 12; i++) await index.list(`/d${i}`);
	await index.list("/d11");
	expect(scanned.filter((d) => d === "/d11").length).toBe(1);
	await index.list("/d0");
	expect(scanned.filter((d) => d === "/d0").length).toBe(2);
});

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("suggestFiles ranks matches and leaves out hidden and dependency directories", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ompw-files-"));
	dirs.push(dir);
	for (const f of [
		"README.md",
		"src/app.ts",
		"src/util/app-helpers.ts",
		".env",
		".github/workflows/ci.yml",
		"node_modules/dep/app.js",
		".git/app",
		".cache/app.bin",
	]) {
		mkdirSync(dirname(join(dir, f)), { recursive: true });
		writeFileSync(join(dir, f), "");
	}

	expect(await suggestFiles(dir, "app")).toEqual(["src/app.ts", "src/util/app-helpers.ts"]);
	expect((await suggestFiles(dir, "")).sort()).toEqual([
		".env",
		".github/workflows/ci.yml",
		"README.md",
		"src/app.ts",
		"src/util/app-helpers.ts",
	]);
	await expect(suggestFiles(join(dir, "README.md"), "")).rejects.toThrow("Not a directory");
});

test("suggestFiles offers a file created after an earlier request, a few seconds later", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ompw-files-"));
	dirs.push(dir);
	mkdirSync(join(dir, "src"));
	writeFileSync(join(dir, "src/a.ts"), "");
	const start = Date.now();
	try {
		expect(await suggestFiles(dir, "")).toEqual(["src/a.ts"]);
		writeFileSync(join(dir, "src/newfile.ts"), "");
		setSystemTime(start + 3000);
		expect(await suggestFiles(dir, "newfile")).toEqual(["src/newfile.ts"]);
	} finally {
		setSystemTime();
	}
});
