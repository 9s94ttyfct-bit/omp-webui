import "./browser-globals.ts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { CSRF_HEADER, ERROR_HEADER } from "../../shared/transfer.ts";
import { en } from "../../web/src/i18n/files.ts";
import { registerStrings } from "../../web/src/i18n/index.ts";
import { eolOf, saveFailureText, saveFile } from "../../web/src/lib/file-save.ts";
import { holdLeaveGuard, whenFree } from "../../web/src/lib/leave-guard.ts";
import { TransferError } from "../../web/src/lib/transfer-api.ts";
import { useApp } from "../../web/src/store/app.ts";
import { closeBig, openBig, useBig } from "../../web/src/store/big.ts";
import { installGlobals, location, restoreGlobals } from "./browser-globals.ts";

registerStrings("files", en);

/**
 * What the page does about editing a file (`FileEditor.tsx`, which is the one piece not tested here: it needs a browser, and
 * `tests/e2e/file-edit.spec.ts` has it): the line ending a text is saved with, the request of a save and what a refusal says,
 * and the guard that asks before unsaved text is left (another view, the large view closing or showing another file).
 */

beforeAll(() => {
	installGlobals();
	// `openBig` notes what had focus: no element has, in a page that is made up.
	Object.assign(globalThis, { document: { activeElement: null, body: null }, HTMLElement: class {} });
});
afterAll(() => {
	Reflect.deleteProperty(globalThis, "document");
	Reflect.deleteProperty(globalThis, "HTMLElement");
	restoreGlobals();
});

describe("the line ending a text is saved with", () => {
	test("the one most of its lines end with: a CRLF file comes back CRLF, an LF file LF, a mixed one its commonest", () => {
		expect(eolOf("a\nb\nc\n")).toBe("\n");
		expect(eolOf("a\r\nb\r\nc\r\n")).toBe("\r\n");
		expect(eolOf("a\r\nb\r\nc\n")).toBe("\r\n");
		expect(eolOf("a\nb\nc\r\n")).toBe("\n");
		expect(eolOf("no newline at all")).toBe("\n");
		expect(eolOf("")).toBe("\n");
	});

	test("what the editor holds as lines is written back as the file had them, byte for byte", () => {
		for (const text of ["one\r\ntwo\r\n\r\nthree", "one\ntwo\n\nthree\n", "single line", "trailing\r\n"]) {
			const doc = EditorState.create({ doc: text }).doc;
			expect(doc.sliceString(0, doc.length, eolOf(text))).toBe(text);
		}
	});
});

describe("saving", () => {
	let fetched: { url: string; init: RequestInit }[] = [];
	const answer = (status: number, body: unknown, headers: Record<string, string> = {}) => {
		spyOn(globalThis, "fetch").mockImplementation((async (url: string, init: RequestInit) => {
			fetched.push({ url, init });
			return new Response(JSON.stringify(body), { status, headers });
		}) as unknown as typeof fetch);
	};
	beforeEach(() => {
		fetched = [];
	});
	afterEach(() => {
		(globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.();
	});

	test("names the conversation, the file, the text and the etag it was made from, with the CSRF header", async () => {
		answer(200, { etag: "new", size: 3, modified: 9 });
		const saved = await saveFile({ live: "live-1", file: "/s/a.jsonl" }, "src/a.ts", "abc", "old");
		expect(saved).toEqual({ etag: "new", size: 3, modified: 9 });
		const [call] = fetched;
		expect(call.url).toBe("/api/folder/file");
		expect(call.init.method).toBe("POST");
		expect((call.init.headers as Record<string, string>)[CSRF_HEADER]).toBe("1");
		expect(JSON.parse(call.init.body as string)).toEqual({
			live: "live-1",
			file: "/s/a.jsonl",
			path: "src/a.ts",
			text: "abc",
			etag: "old",
		});
	});

	test("a conflict carries the etag the file has now; other refusals carry their codes; a lost connection is not an answer", async () => {
		answer(409, { error: "changed", code: "conflict", etag: "disk" }, { [ERROR_HEADER]: "conflict" });
		const conflict = await saveFile({ live: null, file: "f" }, "a.txt", "x", "old").catch((e: unknown) => e);
		expect(conflict).toBeInstanceOf(TransferError);
		expect(conflict).toMatchObject({ code: "conflict", status: 409, etag: "disk" });
		(globalThis.fetch as unknown as { mockRestore: () => void }).mockRestore();
		answer(403, { error: "no", code: "uploadOff" });
		expect(await saveFile({ live: null, file: "f" }, "a.txt", "x", "old").catch((e: unknown) => e)).toMatchObject({
			code: "uploadOff",
			status: 403,
		});
		(globalThis.fetch as unknown as { mockRestore: () => void }).mockRestore();
		spyOn(globalThis, "fetch").mockImplementation((async () => {
			throw new TypeError("network");
		}) as unknown as typeof fetch);
		expect(await saveFile({ live: null, file: "f" }, "a.txt", "x", "old").catch((e: unknown) => e)).toMatchObject({
			code: "failed",
			status: 0,
		});
	});

	test("a refusal is worded for saving (not for transferring), with the file's name and the limit", () => {
		const refusal = (code: TransferError["code"], extra: ConstructorParameters<typeof TransferError>[3] = {}) =>
			new TransferError("sentence", code, 403, extra);
		expect(saveFailureText(refusal("secret"), ".env")).toBe(
			"“.env” looks like a secret (a key or credentials): it is not edited here.",
		);
		expect(saveFailureText(refusal("tooLarge", { limit: 1024 * 1024 }), "a.txt")).toContain("1.0 MB");
		expect(saveFailureText(refusal("notText"), "b.txt")).toContain("not UTF-8 text");
		expect(saveFailureText(refusal("conflict"), "c.txt")).toContain("changed on the computer");
		// What has no words of its own is the transfer's, and what is no refusal at all is its message.
		expect(saveFailureText(refusal("uploadOff"), "d.txt")).toContain("Uploads are turned off");
		expect(saveFailureText(new Error("boom"), "e.txt")).toBe("boom");
	});
});

describe("asking before unsaved text is lost", () => {
	beforeEach(() => {
		location.hash = "";
		useApp.setState({ view: { kind: "chat", file: "/s/a.jsonl", liveId: null } });
		useBig.setState({ chatKey: null, target: null });
	});
	let release: (() => void) | null = null;
	afterEach(() => {
		release?.();
		release = null;
	});
	/** A holder that blocks everything but the view `except` names, and asks by keeping what it was asked. */
	function holder(blocks = true) {
		const asked: { go: () => void; stay?: () => void }[] = [];
		release = holdLeaveGuard({ blocks: () => blocks, ask: (go, stay) => asked.push({ go, stay }) });
		return asked;
	}

	test("with nothing held, going is going", () => {
		let went = false;
		whenFree(null, () => {
			went = true;
		});
		expect(went).toBe(true);
	});

	test("a held guard that blocks asks, and goes only when the person agrees; one that does not block lets go", () => {
		const asked = holder();
		let went = 0;
		let stayed = 0;
		whenFree(
			null,
			() => went++,
			() => stayed++,
		);
		expect([went, stayed, asked.length]).toEqual([0, 0, 1]);
		asked[0]?.stay?.();
		expect([went, stayed]).toEqual([0, 1]);
		asked[0]?.go();
		expect(went).toBe(1);
		release?.();
		const free = holder(false);
		whenFree(null, () => went++);
		expect([went, free.length]).toEqual([2, 0]);
	});

	test("a guard that was given up is gone, and giving up one that is not the holder's keeps the holder's", () => {
		const first = { blocks: () => true, ask: () => {} };
		const giveUpFirst = holdLeaveGuard(first);
		const asked = holder();
		giveUpFirst();
		let went = false;
		whenFree(null, () => {
			went = true;
		});
		expect([went, asked.length]).toEqual([false, 1]);
		release?.();
		let after = false;
		whenFree(null, () => {
			after = true;
		});
		expect(after).toBe(true);
	});

	test("another view is not shown until the person agrees; the address is not written either", () => {
		const asked = holder();
		useApp.getState().setView({ kind: "memory" });
		expect(useApp.getState().view).toEqual({ kind: "chat", file: "/s/a.jsonl", liveId: null });
		expect(location.hash).toBe("");
		asked[0]?.go();
		expect(useApp.getState().view).toEqual({ kind: "memory" });
		expect(location.hash).toBe("#/memory");
	});

	test("the large view neither closes nor shows another file until the person agrees", () => {
		openBig("/s/a.jsonl", { kind: "file", path: "a.txt" });
		expect(useBig.getState().target).toEqual({ kind: "file", path: "a.txt" });
		const asked = holder();
		openBig("/s/a.jsonl", { kind: "file", path: "b.txt" });
		closeBig();
		expect(useBig.getState().target).toEqual({ kind: "file", path: "a.txt" });
		expect(asked.length).toBe(2);
		asked[0]?.go();
		expect(useBig.getState().target).toEqual({ kind: "file", path: "b.txt" });
		asked[1]?.go();
		expect(useBig.getState().target).toBeNull();
	});
});
