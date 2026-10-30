import { beforeAll, expect, test } from "bun:test";
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../support/temp-dirs.ts";

/**
 * The macOS app's file drops (macos/droppaths.swift): a page never learns where a dropped file is, so the window's web
 * view keeps the file URLs of the drag's pasteboard and the page asks for them over a script message handler
 * (web/src/lib/shell-drop.ts has the protocol). Compiled with the `swiftc` the app is built with, a headless harness
 * checks which items file URLs make (files, a folder, a file reference, what is gone or not a file, the cap), what the
 * page is told, which messages are the request, and what a drop keeps: once, for fifteen seconds (the clock is injected),
 * and replaced by a later drag that has no files. The sender check is the `isOwnPage` the handler calls: a
 * WKScriptMessage cannot be built outside WebKit. The harness needs no window and no app, only a private NSPasteboard.
 * It leaves its temp directories behind; the test deletes nothing.
 */

const here = import.meta.dir;
const mac = process.platform === "darwin" && Bun.which("swiftc") !== null;
// The real path: /tmp and /var are symlinks on macOS, and a file reference URL resolves them.
const dir = realpathSync(tempDir("ompw-drop-"));
const files = join(dir, "files");
const harness = join(dir, "drop-harness");

interface Item {
	name: string;
	path: string;
	directory: boolean;
	size: number;
}

interface Report {
	handlerName: string;
	keepSeconds: number;
	items: {
		files: Item[];
		missing: Item[];
		notFile: Item[];
		none: Item[];
		referenceMade: boolean;
		reference: Item[];
		capped: { count: number; max: number; lastName: string; allFirst: boolean };
		justUnderCap: number;
	};
	answer: { valid: boolean; json: string; keys: string[]; empty: boolean; emptyCount: number };
	requests: { body: string; request: boolean }[];
	ownPage: boolean[];
	kept: Record<string, Item[] | { first: Item[]; second: Item[] } | { stale: Item[]; after: Item[] }>;
}

let report: Report;
beforeAll(async () => {
	if (!mac) return;
	mkdirSync(files);
	const built = Bun.spawnSync(
		[
			"swiftc",
			"-O",
			"-swift-version",
			"5",
			join(here, "../../macos/droppaths.swift"),
			// `isOwnPage` lives with the notification bridge.
			join(here, "../../macos/notifications.swift"),
			join(here, "../support/swift/drop-harness.swift"),
			"-o",
			harness,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (built.exitCode !== 0) throw new Error(`swiftc failed:\n${built.stderr.toString()}`);
	const run = Bun.spawnSync([harness, files], { stdout: "pipe", stderr: "pipe" });
	if (run.exitCode !== 0) throw new Error(`the harness failed (${run.exitCode}):\n${run.stderr.toString()}`);
	report = JSON.parse(run.stdout.toString());
}, 180_000);

const note: Item = { name: "a note.txt", path: join(files, "a note.txt"), directory: false, size: 5 };
const bin: Item = { name: "b.bin", path: join(files, "b.bin"), directory: false, size: 1234 };
const empty: Item = { name: "empty", path: join(files, "empty"), directory: false, size: 0 };
const folder: Item = { name: "a folder", path: join(files, "a folder"), directory: true, size: 0 };

test.skipIf(!mac)("the handler and its keep time are the ones the page's protocol names", () => {
	expect(report.handlerName).toBe("ompwDrop");
	expect(report.keepSeconds).toBe(15);
});

test.skipIf(!mac)("file URLs make items with their name, path, kind and size, in the order of the drag", () => {
	// A folder has no size of its own; an empty file has none because it is empty.
	expect(report.items.files).toEqual([note, folder, bin, empty]);
	expect(report.items.none).toEqual([]);
});

test.skipIf(!mac)("what is gone from disk or is not a file URL is left out, the rest is kept", () => {
	expect(report.items.missing).toEqual([note]);
	expect(report.items.notFile).toEqual([note]);
});

test.skipIf(!mac)("a file reference URL is resolved to the file's path", () => {
	expect(report.items.referenceMade).toBe(true);
	expect(report.items.reference).toEqual([note]);
});

test.skipIf(!mac)("no more than maxDroppedItems are handed over, counting items and not what was left out", () => {
	const { capped } = report.items;
	expect(capped.max).toBe(200);
	expect(capped.count).toBe(200);
	// Ten missing files came first and took no place; the file after the 200th is cut.
	expect(capped.allFirst).toBe(true);
	expect(capped.lastName).toBe("a note.txt");
	expect(report.items.justUnderCap).toBe(200);
});

test.skipIf(!mac)("the answer is the page's {items:[{name,path,directory,size}]}, JSON-serialisable, in order", () => {
	expect(report.answer.valid).toBe(true);
	expect(report.answer.keys).toEqual(["items"]);
	expect(JSON.parse(report.answer.json)).toEqual({ items: [bin, folder, note] });
	expect(report.answer.empty).toBe(true);
	expect(report.answer.emptyCount).toBe(0);
});

test.skipIf(!mac)('only {type:"paths"} is the request', () => {
	const asked = report.requests.filter((r) => r.request).map((r) => r.body);
	expect(asked).toEqual(["paths"]);
	expect(report.requests.length).toBeGreaterThan(8);
});

test.skipIf(!mac)(
	"only the page the app serves may ask: its scheme, host and port; a missing origin refuses all",
	() => {
		// own; other port; other host; other scheme; no origin yet; a foreign host on the right port.
		expect(report.ownPage).toEqual([true, false, false, false, false, false]);
	},
);

test.skipIf(!mac)("a drop is handed over once, then nothing", () => {
	const once = report.kept.once as { first: Item[]; second: Item[] };
	expect(once.first).toEqual([note, folder]);
	expect(once.second).toEqual([]);
	expect(report.kept.neverCaptured).toEqual([]);
});

test.skipIf(!mac)("a drop is kept for 15 s: 14 s later it is there, 16 s later it is not, and stays gone", () => {
	expect(report.kept.fresh).toEqual([note]);
	const stale = report.kept.stale as { stale: Item[]; after: Item[] };
	expect(stale.stale).toEqual([]);
	expect(stale.after).toEqual([]);
	expect(report.kept.staleStaysGone).toEqual([]);
});

test.skipIf(!mac)(
	"a later drag replaces the drop: text, a link or a file that is gone never get the earlier files",
	() => {
		expect(report.kept.textReplaces).toEqual([]);
		expect(report.kept.linkReplaces).toEqual([]);
		expect(report.kept.gone).toEqual([]);
		expect(report.kept.newerReplaces).toEqual([bin]);
	},
);

test.skipIf(!mac)("the keep time runs from the last drag, not the first", () => {
	// Drags at 0 s and 10 s, asked at 20 s: 10 s since the one that counts.
	expect(report.kept.ageFromLastDrag).toEqual([bin]);
});
