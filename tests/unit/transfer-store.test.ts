import "./browser-globals.ts";
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { en } from "../../web/src/i18n/files.ts";
import { registerStrings } from "../../web/src/i18n/index.ts";
import { browserTransport, type Reply } from "../../web/src/lib/transfer-api.ts";
import { clearUpload, startUpload } from "../../web/src/lib/transfer-store.ts";
import { useApp } from "../../web/src/store/app.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

registerStrings("files", en);

/**
 * What the page says when an upload of a conversation ends (`lib/transfer-store.ts`): the files of the upload that just
 * ended, not every file the conversation's list has held since it was last cleared.
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);

const scope = { live: "live 1", file: null };
const reply = (status: number, body: unknown): Reply => ({
	status,
	text: JSON.stringify(body),
	code: null,
	retryAfterMs: 0,
});
const ok = (name: string) =>
	reply(200, { done: true, path: name, name, bytes: 1, sha256: "0".repeat(64), replaced: false });
const refused = () => reply(413, { error: "too large", code: "tooLarge" });

/** What the page said; `upload` waits for the next of it. */
let said: (text: string) => void = () => {};

/** Upload one file, answered with `answer`, and wait for what the page says once it has ended. */
function upload(name: string, answer: Reply): Promise<string> {
	const { promise, resolve } = Promise.withResolvers<string>();
	said = resolve;
	spyOn(browserTransport, "piece").mockImplementation(async () => answer);
	startUpload(scope, "", {
		items: [{ file: new File(["x"], name), dir: "", name, size: 1 }],
		hidden: 0,
		tooMany: false,
	});
	return promise;
}

test("each upload's toast counts the files of that upload, not the ones sent before it", async () => {
	useApp.setState({ toast: (_level, text) => said(text) });
	clearUpload(scope);

	expect(await upload("a.txt", ok("a.txt"))).toBe("1 files uploaded.");
	expect(await upload("b.txt", ok("b.txt"))).toBe("1 files uploaded.");
	expect(await upload("c.txt", refused())).toBe("0 of 1 files uploaded; 1 could not be sent.");
	// The failure of the upload before is not this one's.
	expect(await upload("d.txt", ok("d.txt"))).toBe("1 files uploaded.");
	clearUpload(scope);
});
