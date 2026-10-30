import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	truncateSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hiddenByDefault } from "../../server/files.ts";
import {
	FolderError,
	findFiles,
	holdsPrivateKey,
	inside,
	isPackageDir,
	isSecretLooking,
	listFolder,
	looksBinary,
	neverOpened,
	openFolderDir,
	openFolderFile,
	readFolderDocument,
	readFolderFile,
	readFolderImage,
	resolveInside,
	rootOf,
	systemPackageProbe,
	viewOf,
} from "../../server/folder.ts";
import { handleFolder } from "../../server/folder-routes.ts";
import { parseMarks } from "../../server/git-marks.ts";
import { isThisComputer } from "../../server/this-computer.ts";
import { FOLDER_LIMITS, mentionOf } from "../../shared/folder.ts";

/**
 * The Files tab's server side on a real folder: what a page may name (a path inside the conversation's folder and
 * nothing else), how a folder is listed, which files are text, and what is handed to macOS.
 *
 *   world/
 *     proj/            the conversation's folder
 *     secret/          outside it: what no path may reach
 */

let world: string;
let proj: string;
let root: string;

const refused = async (promise: Promise<unknown>, status: number) => {
	const error = await promise.then(
		() => null,
		(e: unknown) => e,
	);
	expect(error, "a refusal").toBeInstanceOf(FolderError);
	expect<number>((error as FolderError).status).toBe(status);
};

const write = (rel: string, data: string | Uint8Array, base = proj) => {
	const path = join(base, rel);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, data);
};

beforeAll(async () => {
	world = realpathSync(mkdtempSync(join(tmpdir(), "ompw-folder-")));
	proj = join(world, "proj");
	mkdirSync(proj);
	mkdirSync(join(world, "secret"));
	writeFileSync(join(world, "secret", "key.txt"), "the secret");
	writeFileSync(join(world, "outside.txt"), "outside");
	// A sibling whose name starts with the folder's own: a check by prefix would let it in.
	mkdirSync(join(world, "proj-evil"));
	writeFileSync(join(world, "proj-evil", "x.txt"), "evil");
	write("src/app.ts", "export const a = 1;\n");
	write("src/b.ts", "export const b = 2;\n");
	write("README.md", "# Hello\n");
	write("notes with space.txt", "hi");
	root = await rootOf(proj);
});

afterAll(() => rmSync(world, { recursive: true, force: true }));

describe("the root", () => {
	test("is the real location of the folder, and must be a folder", async () => {
		expect(root).toBe(proj);
		await refused(rootOf(join(world, "outside.txt")), 404);
		await refused(rootOf(join(world, "missing")), 404);
		await refused(rootOf("relative/dir"), 404);
		await refused(rootOf(""), 404);
	});

	test("a folder reached by a link is its real location", async () => {
		symlinkSync(proj, join(world, "alias"));
		expect(await rootOf(join(world, "alias"))).toBe(proj);
	});
});

describe("the path guard", () => {
	test("`inside` is the folder and what is in it, by whole names", () => {
		expect(inside("/w/proj", "/w/proj")).toBe(true);
		expect(inside("/w/proj", "/w/proj/a/b")).toBe(true);
		expect(inside("/w/proj", "/w/proj-evil")).toBe(false);
		expect(inside("/w/proj", "/w/proj-evil/x")).toBe(false);
		expect(inside("/w/proj", "/w")).toBe(false);
		expect(inside("/w/proj", "/w/other")).toBe(false);
		expect(inside("/", "/anything")).toBe(true);
	});

	test("`..` is refused wherever it stands, whether or not the path would come back in", async () => {
		for (const path of ["..", "../secret/key.txt", "src/../..", "src/../../secret", "a/b/../../..", "src/.."])
			await refused(resolveInside(root, path), 403);
		// Even one that stays inside: the page never writes one, and a path that tries is not trusted to mean what it says.
		await refused(resolveInside(root, "src/../README.md"), 403);
	});

	test("an absolute path is refused, inside the folder or not", async () => {
		await refused(resolveInside(root, "/etc/passwd"), 403);
		await refused(resolveInside(root, join(root, "README.md")), 403);
		await refused(resolveInside(root, "//etc/passwd"), 403);
	});

	test("what is not a path is refused before the file system is asked", async () => {
		for (const path of ["a\0b", "x".repeat(5000), 5, null, undefined, {}])
			await refused(resolveInside(root, path), 400);
	});

	test("names that only look like `..` are names", async () => {
		write("..hidden", "x");
		write("a..b/c.txt", "x");
		expect((await resolveInside(root, "..hidden")).rel).toBe("..hidden");
		expect((await resolveInside(root, "a..b/c.txt")).rel).toBe("a..b/c.txt");
	});

	test("the folder itself, and a path written untidily, resolve to what they name", async () => {
		expect(await resolveInside(root, "")).toEqual({ abs: root, rel: "" });
		expect(await resolveInside(root, ".")).toEqual({ abs: root, rel: "" });
		expect(await resolveInside(root, "./src//app.ts")).toEqual({ abs: join(root, "src/app.ts"), rel: "src/app.ts" });
	});

	test("a link that leads out of the folder is refused, to a file, to a folder and through a folder", async () => {
		symlinkSync(join(world, "outside.txt"), join(proj, "out-file"));
		symlinkSync(join(world, "secret"), join(proj, "out-dir"));
		symlinkSync(join(world, "proj-evil"), join(proj, "evil-dir"));
		await refused(resolveInside(root, "out-file"), 403);
		await refused(resolveInside(root, "out-dir"), 403);
		await refused(resolveInside(root, "out-dir/key.txt"), 403);
		await refused(resolveInside(root, "evil-dir/x.txt"), 403);
		await refused(listFolder(root, "out-dir", { all: true, marks: null }), 403);
		await refused(readFolderFile(root, "out-file", false), 403);
		await refused(readFolderFile(root, "out-dir/key.txt", false), 403);
		await refused(readFolderImage(root, "out-dir/key.png"), 403);
	});

	test("a chain of links that ends outside is refused, and one that ends inside is not", async () => {
		symlinkSync(join(proj, "chain-b"), join(proj, "chain-a"));
		symlinkSync(join(world, "outside.txt"), join(proj, "chain-b"));
		await refused(resolveInside(root, "chain-a"), 403);
		symlinkSync(join(proj, "src"), join(proj, "in-dir"));
		expect((await resolveInside(root, "in-dir/app.ts")).abs).toBe(join(root, "src/app.ts"));
	});

	test("a link that points up and out by `..` is refused as any other", async () => {
		symlinkSync("../secret/key.txt", join(proj, "up-and-out"));
		await refused(resolveInside(root, "up-and-out"), 403);
	});

	test("a missing path is not found, but one that would be outside is refused, so that what is out there cannot be probed", async () => {
		await refused(resolveInside(root, "out-dir/nothing-here.png"), 403);
		await refused(resolveInside(root, "out-dir/a/b/c"), 403);
		await refused(resolveInside(root, "out-file/below"), 403);
		await refused(resolveInside(root, "nope.txt"), 404);
		await refused(resolveInside(root, "src/app.ts/deeper"), 404);
		symlinkSync(join(world, "missing-target"), join(proj, "dangling"));
		await refused(resolveInside(root, "dangling"), 404);
	});
});

describe("listing a folder", () => {
	test("folders first, then files, each by name with numbers by value", async () => {
		const dir = join(proj, "sorted");
		for (const name of ["file10.txt", "file2.txt", "File1.txt", "b.txt", "A.txt"]) write(name, "x", dir);
		for (const name of ["zeta", "Alpha", "beta"]) mkdirSync(join(dir, name));
		const listing = await listFolder(root, "sorted", { all: false, marks: null });
		expect(listing.path).toBe("sorted");
		expect(listing.root).toBe(root);
		expect(listing.entries.map((e) => `${e.kind}:${e.name}`)).toEqual([
			"dir:Alpha",
			"dir:beta",
			"dir:zeta",
			"file:A.txt",
			"file:b.txt",
			"file:File1.txt",
			"file:file2.txt",
			"file:file10.txt",
		]);
		expect(listing.git).toBe(false);
		expect(listing.truncated).toBe(false);
	});

	test("dotfiles, dependency and build folders and what .gitignore names are hidden, and counted", async () => {
		const dir = join(proj, "hide");
		mkdirSync(join(dir, "node_modules/pkg"), { recursive: true });
		for (const name of ["dist", "build", "target", "__pycache__", ".git", ".cache", ".github", "src"])
			mkdirSync(join(dir, name));
		for (const name of [".env", ".gitignore", "keep.ts", "ignored.log"]) write(name, "x", dir);
		const marks = parseMarks("! hide/ignored.log\0", "");
		const shown = await listFolder(root, "hide", { all: false, marks });
		// `.github` is the one hidden folder the `@` walk keeps; a dotfile is hidden whatever its name.
		expect(shown.entries.map((e) => e.name)).toEqual([".github", "src", "keep.ts"]);
		expect(shown.hiddenCount).toBe(10);
		const all = await listFolder(root, "hide", { all: true, marks });
		expect(all.hiddenCount).toBe(0);
		expect(all.entries.filter((e) => e.hidden).map((e) => e.name)).toEqual([
			"__pycache__",
			".cache",
			".git",
			"build",
			"dist",
			"node_modules",
			"target",
			".env",
			".gitignore",
			"ignored.log",
		]);
		expect(all.entries.find((e) => e.name === "keep.ts")?.hidden).toBeUndefined();
	});

	test("the rules are those of the `@` completion walk", () => {
		for (const name of ["node_modules", "dist", "build", "target", "__pycache__", ".git", ".venv"])
			expect(hiddenByDefault(name, true, `/p/${name}`), name).toBe(true);
		for (const name of ["src", ".github", "lib", "docs"])
			expect(hiddenByDefault(name, true, `/p/${name}`), name).toBe(false);
		expect(hiddenByDefault(".env", false, "/p/.env")).toBe(true);
		expect(hiddenByDefault("dist", false, "/p/dist")).toBe(false);
		expect(hiddenByDefault("app.ts", false, "/p/app.ts")).toBe(false);
	});

	test("a link inside is listed as what it leads to, one that leads out is a leaf that is never followed", async () => {
		const listing = await listFolder(root, "", { all: true, marks: null });
		const byName = Object.fromEntries(listing.entries.map((e) => [e.name, e]));
		expect(byName["in-dir"]).toMatchObject({ kind: "dir", link: "in" });
		expect(byName["out-dir"]).toMatchObject({ kind: "file", link: "out" });
		expect(byName["out-file"]).toMatchObject({ kind: "file", link: "out" });
		expect(byName.dangling).toMatchObject({ kind: "file", link: "out" });
		expect(byName.src).not.toHaveProperty("link");
	});

	test("a file is not a folder", async () => {
		await refused(listFolder(root, "README.md", { all: false, marks: null }), 400);
	});

	test("a folder of more entries than the limit is cut, and says so", async () => {
		const dir = join(proj, "big");
		mkdirSync(dir);
		for (let i = 0; i < FOLDER_LIMITS.listEntries + 3; i++)
			writeFileSync(join(dir, `f${String(i).padStart(5, "0")}`), "");
		const listing = await listFolder(root, "big", { all: false, marks: null });
		expect(listing.truncated).toBe(true);
		expect(listing.entries).toHaveLength(FOLDER_LIMITS.listEntries);
	});

	test("git marks are on the entries, and a folder is changed when something below it is", async () => {
		const marks = parseMarks(
			["1 .M N... 100644 100644 100644 a b src/app.ts", "? src/new.ts", "? fresh/", ""].join("\0"),
			"",
		);
		write("fresh/one.txt", "x");
		const src = await listFolder(root, "src", { all: false, marks });
		expect(Object.fromEntries(src.entries.map((e) => [e.name, e.git]))).toEqual({
			"app.ts": "modified",
			"b.ts": undefined,
		});
		const top = await listFolder(root, "", { all: false, marks });
		expect(top.git).toBe(true);
		expect(top.entries.find((e) => e.name === "src")?.git).toBe("changed");
		expect(top.entries.find((e) => e.name === "fresh")?.git).toBe("untracked");
		expect(top.entries.find((e) => e.name === "README.md")?.git).toBeUndefined();
	});
});

describe("git marks", () => {
	const record = (...lines: string[]) => `${lines.join("\0")}\0`;

	test("modified, added, renamed, conflicted and untracked files are marked", () => {
		const marks = parseMarks(
			record(
				"1 .M N... 100644 100644 100644 aaa bbb mod.ts",
				"1 A. N... 000000 100644 100644 000 bbb added.ts",
				"1 AM N... 000000 100644 100644 000 bbb added-then-edited.ts",
				"2 R. N... 100644 100644 100644 aaa bbb R100 renamed.ts",
				"old-name.ts",
				"u UU N... 100644 100644 100644 100644 a b c conflict.ts",
				"1 .D N... 100644 100644 000000 a b deleted.ts",
				"? loose.txt",
				"? newdir/",
				"! out.log",
				"! cache/",
			),
			"",
		);
		expect(Object.fromEntries(marks.files)).toEqual({
			"mod.ts": "modified",
			"added.ts": "added",
			"added-then-edited.ts": "added",
			"renamed.ts": "added",
			"conflict.ts": "conflict",
			"deleted.ts": "modified",
			"loose.txt": "untracked",
		});
		expect([...marks.untrackedDirs]).toEqual(["newdir"]);
		expect([...marks.ignored].sort()).toEqual(["cache/", "out.log"]);
	});

	test("paths with spaces are whole, and the old name of a rename is not a record of its own", () => {
		const marks = parseMarks(
			record(
				"1 .M N... 100644 100644 100644 aaa bbb my file.ts",
				"2 R. N... 1 2 3 a b R100 new name.ts",
				"old name.ts",
				"? a b/c d.txt",
			),
			"",
		);
		expect([...marks.files.keys()]).toEqual(["my file.ts", "new name.ts", "a b/c d.txt"]);
	});

	test("a conversation in a folder of the repository sees only what is in it, and its own folder is no mark", () => {
		const marks = parseMarks(
			record("1 .M N... 1 2 3 a b pkg/web/a.ts", "1 .M N... 1 2 3 a b pkg/api/b.ts", "? pkg/web/", "! pkg/web/dist/"),
			"pkg/web/",
		);
		expect([...marks.files.keys()]).toEqual(["a.ts"]);
		expect([...marks.ignored]).toEqual(["dist/"]);
		// The folder the conversation works in is itself untracked: that is not a mark of anything in it.
		expect(marks.untrackedDirs.size).toBe(0);
	});
});

describe("text and binary", () => {
	test("a NUL byte, or mostly control bytes, or mostly invalid UTF-8 is binary; words in any script are not", () => {
		expect(looksBinary(new Uint8Array(0))).toBe(false);
		expect(looksBinary(new TextEncoder().encode("plain text\nwith\ttabs and \x1b[31mcolour\x1b[0m\r\n"))).toBe(false);
		expect(looksBinary(new TextEncoder().encode("日本語のテキスト，中文，العربية, русский"))).toBe(false);
		expect(looksBinary(new Uint8Array([0x68, 0x69, 0x00, 0x21]))).toBe(true);
		expect(looksBinary(new Uint8Array(Array.from({ length: 100 }, (_, i) => (i % 2 ? 0x01 : 0x41))))).toBe(true);
		// A GBK or Latin-1 file: bytes that are not UTF-8, more than a tenth of the text.
		expect(looksBinary(new Uint8Array(Array.from({ length: 100 }, () => 0xff)))).toBe(true);
		// A PNG, an ELF and a zip start with a NUL or high bytes within the first words.
		expect(looksBinary(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]))).toBe(true);
		expect(looksBinary(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0]))).toBe(true);
	});

	test("a file opens as code, Markdown or an SVG by its name", () => {
		expect(viewOf("a.md")).toBe("markdown");
		expect(viewOf("A.MARKDOWN")).toBe("markdown");
		expect(viewOf("logo.svg")).toBe("svg");
		expect(viewOf("a.ts")).toBe("code");
		expect(viewOf("Makefile")).toBe("code");
		expect(viewOf(".md")).toBe("code");
	});

	test("a text file is read with its size, and its first megabyte when it is larger", async () => {
		const small = await readFolderFile(root, "src/app.ts", true);
		expect(small).toMatchObject({
			kind: "text",
			path: "src/app.ts",
			text: "export const a = 1;\n",
			truncated: false,
			view: "code",
			local: true,
		});
		expect(small.size).toBe(20);
		expect(small.modified).toBeGreaterThan(0);
		expect(await readFolderFile(root, "README.md", false)).toMatchObject({
			kind: "text",
			view: "markdown",
			local: false,
		});

		// A character straddling the limit is dropped, not shown as the replacement character.
		write("big.txt", `${"é".repeat(FOLDER_LIMITS.textBytes / 2 + 5)}`);
		const big = await readFolderFile(root, "big.txt", false);
		expect(big.kind).toBe("text");
		if (big.kind !== "text") throw new Error("text");
		expect(big.truncated).toBe(true);
		expect(big.size).toBeGreaterThan(FOLDER_LIMITS.textBytes);
		expect(big.text).toBe("é".repeat(FOLDER_LIMITS.textBytes / 2));
		expect(big.text).not.toContain("\uFFFD");
	});

	test("a byte order mark is not part of the text", async () => {
		write("bom.txt", new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]));
		const file = await readFolderFile(root, "bom.txt", false);
		expect(file.kind === "text" && file.text).toBe("hi");
	});

	test("binary data, and an image the panel cannot show, are named by their size alone", async () => {
		write("data.bin", new Uint8Array([1, 2, 3, 0, 4, 5]));
		expect(await readFolderFile(root, "data.bin", false)).toMatchObject({ kind: "binary", size: 6 });
		write("empty.txt", "");
		expect(await readFolderFile(root, "empty.txt", false)).toMatchObject({ kind: "text", text: "", size: 0 });
	});

	test("an image is named with its type, and its bytes are served only for an image", async () => {
		const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
		write("pics/dot.png", png);
		write("pics/PHOTO.JPG", png);
		expect(await readFolderFile(root, "pics/dot.png", false)).toMatchObject({ kind: "image", mime: "image/png" });
		expect(await readFolderFile(root, "pics/PHOTO.JPG", false)).toMatchObject({ kind: "image", mime: "image/jpeg" });
		const served = await readFolderImage(root, "pics/dot.png");
		expect(served.mime).toBe("image/png");
		expect([...served.bytes]).toEqual([...png]);
		// A text file is not an image to be served, whatever the page asks: the route is for pictures.
		await refused(readFolderImage(root, "src/app.ts"), 415);
		write("logo.svg", "<svg xmlns='http://www.w3.org/2000/svg'></svg>");
		await refused(readFolderImage(root, "logo.svg"), 415);
		expect(await readFolderFile(root, "logo.svg", false)).toMatchObject({ kind: "text", view: "svg" });
	});

	test("a PDF and a Word document are named with their type, and their bytes are served for those alone (#697)", async () => {
		const pdf = new TextEncoder().encode("%PDF-1.4\n%%EOF\n");
		const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
		write("docs/report.pdf", pdf);
		write("docs/MEMO.DOCX", zip);
		write("docs/old.doc", new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0, 0]));
		// What the panel is told: no bytes of it, only what it is (the page fetches the bytes itself).
		expect(await readFolderFile(root, "docs/report.pdf", true)).toEqual({
			path: "docs/report.pdf",
			size: pdf.length,
			modified: expect.any(Number),
			local: true,
			kind: "document",
			type: "pdf",
		});
		expect(await readFolderFile(root, "docs/MEMO.DOCX", false)).toMatchObject({ kind: "document", type: "docx" });
		// An old .doc is not one: it is a binary file, as it was.
		expect(await readFolderFile(root, "docs/old.doc", false)).toMatchObject({ kind: "binary" });
		const served = await readFolderDocument(root, "docs/report.pdf");
		expect(served.type).toBe("pdf");
		expect([...served.bytes]).toEqual([...pdf]);
		expect((await readFolderDocument(root, "docs/MEMO.DOCX")).type).toBe("docx");
		// Only a document is served as one, whatever the page asks: not a text, a picture, a page or an old Word file.
		await refused(readFolderDocument(root, "src/app.ts"), 415);
		await refused(readFolderDocument(root, "pics/dot.png"), 415);
		await refused(readFolderDocument(root, "logo.svg"), 415);
		await refused(readFolderDocument(root, "docs/old.doc"), 415);
		await refused(readFolderDocument(root, "docs"), 415);
		// And the other way: a document's bytes are no picture.
		await refused(readFolderImage(root, "docs/report.pdf"), 415);
	});

	test("a document over the limit is a binary file to the panel, and is not served", async () => {
		const path = join(proj, "docs", "huge.pdf");
		writeFileSync(path, "%PDF-");
		truncateSync(path, FOLDER_LIMITS.documentBytes + 1);
		expect(await readFolderFile(root, "docs/huge.pdf", false)).toMatchObject({ kind: "binary" });
		await refused(readFolderDocument(root, "docs/huge.pdf"), 415);
		truncateSync(path, FOLDER_LIMITS.documentBytes);
		expect(await readFolderFile(root, "docs/huge.pdf", false)).toMatchObject({ kind: "document", type: "pdf" });
	});

	test("a folder, and a pipe that would block forever, are not files to read", async () => {
		await refused(readFolderFile(root, "src", false), 415);
		const fifo = join(root, "pipe.txt");
		expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
		await refused(readFolderFile(root, "pipe.txt", false), 415);
	});
});

describe("find", () => {
	test("matches path parts without regard to case, name matches first, and never shows what is hidden", async () => {
		const dir = join(world, "findme");
		mkdirSync(dir);
		for (const rel of [
			"src/app.ts",
			"src/util/app-helpers.ts",
			"docs/Application.md",
			"readme.md",
			"node_modules/app/index.js",
			".env.app",
			"dist/app.js",
		])
			write(rel, "x", dir);
		const found = await findFiles(dir, "APP", { all: false, marks: null });
		expect(found.matches.map((m) => m.path)).toEqual(["src/app.ts", "docs/Application.md", "src/util/app-helpers.ts"]);
		expect(found).toMatchObject({ truncated: false, partial: false });
		expect((await findFiles(dir, "  ", { all: false, marks: null })).matches).toEqual([]);
	});

	test("with everything asked for, hidden files and folders are matched too, but never `.git`", async () => {
		const dir = join(world, "findall");
		mkdirSync(dir);
		for (const rel of ["src/app.ts", "node_modules/app/index.js", ".env.app", ".git/app-config"]) write(rel, "x", dir);
		const found = await findFiles(dir, "app", { all: true, marks: null });
		expect(found.matches.map((m) => m.path).sort()).toEqual([".env.app", "node_modules/app/index.js", "src/app.ts"]);
	});

	test("what .gitignore names is not matched unless everything is asked for, and a match carries its git mark", async () => {
		const dir = join(world, "findgit");
		mkdirSync(dir);
		for (const rel of ["a.ts", "gen/a.ts", "a.log"]) write(rel, "x", dir);
		const marks = parseMarks(["? a.ts", "! gen/", "! a.log", ""].join("\0"), "");
		const some = await findFiles(dir, "a", { all: false, marks });
		expect(some.matches).toEqual([{ path: "a.ts", git: "untracked" }]);
		const all = await findFiles(dir, "a", { all: true, marks });
		expect(all.matches.map((m) => m.path).sort()).toEqual(["a.log", "a.ts", "gen/a.ts"]);
	});

	test("the matches are bounded, and say so", async () => {
		const dir = join(world, "findmany");
		mkdirSync(dir);
		for (let i = 0; i < FOLDER_LIMITS.matches + 5; i++) write(`m${i}.txt`, "", dir);
		const found = await findFiles(dir, "m", { all: false, marks: null });
		expect(found.matches).toHaveLength(FOLDER_LIMITS.matches);
		expect(found.truncated).toBe(true);
	});
});

describe("open and reveal", () => {
	const calls: string[][] = [];
	const runner = async (argv: string[]) => {
		calls.push(argv);
		return 0;
	};
	const open = (rel: string, reveal: boolean, platform = "darwin") =>
		openFolderFile(root, rel, reveal, platform, runner);

	test("a file is opened by the system's own `open`, and revealed with `-R`, by its real path", async () => {
		calls.length = 0;
		await open("src/app.ts", false);
		await open("src/app.ts", true);
		await open("src", true);
		expect(calls).toEqual([
			["/usr/bin/open", join(root, "src/app.ts")],
			["/usr/bin/open", "-R", join(root, "src/app.ts")],
			["/usr/bin/open", "-R", join(root, "src")],
		]);
	});

	test("a path outside the folder is refused as everywhere else, and nothing is run", async () => {
		calls.length = 0;
		await refused(open("../outside.txt", false), 403);
		await refused(open("/etc/hosts", true), 403);
		await refused(open("out-file", false), 403);
		await refused(open("out-dir", true), 403);
		await refused(open("nope.txt", false), 404);
		expect(calls).toEqual([]);
	});

	test("nothing is executed: executables, scripts, installers and applications are only revealed, a folder is not opened", async () => {
		calls.length = 0;
		write("run.sh", "#!/bin/sh\necho hi\n");
		write("tool", "x");
		chmodSync(join(proj, "tool"), 0o755);
		for (const name of [
			"run.sh",
			"tool",
			"setup.pkg",
			"Thing.APP",
			"x.command",
			"x.jar",
			"x.scpt",
			"x.webloc",
			"x.exe",
		]) {
			if (name !== "tool") write(name, "x");
			await refused(open(name, false), 403);
		}
		await refused(open("src", false), 400);
		expect(calls).toEqual([]);
		await open("run.sh", true);
		expect(calls).toEqual([["/usr/bin/open", "-R", join(root, "run.sh")]]);
	});

	test("a link is judged by what it leads to as well as by its own name: README.txt to payload.jar is a jar", async () => {
		calls.length = 0;
		write("aliases/payload.jar", "x");
		write("aliases/run.command", "x");
		write("aliases/Setup.TERMINAL", "x");
		write("aliases/profile.mobileconfig", "x");
		write("aliases/plain.txt", "just text");
		for (const [alias, target] of [
			["README.txt", "payload.jar"],
			["notes.md", "run.command"],
			["Notes.TXT", "Setup.TERMINAL"],
			["settings", "profile.mobileconfig"],
			// the other way: a harmless file called like a script is refused by the name asked for
			["script.command", "plain.txt"],
			// a link to a link
			["twice.txt", "README.txt"],
		]) {
			symlinkSync(join(proj, "aliases", target), join(proj, "aliases", alias));
			await refused(open(`aliases/${alias}`, false), 403);
		}
		expect(calls).toEqual([]);
		// Shown in Finder is allowed for every one of them, and is handed the real path.
		await open("aliases/README.txt", true);
		expect(calls).toEqual([["/usr/bin/open", "-R", join(root, "aliases/payload.jar")]]);
		// A link to a text file opens, as the text file.
		calls.length = 0;
		symlinkSync(join(proj, "aliases/plain.txt"), join(proj, "aliases/shortcut.txt"));
		await open("aliases/shortcut.txt", false);
		expect(calls).toEqual([["/usr/bin/open", join(root, "aliases/plain.txt")]]);
	});

	test("what a browser would draw as a page, and what a profile or shortcut is, is only revealed", async () => {
		calls.length = 0;
		const names = [
			"mobileconfig",
			"vncloc",
			"afploc",
			"ftploc",
			"webloc",
			"inetloc",
			"fileloc",
			"terminal",
			"workflow",
			"action",
			"scpt",
			"scptd",
			"applescript",
			"prefPane",
			"kext",
			"saver",
			"widget",
			"html",
			"htm",
			"xhtml",
			"svg",
			"webarchive",
		];
		for (const ext of names) {
			write(`pages/x.${ext}`, "x");
			expect(neverOpened(`x.${ext}`), ext).toBe(true);
			expect(neverOpened(`X.${ext.toUpperCase()}`), ext).toBe(true);
			await refused(open(`pages/x.${ext}`, false), 403);
		}
		expect(calls).toEqual([]);
		for (const ext of ["txt", "md", "json", "ts", "png", "pdf", "csv", ""])
			expect(neverOpened(`x.${ext}`), ext).toBe(false);
		expect(neverOpened(".html")).toBe(false);
		await open("pages/x.svg", true);
		expect(calls).toEqual([["/usr/bin/open", "-R", join(root, "pages/x.svg")]]);
	});

	test("a folder swapped for a link just before the file is handed over is refused", async () => {
		calls.length = 0;
		mkdirSync(join(proj, "swap-open"));
		write("swap-open/file.txt", "inside");
		const swapped = openFolderFile(
			root,
			"swap-open/file.txt",
			false,
			"darwin",
			async (argv) => {
				calls.push(argv);
				return 0;
			},
			{
				hooks: {
					// The checks have passed: now the folder becomes a link to the outside.
					beforeOpen: () => {
						rmSync(join(proj, "swap-open"), { recursive: true });
						symlinkSync(join(world, "secret"), join(proj, "swap-open"));
					},
				},
			},
		);
		await refused(swapped, 403);
		expect(calls).toEqual([]);
	});

	test("it is a macOS action", async () => {
		calls.length = 0;
		await refused(open("src/app.ts", false, "linux"), 501);
		await refused(open("src/app.ts", true, "win32"), 501);
		expect(calls).toEqual([]);
	});

	test("a failed `open` is an error, not a silent success", async () => {
		await refused(
			openFolderFile(root, "src/app.ts", false, "darwin", async () => 1),
			404,
		);
	});
});

describe("open a folder in Finder", () => {
	const calls: string[][] = [];
	const runner = async (argv: string[]) => {
		calls.push(argv);
		return 0;
	};
	/** Paths LaunchServices is made to call packages here; every probe is recorded. */
	const packages = new Set<string>();
	const probed: string[] = [];
	const probe = async (abs: string) => {
		probed.push(abs);
		return packages.has(abs);
	};
	const openDir = (rel: unknown, platform = "darwin", opts: Parameters<typeof openFolderDir>[4] = {}) =>
		openFolderDir(root, rel, platform, runner, opts, probe);

	test("the folder itself and a folder in it are opened with the system's `open`, by their real path, as one argument", async () => {
		calls.length = 0;
		write("opening/deep/x.txt", "x");
		await openDir("");
		await openDir(".");
		await openDir("opening");
		await openDir("./opening//deep/");
		// A name with a space or a leading dash is one argument of the list, and an absolute path cannot be taken for an option.
		write("-rf and spaces/x.txt", "x");
		await openDir("-rf and spaces");
		expect(calls).toEqual([
			["/usr/bin/open", root],
			["/usr/bin/open", root],
			["/usr/bin/open", join(root, "opening")],
			["/usr/bin/open", join(root, "opening/deep")],
			["/usr/bin/open", join(root, "-rf and spaces")],
		]);
	});

	test("a link to a folder inside is opened as that folder; one that leads out is refused", async () => {
		calls.length = 0;
		symlinkSync(join(proj, "opening"), join(proj, "in-link"));
		symlinkSync(join(world, "secret"), join(proj, "out-link"));
		await openDir("in-link");
		expect(calls).toEqual([["/usr/bin/open", join(root, "opening")]]);
		calls.length = 0;
		await refused(openDir("out-link"), 403);
		await refused(openDir("out-link/key.txt"), 403);
		await refused(openDir("out-link/not-there"), 403);
		expect(calls).toEqual([]);
	});

	test("a path outside the folder is refused as everywhere else, and nothing is run", async () => {
		calls.length = 0;
		for (const path of ["..", "../secret", "../proj-evil", "/", "/etc", join(world, "secret"), "opening/../.."]) {
			await refused(openDir(path), 403);
		}
		await refused(openDir("nope"), 404);
		await refused(openDir("a\0b"), 400);
		await refused(openDir(5), 400);
		expect(calls).toEqual([]);
	});

	test("a file is never opened by the folder action, whatever it is called or leads to", async () => {
		calls.length = 0;
		write("run.sh", "#!/bin/sh\necho hi\n");
		chmodSync(join(proj, "run.sh"), 0o755);
		write("folder-looking.app", "a file called like an application");
		write("opening/plain.txt", "plain");
		symlinkSync(join(proj, "opening/plain.txt"), join(proj, "link-to-file"));
		for (const path of ["src/app.ts", "README.md", "run.sh", "folder-looking.app", "link-to-file"]) {
			await refused(openDir(path), 400);
		}
		expect(calls).toEqual([]);
	});

	test("an application, a plug-in or a project is not opened, by its name or its link's: opening it would start it", async () => {
		calls.length = 0;
		for (const name of [
			"Thing.app",
			"X.APP",
			"m.framework",
			"p.plugin",
			"s.xcodeproj",
			"w.workflow",
			"i.pkg",
			"k.kext",
			"d.sparsebundle",
			"Library.photoslibrary",
			"Doc.pages",
			"M.menu",
		]) {
			mkdirSync(join(proj, "packages", name), { recursive: true });
			expect(isPackageDir(name), name).toBe(true);
			await refused(openDir(`packages/${name}`), 403);
		}
		mkdirSync(join(proj, "packages/plain"), { recursive: true });
		symlinkSync(join(proj, "packages/Thing.app"), join(proj, "packages/innocent"));
		await refused(openDir("packages/innocent"), 403);
		expect(calls).toEqual([]);
		// A folder with a dot in its name is a folder: websites and versions are called so.
		for (const name of ["example.com", "v1.2", "build.sh", "site.org", ".config", "a.b.c"]) {
			expect(isPackageDir(name), name).toBe(false);
		}
		mkdirSync(join(proj, "packages/example.com"));
		await openDir("packages/example.com");
		expect(calls).toEqual([["/usr/bin/open", join(root, "packages/example.com")]]);
	});

	test("a folder LaunchServices calls a package is not opened, whatever its name; it is asked by its real path", async () => {
		calls.length = 0;
		probed.length = 0;
		mkdirSync(join(proj, "registered/Odd Name.someappdoc"), { recursive: true });
		packages.add(join(root, "registered/Odd Name.someappdoc"));
		symlinkSync(join(proj, "registered/Odd Name.someappdoc"), join(proj, "registered/via-link"));
		await refused(openDir("registered/Odd Name.someappdoc"), 403);
		await refused(openDir("registered/via-link"), 403);
		expect(probed).toEqual([
			join(root, "registered/Odd Name.someappdoc"),
			join(root, "registered/Odd Name.someappdoc"),
		]);
		expect(calls).toEqual([]);
		await openDir("registered");
		expect(calls).toEqual([["/usr/bin/open", join(root, "registered")]]);
	});

	test.if(process.platform === "darwin")(
		"the system's own answer: a plain folder is not a package, an app's document is",
		async () => {
			mkdirSync(join(proj, "probe/plain"), { recursive: true });
			mkdirSync(join(proj, "probe/Doc.pages"), { recursive: true });
			mkdirSync(join(proj, "probe/-rf and spaces"), { recursive: true });
			expect(await systemPackageProbe(join(root, "probe/plain"))).toBe(false);
			expect(await systemPackageProbe(join(root, "probe/-rf and spaces"))).toBe(false);
			expect(await systemPackageProbe(join(root, "probe/Doc.pages"))).toBe(true);
		},
	);

	test("a page that is not this computer's is refused what is hidden or looks like a secret, as for every read", async () => {
		calls.length = 0;
		write("guarded-dir/.ssh/id_rsa", "SECRET");
		write("guarded-dir/.hidden/x", "x");
		await refused(openDir("guarded-dir/.ssh", "darwin", { guarded: true }), 403);
		await refused(openDir("guarded-dir/.hidden", "darwin", { guarded: true }), 403);
		expect(calls).toEqual([]);
		await openDir("guarded-dir/.ssh");
		expect(calls).toEqual([["/usr/bin/open", join(root, "guarded-dir/.ssh")]]);
	});

	test("a folder swapped for a link just before it is handed over is refused", async () => {
		calls.length = 0;
		mkdirSync(join(proj, "swap-dir/inner"), { recursive: true });
		const swapped = openDir("swap-dir/inner", "darwin", {
			hooks: {
				// The checks have passed: now the folder on the way becomes a link to the outside.
				beforeOpen: () => {
					rmSync(join(proj, "swap-dir"), { recursive: true });
					symlinkSync(join(world, "secret"), join(proj, "swap-dir"));
				},
			},
		});
		await refused(swapped, 403);
		expect(calls).toEqual([]);
	});

	test("it is a macOS action, and a failed `open` is an error, not a silent success", async () => {
		calls.length = 0;
		await refused(openDir("", "linux"), 501);
		await refused(openDir("", "win32"), 501);
		expect(calls).toEqual([]);
		await refused(
			openFolderDir(root, "", "darwin", async () => 1, {}, probe),
			404,
		);
	});
});

describe("mentions", () => {
	test("a path is `@path`, quoted when it holds a space", () => {
		expect(mentionOf("src/app.ts")).toBe("@src/app.ts");
		expect(mentionOf("notes with space.txt")).toBe('@"notes with space.txt"');
	});
});

describe("the page on this computer", () => {
	const request = (headers: Record<string, string>) =>
		new Request("http://127.0.0.1:7878/api/folder/open", { headers });

	test("a loopback name, a loopback connection and nothing of Cloudflare's: and no other", () => {
		expect(isThisComputer(request({ host: "127.0.0.1:7878" }), "127.0.0.1")).toBe(true);
		expect(isThisComputer(request({ host: "localhost:7878" }), "::1")).toBe(true);
		expect(isThisComputer(request({ host: "[::1]:7878" }), "::ffff:127.0.0.1")).toBe(true);
		// A network address the server was made to listen on, by a page elsewhere or by name.
		expect(isThisComputer(request({ host: "127.0.0.1:7878" }), "192.168.1.20")).toBe(false);
		expect(isThisComputer(request({ host: "127.0.0.1:7878" }), "10.0.0.5")).toBe(false);
		expect(isThisComputer(request({ host: "127.0.0.1:7878" }), undefined)).toBe(false);
		expect(isThisComputer(request({ host: "192.168.1.5:7878" }), "127.0.0.1")).toBe(false);
		expect(isThisComputer(request({ host: "omp.example.com" }), "127.0.0.1")).toBe(false);
		expect(isThisComputer(request({}), "127.0.0.1")).toBe(false);
		// What the tunnel carries, though it reaches the server from the same machine.
		for (const name of [
			"cf-ray",
			"cf-connecting-ip",
			"cf-access-jwt-assertion",
			"cf-visitor",
			"cdn-loop",
			// Another reverse proxy on this machine, one that rewrote the Host to a loopback name.
			"x-forwarded-for",
			"x-forwarded-host",
			"x-forwarded-proto",
			"X-Forwarded-Port",
			"forwarded",
			"via",
			"x-real-ip",
		])
			expect(isThisComputer(request({ host: "127.0.0.1:7878", [name]: "x" }), "127.0.0.1"), name).toBe(false);
	});

	/** The folder routes as the server mounts them, for a conversation that works in `proj`. */
	const mounted = (local: boolean, opened: string[][] = []) => ({
		cwdOf: async (_live: string | null, file: string | null) => (file === "conversation" ? proj : null),
		marks: async () => null,
		changes: async () => ({ root: proj, state: "none" as const, branch: "", files: [], truncated: false, omitted: 0 }),
		diff: async () => null,
		local,
		platform: "darwin",
		runner: async (argv: string[]) => {
			opened.push(argv);
			return 0;
		},
	});
	const post = (body: unknown) =>
		new Request("http://127.0.0.1/api/folder/open", { method: "POST", body: JSON.stringify(body) });
	const asked = (req: Request, local: boolean, opened: string[][] = []) =>
		handleFolder(req, new URL(req.url), mounted(local, opened));

	test("a page that is not this computer's gets nothing opened or revealed, whatever file it names", async () => {
		const opened: string[][] = [];
		for (const reveal of [false, true]) {
			for (const path of ["src/app.ts", "README.md", "src", ""]) {
				const res = await asked(post({ file: "conversation", path, reveal }), false, opened);
				expect(res.status, `${path} ${reveal}`).toBe(403);
				expect(await res.json()).toEqual({ error: "Opening files is only for the page on this computer" });
			}
		}
		expect(opened).toEqual([]);
		// This computer's page asking the same is let through.
		const res = await asked(post({ file: "conversation", path: "src/app.ts", reveal: true }), true, opened);
		expect(res.status).toBe(200);
		expect(opened).toEqual([["/usr/bin/open", "-R", join(proj, "src/app.ts")]]);
	});

	test("this computer's page opens the conversation's own folder, and a folder in it, by the real path", async () => {
		const opened: string[][] = [];
		for (const path of ["", "src"]) {
			const res = await asked(post({ file: "conversation", path, dir: true }), true, opened);
			expect(res.status, path).toBe(200);
		}
		expect(opened).toEqual([
			["/usr/bin/open", proj],
			["/usr/bin/open", join(proj, "src")],
		]);
	});

	test("a page that is not this computer's gets no folder opened, whatever it names, and is told why", async () => {
		const opened: string[][] = [];
		for (const path of ["", "src", "src/app.ts", "../secret", "/etc"]) {
			const res = await asked(post({ file: "conversation", path, dir: true }), false, opened);
			expect(res.status, path).toBe(403);
			expect(await res.json()).toEqual({ error: "Opening files is only for the page on this computer" });
		}
		expect(opened).toEqual([]);
	});

	test("what the folder action is asked for outside the folder is refused, and what is a file is not opened as a folder", async () => {
		symlinkSync(join(world, "secret"), join(proj, "dir-escape"));
		const opened: string[][] = [];
		for (const path of ["../secret", "..", "/etc", "/", "dir-escape", "dir-escape/key.txt", "src/../.."]) {
			const res = await asked(post({ file: "conversation", path, dir: true }), true, opened);
			expect(res.status, path).toBe(403);
		}
		for (const path of ["src/app.ts", "README.md"]) {
			const res = await asked(post({ file: "conversation", path, dir: true }), true, opened);
			expect(res.status, path).toBe(400);
			expect(await res.json()).toEqual({ error: "Only folders are opened" });
		}
		expect((await asked(post({ file: "conversation", path: "nope", dir: true }), true, opened)).status).toBe(404);
		expect((await asked(post({ file: "other", path: "", dir: true }), true, opened)).status).toBe(404);
		expect(opened).toEqual([]);
	});

	test("the listing says whether this page may open folders: this computer's page on macOS, no other", async () => {
		const listed = async (local: boolean, platform = "darwin") => {
			const req = new Request("http://127.0.0.1/api/folder/list?file=conversation&path=");
			const res = await handleFolder(req, new URL(req.url), { ...mounted(local), platform });
			return (await res.json()) as { local?: true };
		};
		expect((await listed(true)).local).toBe(true);
		expect((await listed(false)).local).toBeUndefined();
		expect((await listed(true, "linux")).local).toBeUndefined();
	});

	test("the file a page reads is told whether this page may open it", async () => {
		const get = (local: boolean) =>
			asked(new Request("http://127.0.0.1/api/folder/file?file=conversation&path=src/app.ts"), local);
		expect(((await (await get(true)).json()) as { local: boolean }).local).toBe(true);
		expect(((await (await get(false)).json()) as { local: boolean }).local).toBe(false);
	});

	test("a page that is not this computer's is given neither what is hidden nor what looks like a secret", async () => {
		write("hostile-probe/.env", "SECRET");
		write("hostile-probe/id_rsa", "SECRET");
		write("hostile-probe/plain.txt", "plain");
		const query = (route: string, extra: string, local: boolean) =>
			asked(new Request(`http://127.0.0.1/api/folder/${route}?file=conversation${extra}`), local);
		for (const local of [true, false]) {
			const list = (await (await query("list", "&path=hostile-probe&all=1", local)).json()) as {
				entries: { name: string }[];
				guarded?: boolean;
			};
			expect(list.entries.map((e) => e.name).includes(".env"), `local ${local}`).toBe(local);
			expect(list.entries.map((e) => e.name).includes("id_rsa"), `local ${local}`).toBe(local);
			expect(list.entries.map((e) => e.name)).toContain("plain.txt");
			expect(list.guarded === true).toBe(!local);
			expect((await query("file", "&path=hostile-probe/.env", local)).status).toBe(local ? 200 : 403);
			expect((await query("file", "&path=hostile-probe/id_rsa", local)).status).toBe(local ? 200 : 403);
			expect((await query("file", "&path=hostile-probe/plain.txt", local)).status).toBe(200);
			const found = (await (await query("find", "&q=hostile-probe/&all=1", local)).json()) as {
				matches: { path: string }[];
			};
			expect(found.matches.map((m) => m.path).includes("hostile-probe/.env"), `local ${local}`).toBe(local);
		}
	});

	test("the folder is the conversation's, whatever else a request says", async () => {
		const res = await asked(new Request(`http://127.0.0.1/api/folder/list?file=conversation&cwd=${world}`), true);
		expect(((await res.json()) as { root: string }).root).toBe(proj);
		expect((await asked(new Request("http://127.0.0.1/api/folder/list?file=other"), true)).status).toBe(404);
		expect((await asked(new Request("http://127.0.0.1/api/folder/nope?file=conversation"), true)).status).toBe(404);
	});
});

describe("a page that is not this computer's (guarded)", () => {
	test("what looks like a secret is told by its name, whatever the case, and by where it is", () => {
		for (const path of [
			".env",
			".env.local",
			".ENV",
			"app/.env.production",
			"prod.env",
			"Staging.ENV",
			"id_rsa",
			"id_ed25519",
			"id_ecdsa_sk",
			"id_rsa.bak",
			"keys/ID_RSA",
			"id_rsa.png",
			"cert.p12",
			"cert.pfx",
			"release.keystore",
			"release.JKS",
			"putty.ppk",
			".ssh/config",
			"home/.ssh/known_hosts",
			".SSH/id_rsa",
			".gnupg/pubring.kbx",
			".aws/config",
			".git/config",
			"sub/.git/config",
			".git-credentials",
			"credentials",
			"credentials.json",
			"Credentials.YAML",
			"secrets",
			"secrets.yml",
			"secrets.json",
			"secrets.enc",
			".npmrc",
			".netrc",
			".pgpass",
			".htpasswd",
		])
			expect(isSecretLooking(path), path).toBe(true);
	});

	test("what only looks like one is not: source files and templates are named like secrets, and are not", () => {
		for (const path of [
			"",
			"src/app.ts",
			"README.md",
			// code that is about credentials, keys and secrets
			"id_helper.ts",
			"id_rsa_helper.ts",
			"id_card.png",
			"idle.ts",
			"credentialsProvider.tsx",
			"credentials.ts",
			"credentials.test.ts",
			"secrets.ts",
			"secrets.tsx",
			"secrets-manager.ts",
			"keyboard.key",
			"keys.md",
			"monkey.txt",
			"identity.ts",
			"secret.txt",
			"my-secrets.md",
			// an environment is not a file of variables
			".environment",
			"environment.ts",
			"env.ts",
			".env.example",
			".env.sample",
			".env.template",
			".env.dist",
			// a public key, a certificate, a presentation
			"id_rsa.pub",
			"server.pem",
			"deploy.key",
			"docs/ssh.md",
			".git/HEAD",
			".github/workflows/ci.yml",
			"git/config",
			"npmrc",
		])
			expect(isSecretLooking(path), path).toBe(false);
	});

	test("a private key is told by its text whatever the file is called, and a public one or a presentation is not", () => {
		for (const text of [
			"-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
			"x\n-----BEGIN RSA PRIVATE KEY-----\nabc",
			"-----BEGIN OPENSSH PRIVATE KEY-----\nabc",
			"-----BEGIN EC PRIVATE KEY-----",
			"-----BEGIN ENCRYPTED PRIVATE KEY-----",
			"-----BEGIN PGP PRIVATE KEY BLOCK-----",
		])
			expect(holdsPrivateKey(text), text).toBe(true);
		for (const text of [
			"",
			"-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----",
			"-----BEGIN PUBLIC KEY-----\nabc",
			"ssh-ed25519 AAAAC3Nza user@host",
			"the PRIVATE KEY is kept elsewhere",
			"hello",
		])
			expect(holdsPrivateKey(text), text).toBe(false);
	});

	/** The folder the tests below read: secrets next to ordinary files, a link that names one harmlessly, hidden things. */
	const SECRETS = ["id_rsa", "credentials.json", "secrets.yml", ".env", ".npmrc", ".netrc", "store.p12"];
	/** Keys by their text: called like anything. */
	const PEM = "-----BEGIN PRIVATE KEY-----\nSECRET\n-----END PRIVATE KEY-----\n";
	const KEYS = ["server.pem", "deploy.key", "notes-with-key.txt"];
	const PLAIN = ["notes.txt", "id_helper.ts", "credentialsProvider.tsx", "secrets.ts", "keyboard.key", "id_card.png"];
	beforeAll(() => {
		for (const name of SECRETS) write(`guard/${name}`, "SECRET");
		for (const name of KEYS) write(`guard/${name}`, PEM);
		for (const name of PLAIN) write(`guard/${name}`, "plain");
		write("guard/id_rsa.png", "named like a key");
		write("guard/.ssh/config", "SECRET");
		write("guard/.git/config", "SECRET");
		write("guard/.hidden-note", "hidden but not secret");
		write("guard/.config/tool/hosts.yml", "token: hidden but not named like one");
		write("guard/dist/out.js", "x");
		write("guard/node_modules/dep/index.js", "x");
		write("guard/.github/ci.yml", "on: push");
		symlinkSync(join(proj, "guard/.env"), join(proj, "guard/innocent.txt"));
		symlinkSync(join(proj, "guard/.ssh"), join(proj, "guard/innocent-dir"));
		symlinkSync(join(proj, "guard/.hidden-note"), join(proj, "guard/hidden-alias.txt"));
	});

	const names = (l: { entries: { name: string }[] }) => l.entries.map((e) => e.name);

	test("it is not listed: not by a guarded folder listing, not when everything is asked for, and not in the filter", async () => {
		const open = await listFolder(root, "guard", { all: true, marks: null });
		expect(names(open)).toContain(".env");
		expect(names(open)).toContain("id_rsa");
		expect(open.guarded).toBeUndefined();
		for (const all of [false, true]) {
			const guarded = await listFolder(root, "guard", { all, marks: null, guarded: true });
			const listed = names(guarded);
			for (const secret of [...SECRETS, "id_rsa.png", ".ssh", ".git"])
				expect(listed, `${secret} all: ${all}`).not.toContain(secret);
			// What is hidden by default stays hidden, whatever is asked for; `.github` is the one hidden folder that is kept.
			for (const hidden of [".hidden-note", ".config", "dist", "node_modules"])
				expect(listed, `${hidden} all: ${all}`).not.toContain(hidden);
			for (const shown of [".github", ...PLAIN, ...KEYS]) expect(listed, `${shown} all: ${all}`).toContain(shown);
			expect(guarded.guarded).toBe(true);
			expect(guarded.hiddenCount).toBeGreaterThan(0);
		}
		// The filter, with everything asked for, finds neither the secrets nor what is hidden.
		const found = await findFiles(root, "guard/", { all: true, marks: null, guarded: true, fresh: true });
		const paths = found.matches.map((m) => m.path);
		expect(paths).toContain("guard/notes.txt");
		expect(paths).toContain("guard/id_helper.ts");
		for (const p of paths) expect(isSecretLooking(p), p).toBe(false);
		for (const hidden of ["guard/.hidden-note", "guard/dist/out.js", "guard/.config/tool/hosts.yml"])
			expect(paths).not.toContain(hidden);
		const local = await findFiles(root, "guard/", { all: true, marks: null, fresh: true });
		expect(local.matches.map((m) => m.path)).toContain("guard/id_rsa");
	});

	test("it is not read: by its name, by a link that names it harmlessly, by its folder, by its text, or as a picture", async () => {
		for (const name of [...SECRETS, ".ssh/config", ".git/config", "innocent.txt", "innocent-dir/config"]) {
			await refused(readFolderFile(root, `guard/${name}`, false, { guarded: true }), 403);
			// Not by the same page on this computer.
			expect(await readFolderFile(root, `guard/${name}`, false)).toMatchObject({ kind: "text", text: "SECRET" });
		}
		// A key is a key whatever the file is called; the page on this computer reads it.
		for (const name of KEYS) {
			await refused(readFolderFile(root, `guard/${name}`, false, { guarded: true }), 403);
			expect(await readFolderFile(root, `guard/${name}`, false)).toMatchObject({ kind: "text", text: PEM });
		}
		await refused(readFolderFile(root, "guard/.ssh", false, { guarded: true }), 403);
		await refused(listFolder(root, "guard/.ssh", { all: true, marks: null, guarded: true }), 403);
		await refused(listFolder(root, "guard/innocent-dir", { all: true, marks: null, guarded: true }), 403);
		await refused(readFolderImage(root, "guard/id_rsa.png", { guarded: true }), 403);
		expect((await readFolderImage(root, "guard/id_rsa.png")).mime).toBe("image/png");
		// Nor what its listing would not have shown: a hidden file, a file in a hidden or dependency folder, a hidden folder,
		// and a link that leads to one, though nothing in them is named like a secret.
		for (const hidden of [
			"guard/.hidden-note",
			"guard/.config/tool/hosts.yml",
			"guard/dist/out.js",
			"guard/node_modules/dep/index.js",
			"guard/hidden-alias.txt",
		]) {
			await refused(readFolderFile(root, hidden, false, { guarded: true }), 403);
			expect(await readFolderFile(root, hidden, false), hidden).toMatchObject({ kind: "text" });
		}
		for (const folder of ["guard/.config", "guard/.config/tool", "guard/dist", "guard/node_modules"])
			await refused(listFolder(root, folder, { all: true, marks: null, guarded: true }), 403);
		// What is neither hidden nor secret is read, however much its name sounds like one.
		for (const name of [...PLAIN.filter((n) => n !== "id_card.png"), ".github/ci.yml"])
			expect(await readFolderFile(root, `guard/${name}`, false, { guarded: true }), name).toMatchObject({
				kind: "text",
			});
		expect((await readFolderImage(root, "guard/id_card.png", { guarded: true })).mime).toBe("image/png");
	});

	test("nothing is opened or revealed for it either", async () => {
		const calls: string[][] = [];
		const runner = async (argv: string[]) => {
			calls.push(argv);
			return 0;
		};
		for (const reveal of [false, true])
			await refused(openFolderFile(root, "guard/.env", reveal, "darwin", runner, { guarded: true }), 403);
		expect(calls).toEqual([]);
	});
});

describe("a folder swapped for a link while a file is read", () => {
	/** `dir` is a real folder with `file.txt`; the hook makes it a link to the folder with the secret, or back. */
	function setup(name: string) {
		const dir = join(proj, name);
		mkdirSync(dir);
		writeFileSync(join(dir, "file.txt"), "inside");
		const away = `${dir}-away`;
		const toOutside = () => {
			renameSync(dir, away);
			symlinkSync(join(world, "secret"), dir);
		};
		const back = () => {
			unlinkSync(dir);
			renameSync(away, dir);
		};
		return { toOutside, back };
	}

	test("swapped before the file is opened: the open follows the link, and what it opened is refused", async () => {
		const { toOutside } = setup("swap-before");
		writeFileSync(join(world, "secret", "file.txt"), "the secret");
		await refused(readFolderFile(root, "swap-before/file.txt", false, { hooks: { beforeOpen: toOutside } }), 403);
	});

	test("swapped before it is opened and put back before it is checked: the file is not the one the path leads to", async () => {
		const { toOutside, back } = setup("swap-back");
		writeFileSync(join(world, "secret", "file.txt"), "the secret, a longer text than the one inside");
		await refused(
			readFolderFile(root, "swap-back/file.txt", false, { hooks: { beforeOpen: toOutside, afterOpen: back } }),
			403,
		);
	});

	test("the same for a picture", async () => {
		const { toOutside } = setup("swap-image");
		writeFileSync(join(proj, "swap-image", "pic.png"), "inside");
		writeFileSync(join(world, "secret", "pic.png"), "outside");
		await refused(readFolderImage(root, "swap-image/pic.png", { hooks: { beforeOpen: toOutside } }), 403);
	});

	test("a folder that is not swapped is read, and no hook is needed to read it", async () => {
		setup("swap-none");
		expect(await readFolderFile(root, "swap-none/file.txt", false, { hooks: { beforeOpen: () => {} } })).toMatchObject({
			kind: "text",
			text: "inside",
		});
	});

	test("swapped after it was read: the check that it is still where it was comes last, and refuses", async () => {
		const { toOutside } = setup("swap-after");
		await refused(readFolderFile(root, "swap-after/file.txt", false, { hooks: { afterRead: toOutside } }), 403);
		const again = setup("swap-after-pic");
		writeFileSync(join(proj, "swap-after-pic", "pic.png"), "inside");
		await refused(readFolderImage(root, "swap-after-pic/pic.png", { hooks: { afterRead: again.toOutside } }), 403);
	});

	test("a folder that goes while it is listed is not found (the page closes it), not a failure of the server", async () => {
		setup("gone-before");
		setup("gone-after");
		const remove = (name: string) => () => rmSync(join(proj, name), { recursive: true, force: true });
		await refused(
			listFolder(root, "gone-before", { all: true, marks: null, hooks: { beforeOpen: remove("gone-before") } }),
			404,
		);
		await refused(
			listFolder(root, "gone-after", { all: true, marks: null, hooks: { afterOpen: remove("gone-after") } }),
			404,
		);
	});

	test("the same for a folder that is listed: what was read from the link is not the folder's", async () => {
		const { toOutside } = setup("swap-list");
		writeFileSync(join(world, "secret", "listed-from-outside.txt"), "x");
		await refused(listFolder(root, "swap-list", { all: true, marks: null, hooks: { beforeOpen: toOutside } }), 403);
	});

	test("a file replaced by another while it is read (a save by rename) is not read as the old one", async () => {
		setup("swap-file");
		await refused(
			readFolderFile(root, "swap-file/file.txt", false, {
				hooks: {
					afterOpen: () => {
						writeFileSync(join(proj, "swap-file/new.txt"), "replacement");
						renameSync(join(proj, "swap-file/new.txt"), join(proj, "swap-file/file.txt"));
					},
				},
			}),
			403,
		);
		// The next read is of the new file.
		expect(await readFolderFile(root, "swap-file/file.txt", false)).toMatchObject({ text: "replacement" });
	});
});
