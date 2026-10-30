import { describe, expect, test } from "bun:test";
import { ATTACH_LIMITS, classify, DOCUMENT_LIMITS, type DropChoices } from "../../shared/attachment.ts";
import { UPLOAD_LIMITS, type UploadResult } from "../../shared/upload.ts";
import type { DocumentFailure, DocumentRead } from "../../web/src/lib/documents.ts";
import {
	choicesFor,
	describe as describeEntries,
	documentFailureText,
	type Entry,
	kindsOf,
	matchPaths,
	plan,
	rememberedFor,
	sizeText,
	type Task,
	uploadFailureText,
	whyText,
} from "../../web/src/lib/drop-flow.ts";
import { type RunDeps, run, type UploadRow } from "../../web/src/lib/drop-run.ts";
import "../../web/src/lib/drop-strings.ts";
import type { ImageRefusal, PreparedImage } from "../../web/src/lib/images.ts";
import type { ShellItem } from "../../web/src/lib/shell-drop.ts";
import { UploadError } from "../../web/src/lib/upload.ts";

/**
 * What becomes of dropped files before and after the choice: which path the app's window gave each file, which are asked
 * about and which a remembered choice settles, and doing what was chosen (`lib/drop-flow.ts`, `lib/drop-run.ts`).
 */

const item = (name: string, size: number, path = `/Users/me/${name}`, directory = false): ShellItem => ({
	name,
	path,
	directory,
	size,
});
const file = (name: string, size: number, directory = false) => ({ name, size, directory });

/** An entry as `describe` makes it, with the text of the file as its content. */
function entry(
	name: string,
	content: string | Uint8Array<ArrayBuffer>,
	type = "",
	path: string | null = null,
	directory = false,
): Entry {
	const f = new File([content], name, { type });
	const looksText = typeof content === "string";
	return {
		file: f,
		directory,
		info: classify({ name, type, size: f.size, directory }, looksText),
		path,
		mentions: false,
	};
}

describe("matchPaths: where each dropped file is on this Mac", () => {
	test("a file is matched by name and size", () => {
		expect(matchPaths([file("a.txt", 3)], [item("a.txt", 3)])).toEqual([{ path: "/Users/me/a.txt", directory: false }]);
	});

	test("the same name with another size is another file: no path is guessed", () => {
		expect(matchPaths([file("a.txt", 3)], [item("a.txt", 4)])).toEqual([null]);
	});

	test("two files of one name and size each take one item, in order", () => {
		const items = [item("a.txt", 3, "/one/a.txt"), item("a.txt", 3, "/two/a.txt")];
		const got = matchPaths([file("a.txt", 3), file("a.txt", 3), file("a.txt", 3)], items);
		expect(got.map((m) => m?.path ?? null)).toEqual(["/one/a.txt", "/two/a.txt", null]);
	});

	test("names match however the accents are written (macOS keeps them decomposed)", () => {
		const nfd = "caf\u0065\u0301.txt";
		const nfc = "caf\u00e9.txt";
		expect(matchPaths([file(nfc, 2)], [item(nfd, 2)])?.[0]?.path).toBe(`/Users/me/${nfd}`);
	});

	test("a folder has no size to compare: it is matched by name, and the page says it is one", () => {
		const got = matchPaths([file("src", 0)], [item("src", 0, "/Users/me/src", true)]);
		expect(got).toEqual([{ path: "/Users/me/src", directory: true }]);
	});

	test("a folder item is not given to a file of the same name that has content", () => {
		expect(matchPaths([file("src", 12)], [item("src", 0, "/Users/me/src", true)])).toEqual([null]);
	});

	test("nothing from the app: no paths", () => {
		expect(matchPaths([file("a.txt", 3), file("b.txt", 1)], [])).toEqual([null, null]);
	});
});

describe("plan: what a remembered choice settles, and what is asked", () => {
	const text = entry("a.txt", "hello");
	const big = entry("big.txt", "x".repeat(ATTACH_LIMITS.textFileBytes + 1));
	const png = entry("p.png", new Uint8Array([1, 2]), "image/png");
	const pdf = entry("r.pdf", new Uint8Array([0]), "application/pdf");
	// A document omp reads from a path and a message cannot carry.
	const doc = entry("r.doc", new Uint8Array([0]), "application/msword");
	const dir = entry("src", "", "", "/Users/me/src", true);

	test("nothing remembered: everything is asked", () => {
		const { settled, asked } = plan([text, png, pdf], {});
		expect(settled).toEqual([]);
		expect(asked).toEqual([text, png, pdf]);
	});

	test("a kind with a remembered action is settled, the others are asked, in order", () => {
		const choices: DropChoices = { text: "attach", other: "path", document: "attach" };
		const { settled, asked } = plan([text, png, doc, pdf], choices);
		expect(settled.map((t) => [t.entry.file.name, t.action])).toEqual([
			["a.txt", "attach"],
			["r.doc", "path"],
			["r.pdf", "attach"],
		]);
		expect(asked).toEqual([png]);
	});

	test("a remembered attach does not settle a text file that is too large: the person chose for files that can be attached", () => {
		const { settled, asked } = plan([big, text], { text: "attach" });
		expect(settled.map((t) => t.entry.file.name)).toEqual(["a.txt"]);
		expect(asked).toEqual([big]);
	});

	test("a remembered path settles a text file that is too large", () => {
		expect(plan([big], { text: "path" }).settled.map((t) => t.action)).toEqual(["path"]);
	});

	test("an action a kind cannot have is never settled (a stored 'attach' for old Word files)", () => {
		const wrong = { other: "attach", folder: "attach" } as DropChoices;
		const { settled, asked } = plan([doc, dir], wrong);
		expect(settled).toEqual([]);
		expect(asked).toEqual([doc, dir]);
	});
});

describe("what is remembered", () => {
	const pdf = entry("r.pdf", new Uint8Array([0]), "application/pdf");
	const doc = entry("r.doc", new Uint8Array([0]), "application/msword");

	test("kindsOf names each kind once, in the order of the settings", () => {
		const entries = [entry("p.png", new Uint8Array([1]), "image/png"), entry("a.txt", "x"), entry("b.txt", "y")];
		expect(kindsOf(entries)).toEqual(["text", "image"]);
		const more = [entry("src", "", "", null, true), doc, pdf, entry("a.txt", "x")];
		expect(kindsOf(more)).toEqual(["text", "document", "other", "folder"]);
	});

	test("rememberedFor: attach is remembered for the kinds that can be attached, path for all", () => {
		const asked = [entry("a.txt", "x"), entry("r.pdf", new Uint8Array([0]), "application/pdf"), doc];
		expect(rememberedFor(asked, "attach")).toEqual({ text: "attach", document: "attach" });
		expect(rememberedFor(asked, "path")).toEqual({ text: "path", document: "path", other: "path" });
	});
});

describe("choicesFor: what a source settles by itself", () => {
	test("a picture pasted is attached without asking, as before there was a choice", () => {
		expect(choicesFor("paste", {})).toEqual({ image: "attach" });
		expect(choicesFor("paste", { text: "path" })).toEqual({ image: "attach", text: "path" });
	});

	test("what the person chose for pictures wins over that default", () => {
		expect(choicesFor("paste", { image: "path" })).toEqual({ image: "path" });
	});

	test("a drop and a picked file are asked about unless a choice was remembered", () => {
		expect(choicesFor("drop", {})).toEqual({});
		expect(choicesFor("pick", { text: "attach" })).toEqual({ text: "attach" });
	});

	test("a pasted picture is settled by plan, and a pasted PDF is still asked about", () => {
		const png = entry("p.png", new Uint8Array([1]), "image/png");
		const pdf = entry("r.pdf", new Uint8Array([0]), "application/pdf");
		const { settled, asked } = plan([png, pdf], choicesFor("paste", {}));
		expect(settled.map((t) => [t.entry.file.name, t.action])).toEqual([["p.png", "attach"]]);
		expect(asked).toEqual([pdf]);
	});
});

describe("words", () => {
	test("sizeText", () => {
		expect([0, 900, 1024, 262144, 1572864].map(sizeText)).toEqual(["0 B", "900 B", "1 KB", "256 KB", "1.5 MB"]);
	});

	test("why an item cannot be attached", () => {
		expect(whyText("document")).toContain(".docx");
		expect(whyText("tooLarge")).toContain("256 KB");
		expect(whyText("documentTooLarge")).toContain("25 MB");
	});

	test("what is said of a document that could not be read", () => {
		const text = (f: DocumentFailure) => documentFailureText(f);
		expect(text({ reason: "tooLarge", name: "big.pdf" })).toContain("25 MB");
		expect(text({ reason: "encrypted", name: "locked.pdf" })).toContain("password");
		expect(text({ reason: "damaged", name: "bad.pdf" })).toContain("damaged");
		expect(text({ reason: "oldWord", name: "old.docx" })).toContain(".docx");
		expect(text({ reason: "empty", name: "blank.docx" })).toContain("blank.docx");
		expect(text({ reason: "noRoom", name: "late.pdf", total: ATTACH_LIMITS.textTotalBytes + 1024 })).toContain(
			"513 KB",
		);
		expect(text({ reason: "failed", name: "x.pdf", message: "chunk gone" })).toContain("chunk gone");
		for (const name of ["big.pdf", "locked.pdf", "bad.pdf"]) {
			expect(documentFailureText({ reason: "damaged", name })).toContain(name);
		}
	});

	test("an upload that failed says what the server said it was", () => {
		const limit = 10 * 1024 * 1024;
		expect(uploadFailureText("a.bin", { code: "tooLarge", message: "", limit })).toContain("10 MB");
		expect(uploadFailureText("a.bin", { code: "quota", message: "", limit })).toContain(".omp-webui/uploads");
		expect(uploadFailureText("a.bin", { code: "failed", message: "The connection failed" })).toContain(
			"The connection failed",
		);
	});
});

/** Everything `run` is given, with a log of what it did. */
function world(over: Partial<RunDeps> = {}) {
	const warned: string[] = [];
	const noticed: string[] = [];
	const reading: (string | null)[] = [];
	const progress: UploadRow[][] = [];
	const uploaded: string[] = [];
	const control = new AbortController();
	const deps: RunDeps = {
		scope: { live: "live1", file: null },
		usedImageBytes: 0,
		usedTextBytes: 0,
		signal: control.signal,
		warn: (text) => warned.push(text),
		notice: (text) => noticed.push(text),
		reading: (name) => reading.push(name),
		progress: (rows) => progress.push(rows),
		readDocument: async (f): Promise<DocumentRead | DocumentFailure> => ({
			file: { name: f.name, bytes: 10, text: `text of ${f.name}`, note: "2 pages" },
			images: [],
			notices: [],
		}),
		prepareImage: async (f, used): Promise<PreparedImage | ImageRefusal> =>
			f.size > 100
				? { reason: "tooLarge", name: f.name, bytes: f.size, limit: 100 }
				: { name: f.name, mimeType: f.type, data: "AAAA", bytes: used + f.size - used, resized: false },
		upload: async (_scope, f, onProgress): Promise<UploadResult> => {
			uploaded.push(f.name);
			onProgress(f.size, f.size);
			return { path: `/proj/.omp-webui/uploads/2026-10-24/${f.name}`, name: f.name, bytes: f.size };
		},
		...over,
	};
	return { deps, warned, noticed, reading, progress, uploaded, control };
}

const task = (e: Entry, action: Task["action"]): Task => ({ entry: e, action });

describe("run: doing what was chosen", () => {
	test("attach: pictures are prepared, text files are read (a BOM is dropped), the order is kept", async () => {
		const w = world();
		const result = await run(
			[
				task(entry("a.txt", "\uFEFFhello"), "attach"),
				task(entry("p.png", new Uint8Array([1, 2]), "image/png"), "attach"),
				task(entry("b.txt", "world"), "attach"),
			],
			w.deps,
		);
		expect(result?.files.map((f) => [f.name, f.text, f.bytes])).toEqual([
			["a.txt", "hello", 8],
			["b.txt", "world", 5],
		]);
		expect(result?.images.map((i) => i.name)).toEqual(["p.png"]);
		expect(result?.paths).toEqual([]);
		expect(w.warned).toEqual([]);
		expect(w.uploaded).toEqual([]);
		// Nothing was sent: there is no progress to show.
		expect(w.progress).toEqual([]);
	});

	test("a picture the images' limits refuse is said, and the rest goes on", async () => {
		const w = world();
		const result = await run(
			[task(entry("big.png", new Uint8Array(200), "image/png"), "attach"), task(entry("a.txt", "x"), "attach")],
			w.deps,
		);
		expect(result?.images).toEqual([]);
		expect(result?.files.map((f) => f.name)).toEqual(["a.txt"]);
		expect(w.warned).toHaveLength(1);
		expect(w.warned[0]).toContain("big.png");
	});

	test("text files past the total of the message are refused one by one", async () => {
		const w = world({ usedTextBytes: ATTACH_LIMITS.textTotalBytes - 4 });
		const result = await run([task(entry("a.txt", "12345"), "attach"), task(entry("b.txt", "1234"), "attach")], w.deps);
		expect(result?.files.map((f) => f.name)).toEqual(["b.txt"]);
		expect(w.warned).toHaveLength(1);
		expect(w.warned[0]).toContain("a.txt");
	});

	test("a file that cannot be attached (an old Word file said to be attached) is left out without a word: it was named when asked", async () => {
		const w = world();
		const result = await run([task(entry("r.doc", new Uint8Array([0]), "application/msword"), "attach")], w.deps);
		expect(result).toEqual({ images: [], files: [], paths: [] });
		expect(w.warned).toEqual([]);
	});

	test("a PDF is read for the message: its text file and the pictures of its pages join, and count against the totals", async () => {
		const used: { imageBytes: number; textBytes: number }[] = [];
		const page = (name: string, bytes: number): PreparedImage => ({
			name,
			mimeType: "image/jpeg",
			data: "AAAA",
			bytes,
			resized: false,
		});
		const w = world({
			readDocument: async (f, use) => {
				used.push({ ...use });
				return {
					file: { name: f.name, bytes: 100, text: `text of ${f.name}`, note: "3 pages · images: 2" },
					images: [page(`${f.name} page 2.jpg`, 50), page(`${f.name} page 3.jpg`, 70)],
					notices: [`${f.name} is long`],
				};
			},
		});
		const result = await run(
			[
				task(entry("a.txt", "hello"), "attach"),
				task(entry("r.pdf", new Uint8Array([0]), "application/pdf"), "attach"),
				task(entry("s.docx", new Uint8Array([0])), "attach"),
			],
			w.deps,
		);
		expect(result?.files).toEqual([
			{ name: "a.txt", bytes: 5, text: "hello" },
			{ name: "r.pdf", bytes: 100, text: "text of r.pdf", note: "3 pages · images: 2" },
			{ name: "s.docx", bytes: 100, text: "text of s.docx", note: "3 pages · images: 2" },
		]);
		expect(result?.images.map((i) => i.name)).toEqual([
			"r.pdf page 2.jpg",
			"r.pdf page 3.jpg",
			"s.docx page 2.jpg",
			"s.docx page 3.jpg",
		]);
		// Each document is told what the ones before it took.
		expect(used).toEqual([
			{ imageBytes: 0, textBytes: 5 },
			{ imageBytes: 120, textBytes: 105 },
		]);
		expect(w.noticed).toEqual(["r.pdf is long", "s.docx is long"]);
		// The choice shows each one being read, and nothing at the end.
		expect(w.reading).toEqual(["r.pdf", null, "s.docx", null]);
		expect(w.warned).toEqual([]);
	});

	test("a document that cannot be read is said and attaches nothing; the files after it go on", async () => {
		const w = world({
			readDocument: async (f) => ({ reason: "encrypted", name: f.name }),
		});
		const result = await run(
			[task(entry("locked.pdf", new Uint8Array([0])), "attach"), task(entry("a.txt", "x"), "attach")],
			w.deps,
		);
		expect(result?.files.map((f) => f.name)).toEqual(["a.txt"]);
		expect(result?.images).toEqual([]);
		expect(w.warned).toHaveLength(1);
		expect(w.warned[0]).toContain("locked.pdf");
		expect(w.warned[0]).toContain("password");
		expect(w.reading).toEqual(["locked.pdf", null]);
	});

	test("a reader that breaks (its chunk could not be fetched) is said like any failure, and the reading ends", async () => {
		const w = world({
			readDocument: async () => {
				throw new Error("Failed to fetch dynamically imported module");
			},
		});
		const result = await run([task(entry("r.pdf", new Uint8Array([0])), "attach")], w.deps);
		expect(result).toEqual({ images: [], files: [], paths: [] });
		expect(w.warned).toHaveLength(1);
		expect(w.warned[0]).toContain("Failed to fetch");
		expect(w.reading).toEqual(["r.pdf", null]);
	});

	test("a stop while a document is read hands nothing over", async () => {
		const w = world();
		w.deps.readDocument = async (f) => {
			w.control.abort();
			return { file: { name: f.name, bytes: 1, text: "x", note: "" }, images: [], notices: ["late"] };
		};
		const result = await run([task(entry("r.pdf", new Uint8Array([0])), "attach")], w.deps);
		expect(result).toBeNull();
		expect(w.noticed).toEqual([]);
	});

	test("a document over what the page reads never reaches the reader: it is only ever asked about", () => {
		const huge = entry("huge.pdf", new Uint8Array([0]));
		expect(classify({ name: "huge.pdf", type: "", size: DOCUMENT_LIMITS.fileBytes + 1 }, false).attach).toBe(
			"documentTooLarge",
		);
		// A remembered attach does not settle it.
		const big = { ...huge, info: classify({ name: "huge.pdf", type: "", size: DOCUMENT_LIMITS.fileBytes + 1 }, false) };
		expect(plan([big], { document: "attach" }).asked).toEqual([big]);
	});

	test("path: the app's own path is written as it is, with nothing sent", async () => {
		const w = world();
		const result = await run(
			[
				task(entry("r.pdf", new Uint8Array([0]), "application/pdf", "/Users/me/r.pdf"), "path"),
				task(entry("src", "", "", "/Users/me/src", true), "path"),
			],
			w.deps,
		);
		expect(result?.paths).toEqual(["/Users/me/r.pdf", "/Users/me/src"]);
		expect(w.uploaded).toEqual([]);
		expect(w.progress).toEqual([]);
	});

	test("path with no path from the app: a copy is sent, and the path is the one the server answered", async () => {
		const w = world();
		const result = await run([task(entry("r.pdf", new Uint8Array([0]), "application/pdf"), "path")], w.deps);
		expect(w.uploaded).toEqual(["r.pdf"]);
		expect(result?.paths).toEqual(["/proj/.omp-webui/uploads/2026-10-24/r.pdf"]);
		// The progress named the file, waiting, then sending, then sent.
		expect(w.progress[0]).toEqual([{ name: "r.pdf", state: "waiting", sent: 0, total: 1 }]);
		expect(w.progress.at(-1)?.[0]?.state).toBe("sent");
	});

	test("a folder with no path (a browser): nothing can be done, and it is said", async () => {
		const w = world();
		const result = await run([task(entry("src", "", "", null, true), "path")], w.deps);
		expect(result?.paths).toEqual([]);
		expect(w.warned).toHaveLength(1);
		expect(w.warned[0]).toContain("src");
		expect(w.uploaded).toEqual([]);
	});

	test("no conversation to send to yet: the file is not sent, and it is said", async () => {
		const w = world({ scope: null });
		const result = await run([task(entry("a.pdf", new Uint8Array([0])), "path")], w.deps);
		expect(result?.paths).toEqual([]);
		expect(w.uploaded).toEqual([]);
		expect(w.warned).toHaveLength(1);
		expect(w.warned[0]).toContain("a.pdf");
	});

	test("a file over the upload limit is refused before anything is sent", async () => {
		const w = world();
		const huge = entry("huge.bin", new Uint8Array([0]));
		Object.defineProperty(huge.file, "size", { value: UPLOAD_LIMITS.fileBytes + 1 });
		const result = await run([task(huge, "path")], w.deps);
		expect(result?.paths).toEqual([]);
		expect(w.uploaded).toEqual([]);
		expect(w.warned[0]).toContain("huge.bin");
		expect(w.warned[0]).toContain("50 MB");
	});

	test("a failed upload is said with the server's reason, and the other files are still sent", async () => {
		const w = world({
			upload: async (_scope, f) => {
				if (f.name === "bad.bin") throw new UploadError("The folder of uploads is full", "quota", 500 * 1024 * 1024);
				return { path: `/p/${f.name}`, name: f.name, bytes: f.size };
			},
		});
		const result = await run(
			[task(entry("bad.bin", new Uint8Array([0])), "path"), task(entry("ok.bin", new Uint8Array([0])), "path")],
			w.deps,
		);
		expect(result?.paths).toEqual(["/p/ok.bin"]);
		expect(w.warned).toHaveLength(1);
		expect(w.warned[0]).toContain("500 MB");
		expect(w.progress.at(-1)?.map((r) => r.state)).toEqual(["failed", "sent"]);
	});

	test("only a drop's worth of files is sent: the rest are left, and it is said once", async () => {
		const w = world();
		const tasks = Array.from({ length: UPLOAD_LIMITS.perDrop + 2 }, (_, i) =>
			task(entry(`f${i}.bin`, new Uint8Array([0])), "path"),
		);
		const result = await run(tasks, w.deps);
		expect(w.uploaded).toHaveLength(UPLOAD_LIMITS.perDrop);
		expect(result?.paths).toHaveLength(UPLOAD_LIMITS.perDrop);
		expect(w.warned.filter((m) => m.includes(String(UPLOAD_LIMITS.perDrop)))).toHaveLength(1);
	});

	test("a stop in the middle of an upload hands over nothing, not even what was done before it", async () => {
		const w = world();
		w.deps.upload = async (_scope, f, _onProgress, signal) => {
			if (f.name === "second.bin") {
				w.control.abort();
				signal.throwIfAborted();
			}
			return { path: `/p/${f.name}`, name: f.name, bytes: f.size };
		};
		const result = await run(
			[
				task(entry("a.txt", "kept?"), "attach"),
				task(entry("first.bin", new Uint8Array([0])), "path"),
				task(entry("second.bin", new Uint8Array([0])), "path"),
				task(entry("third.bin", new Uint8Array([0])), "path"),
			],
			w.deps,
		);
		expect(result).toBeNull();
		expect(w.warned).toEqual([]);
	});

	test("already stopped: nothing is done", async () => {
		const w = world();
		w.control.abort();
		expect(await run([task(entry("a.txt", "x"), "attach")], w.deps)).toBeNull();
	});

	test("text that turns binary after the first look is refused when it is read, with the reason", async () => {
		const w = world();
		const looksFine = entry("late.txt", "plain at first");
		// What the file holds now: the start is text, a NUL comes later (or the file changed since it was looked at).
		const changed: Entry = { ...looksFine, file: new File(["plain at first\0and then not"], "late.txt") };
		const result = await run([task(changed, "attach"), task(entry("ok.txt", "fine"), "attach")], w.deps);
		expect(result?.files.map((f) => f.name)).toEqual(["ok.txt"]);
		expect(w.warned).toHaveLength(1);
		expect(w.warned[0]).toContain("late.txt");
		expect(w.warned[0]).toContain("UTF-8");
	});

	test("text that is not UTF-8 later in the file is refused too (a GBK file's second half)", async () => {
		const w = world();
		const changed: Entry = {
			...entry("gbk.txt", "ascii start"),
			file: new File([new TextEncoder().encode("ascii start "), new Uint8Array([0xd6, 0xd0, 0xce, 0xc4])], "gbk.txt"),
		};
		const result = await run([task(changed, "attach")], w.deps);
		expect(result?.files).toEqual([]);
		expect(w.warned).toHaveLength(1);
	});
});

describe("describe: what each file of a request is, with the app's paths", () => {
	/** A page inside the app: its window answers the one request it knows, once (as `macos/droppaths.swift` does). */
	function inApp(items: ShellItem[]) {
		let asks = 0;
		Object.assign(globalThis, {
			window: {
				webkit: {
					messageHandlers: {
						ompwDrop: {
							postMessage: async () => ({ items: asks++ === 0 ? items : [] }),
						},
					},
				},
			},
		});
		return { asked: () => asks };
	}
	const notInApp = () => Reflect.deleteProperty(globalThis, "window");
	const request = (
		files: File[],
		source: "drop" | "paste" | "pick" = "drop",
		directories = files.map(() => false),
	) => ({
		id: 1,
		files,
		directories,
		source,
	});

	test("a drop in the app: the files are told apart, and each has the path the window kept", async () => {
		const app = inApp([item("a.txt", 5, "/Users/me/a.txt"), item("r.pdf", 3, "/Users/me/r.pdf")]);
		try {
			const files = [
				new File(["hello"], "a.txt", { type: "text/plain" }),
				new File([new Uint8Array([0, 1, 2])], "r.pdf"),
			];
			const entries = await describeEntries(request(files));
			expect(entries.map((e) => [e.file.name, e.info.kind, e.info.attach, e.path])).toEqual([
				["a.txt", "text", true, "/Users/me/a.txt"],
				["r.pdf", "document", true, "/Users/me/r.pdf"],
			]);
			expect(app.asked()).toBe(1);
		} finally {
			notInApp();
		}
	});

	test("a request is asked about once, however often it is described (the window gives what it kept once)", async () => {
		const app = inApp([item("a.txt", 5, "/Users/me/a.txt")]);
		try {
			const r = request([new File(["hello"], "a.txt")]);
			expect((await describeEntries(r))[0]?.path).toBe("/Users/me/a.txt");
			expect((await describeEntries(r))[0]?.path).toBe("/Users/me/a.txt");
			expect(app.asked()).toBe(1);
		} finally {
			notInApp();
		}
	});

	test("a folder the window knows is a folder, though the page could not tell", async () => {
		inApp([item("src", 0, "/Users/me/src", true)]);
		try {
			const entries = await describeEntries(request([new File([], "src")]));
			expect(entries[0]).toMatchObject({ directory: true, path: "/Users/me/src", info: { kind: "folder" } });
		} finally {
			notInApp();
		}
	});

	test("a paste and a picked file never ask the window: they are not the drop it kept", async () => {
		const app = inApp([item("a.txt", 5)]);
		try {
			for (const source of ["paste", "pick"] as const) {
				const entries = await describeEntries(request([new File(["hello"], "a.txt")], source));
				expect(entries[0]?.path).toBeNull();
			}
			expect(app.asked()).toBe(0);
		} finally {
			notInApp();
		}
	});

	test("in a browser there are no paths, and a file is told text or not by its first bytes, not its name", async () => {
		notInApp();
		const entries = await describeEntries(
			request([
				new File(["export const a = 1;\n"], "Makefile"),
				new File([new Uint8Array([137, 80, 78, 71, 0, 0])], "notes.txt"),
				new File(["caf\u00e9"], "menu"),
			]),
		);
		expect(entries.map((e) => [e.file.name, e.info.kind, e.path])).toEqual([
			["Makefile", "text", null],
			["notes.txt", "other", null],
			["menu", "text", null],
		]);
	});
});

describe("describe: the whole of a file is looked at, and its mentions are noticed", () => {
	const request = (files: File[]) => ({ id: 2, files, directories: files.map(() => false), source: "pick" as const });

	test("a file that is UTF-8 for a long first part and binary after is not text", async () => {
		Reflect.deleteProperty(globalThis, "window");
		const text = new TextEncoder().encode("a".repeat(20_000));
		const entries = await describeEntries(
			request([
				new File([text, new Uint8Array([0, 1, 2])], "late.bin"),
				new File([text], "all-text.txt"),
				new File([text.subarray(0, 3), new Uint8Array([0xff])], "tiny.txt"),
			]),
		);
		expect(entries.map((e) => [e.file.name, e.info.kind, e.info.attach])).toEqual([
			["late.bin", "other", "binary"],
			["all-text.txt", "text", true],
			["tiny.txt", "other", "binary"],
		]);
	});

	test("a text file with an @ mention in it is told, one without is not", async () => {
		Reflect.deleteProperty(globalThis, "window");
		const entries = await describeEntries(
			request([
				new File(["see @~/.ssh/config for it"], "a.txt"),
				new File(["mail me@example.com or @name"], "b.txt"),
				new File(['first line\n@"my notes.md"'], "c.txt"),
			]),
		);
		expect(entries.map((e) => e.mentions)).toEqual([true, false, true]);
	});

	test("a mention in a file that cannot be attached is nothing to tell", async () => {
		Reflect.deleteProperty(globalThis, "window");
		const entries = await describeEntries(request([new File(["@/etc/hosts"], "r.doc")]));
		expect(entries[0]).toMatchObject({ mentions: false, info: { attach: "document" } });
	});
});
