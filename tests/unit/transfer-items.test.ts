import { describe, expect, test } from "bun:test";
import { TRANSFER_LIMITS } from "../../shared/transfer.ts";
import { fromFileList, gatherTaken } from "../../web/src/lib/transfer-items.ts";
import { carriesFiles, takeTransfer } from "../../web/src/lib/transfer-take.ts";

/**
 * Turning what was dropped or picked into the files to send (`lib/transfer-items.ts`, `lib/transfer-take.ts`), with entries
 * made up the way a browser's `webkitGetAsEntry` gives them: directories read in pieces, hidden names left out and counted.
 */

const file = (name: string, relative = "", size = 3): File => {
	const f = new File([new Uint8Array(size)], name);
	if (relative) Object.defineProperty(f, "webkitRelativePath", { value: relative });
	return f;
};

interface Node {
	name: string;
	/** Present: a file; absent: a directory holding `children`. */
	size?: number;
	children?: Node[];
}

/** A directory entry that gives its children `batch` at a time and then an empty batch, as `readEntries` does. */
function entryOf(node: Node, batch = 2): FileSystemEntry {
	if (node.size !== undefined) {
		const f = new File([new Uint8Array(node.size)], node.name);
		return {
			isFile: true,
			isDirectory: false,
			name: node.name,
			fullPath: `/${node.name}`,
			file: (ok: (f: File) => void) => ok(f),
		} as unknown as FileSystemEntry;
	}
	const kids = (node.children ?? []).map((c) => entryOf(c, batch));
	return {
		isFile: false,
		isDirectory: true,
		name: node.name,
		fullPath: `/${node.name}`,
		createReader: () => {
			let at = 0;
			return {
				readEntries: (ok: (e: FileSystemEntry[]) => void) => {
					const out = kids.slice(at, at + batch);
					at += batch;
					ok(out);
				},
			};
		},
	} as unknown as FileSystemEntry;
}

const names = (items: { dir: string; name: string }[]) => items.map((i) => (i.dir ? `${i.dir}/${i.name}` : i.name));

describe("a folder picker's files", () => {
	test("each file keeps the folder it came in, below the folder that was picked", () => {
		const got = fromFileList([file("a.ts", "proj/src/a.ts"), file("README.md", "proj/README.md"), file("loose.txt")]);
		expect(names(got.items)).toEqual(["proj/src/a.ts", "proj/README.md", "loose.txt"]);
		expect(got.hidden).toBe(0);
		expect(got.tooMany).toBe(false);
	});

	test("hidden files and folders are left out and counted; a hidden folder counts once", () => {
		const got = fromFileList([
			file("ok.ts", "proj/ok.ts"),
			file(".env", "proj/.env"),
			file("index.js", "proj/node_modules/dep/index.js"),
			file("b.js", "proj/node_modules/dep/b.js"),
			file("out.js", "proj/dist/out.js"),
			file("w.yml", "proj/.github/workflows/w.yml"),
			file(".DS_Store", "proj/src/.DS_Store"),
		]);
		expect(names(got.items)).toEqual(["proj/ok.ts", "proj/.github/workflows/w.yml"]);
		// .env, node_modules (once), dist, .DS_Store
		expect(got.hidden).toBe(4);
	});

	test("a hidden file picked on its own is left out too; a file called dist is a file, not a build folder", () => {
		const got = fromFileList([file(".bashrc"), file("dist"), file("build")]);
		expect(names(got.items)).toEqual(["dist", "build"]);
		expect(got.hidden).toBe(1);
	});

	test("more files than one upload takes stops the gathering", () => {
		const many = Array.from({ length: TRANSFER_LIMITS.uploadFiles + 5 }, (_, i) => file(`f${i}`));
		const got = fromFileList(many);
		expect(got.tooMany).toBe(true);
		expect(got.items).toHaveLength(TRANSFER_LIMITS.uploadFiles);
	});
});

describe("a drop", () => {
	test("the files of a dropped folder come with their folders, read in pieces until the reader is empty", async () => {
		const tree: Node = {
			name: "proj",
			children: [
				{ name: "a.txt", size: 1 },
				{ name: "b.txt", size: 2 },
				{
					name: "src",
					children: [
						{ name: "c.ts", size: 3 },
						{ name: "lib", children: [{ name: "d.ts", size: 4 }] },
					],
				},
				{ name: "empty", children: [] },
				{ name: "e.txt", size: 5 },
			],
		};
		const got = await gatherTaken({ entries: [entryOf(tree)], files: [] });
		expect(names(got.items).sort()).toEqual(
			["proj/a.txt", "proj/b.txt", "proj/e.txt", "proj/src/c.ts", "proj/src/lib/d.ts"].sort(),
		);
		expect(got.items.find((i) => i.name === "d.ts")?.size).toBe(4);
		expect(got.hidden).toBe(0);
	});

	test("hidden entries are left out and counted, a hidden folder once", async () => {
		const tree: Node = {
			name: "proj",
			children: [
				{ name: ".git", children: [{ name: "HEAD", size: 1 }] },
				{ name: "node_modules", children: [{ name: "x", children: [{ name: "i.js", size: 1 }] }] },
				{ name: ".github", children: [{ name: "ci.yml", size: 1 }] },
				{ name: ".env", size: 1 },
				{ name: "target", children: [] },
				{ name: "keep.txt", size: 1 },
			],
		};
		const got = await gatherTaken({ entries: [entryOf(tree)], files: [] });
		expect(names(got.items).sort()).toEqual(["proj/.github/ci.yml", "proj/keep.txt"].sort());
		expect(got.hidden).toBe(4);
	});

	test("loose files come with the entries, in no folder; a dropped hidden file is left out", async () => {
		const got = await gatherTaken({
			entries: [entryOf({ name: "one.txt", size: 2 })],
			files: [file("two.txt"), file(".secret")],
		});
		expect(names(got.items).sort()).toEqual(["one.txt", "two.txt"]);
		expect(got.hidden).toBe(1);
	});

	test("a folder of more files than an upload takes is read no further", async () => {
		const children: Node[] = Array.from({ length: TRANSFER_LIMITS.uploadFiles + 3 }, (_, i) => ({
			name: `f${i}`,
			size: 1,
		}));
		const got = await gatherTaken({ entries: [entryOf({ name: "big", children }, 500)], files: [] });
		expect(got.tooMany).toBe(true);
		expect(got.items.length).toBeLessThanOrEqual(TRANSFER_LIMITS.uploadFiles);
	});

	test("a file that cannot be read is not sent and does not stop the rest", async () => {
		const broken = {
			isFile: true,
			isDirectory: false,
			name: "gone.txt",
			file: (_ok: unknown, fail: (e: Error) => void) => fail(new Error("NotFoundError")),
		} as unknown as FileSystemEntry;
		const tree = {
			isFile: false,
			isDirectory: true,
			name: "p",
			createReader: () => {
				let done = false;
				return {
					readEntries: (ok: (e: FileSystemEntry[]) => void) => {
						ok(done ? [] : [broken, entryOf({ name: "ok.txt", size: 1 })]);
						done = true;
					},
				};
			},
		} as unknown as FileSystemEntry;
		const got = await gatherTaken({ entries: [tree], files: [] });
		expect(names(got.items)).toEqual(["p/ok.txt"]);
	});
});

describe("taking a drop while its event is handled", () => {
	const data = (types: string[], items: unknown[], files: File[] = []) =>
		({ types, items, files }) as unknown as DataTransfer;

	test("only a drag that carries files is for the upload", () => {
		expect(carriesFiles(data(["Files"], []))).toBe(true);
		expect(carriesFiles(data(["text/plain"], []))).toBe(false);
		expect(carriesFiles(null)).toBe(false);
	});

	test("an item with an entry gives the entry; one without gives its file; text items are passed over", () => {
		const entry = entryOf({ name: "d", children: [] });
		const loose = file("loose.txt");
		const taken = takeTransfer(
			data(
				["Files"],
				[
					{ kind: "file", webkitGetAsEntry: () => entry, getAsFile: () => null },
					{ kind: "file", webkitGetAsEntry: () => null, getAsFile: () => loose },
					{ kind: "string", webkitGetAsEntry: () => null, getAsFile: () => null },
				],
			),
		);
		expect(taken.entries).toEqual([entry]);
		expect(taken.files).toEqual([loose]);
	});

	test("a browser without items gives the files of the transfer", () => {
		const a = file("a.txt");
		const taken = takeTransfer(data(["Files"], [], [a]));
		expect(taken).toEqual({ entries: [], files: [a] });
	});
});
