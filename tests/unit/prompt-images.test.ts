import { afterAll, beforeAll, expect, test } from "bun:test";
import { type AgentMessage, promptImages } from "../../web/src/lib/messages.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

// The page's modules read localStorage as they load; load them after the stubs are in place.
installGlobals();
const { blobBase64 } = await import("../../web/src/lib/api.ts");

beforeAll(installGlobals);
afterAll(restoreGlobals);

/** Regenerate and Edit resend the prompt's attachments: inline images as they are, stored ones fetched back to base64. */

const user = (content: AgentMessage["content"]): AgentMessage => ({ role: "user", content });
const never = async (): Promise<string> => {
	throw new Error("nothing should be fetched");
};
const HASH = "ab".repeat(32);

test("an inline image is resent as it is", async () => {
	const m = user([
		{ type: "text", text: "what is this?" },
		{ type: "image", data: "QUJD", mimeType: "image/png" },
	]);
	expect(await promptImages(m, never)).toEqual([{ type: "image", data: "QUJD", mimeType: "image/png" }]);
});

test("an image the session stored as a blob is fetched back to base64", async () => {
	const asked: string[] = [];
	const m = user([{ type: "image", data: `blob:sha256:${HASH}`, mimeType: "image/jpeg" }]);
	const out = await promptImages(m, async (hash) => {
		asked.push(hash);
		return "SGVsbG8=";
	});
	expect(asked).toEqual([HASH]);
	expect(out).toEqual([{ type: "image", data: "SGVsbG8=", mimeType: "image/jpeg" }]);
});

test("an image-only prompt keeps its images and keeps their order", async () => {
	const m = user([
		{ type: "image", data: `blob:sha256:${HASH}`, mimeType: "image/png" },
		{ type: "image", data: "QUJD", mimeType: "image/gif" },
	]);
	const out = await promptImages(m, async () => "Zmlyc3Q=");
	expect(out.map((i) => [i.data, i.mimeType])).toEqual([
		["Zmlyc3Q=", "image/png"],
		["QUJD", "image/gif"],
	]);
});

test("a prompt without images resends none", async () => {
	expect(await promptImages(user("just text"), never)).toEqual([]);
	expect(await promptImages(user([{ type: "text", text: "just text" }]), never)).toEqual([]);
});

test("an image that cannot be loaded fails the resend rather than being dropped", async () => {
	const m = user([{ type: "image", data: `blob:sha256:${HASH}`, mimeType: "image/png" }]);
	await expect(
		promptImages(m, async () => {
			throw new Error("Not found");
		}),
	).rejects.toThrow("Not found");
});

/** What a session file's image block can say after `blob:sha256:` that is not a sha256: the browser resolves `..` before the server sees the address. */
const NOT_STORED = [
	"../meta",
	"../session?file=/home/me/.omp/agent/sessions/other.jsonl",
	"../../etc/passwd",
	`${HASH}/../meta`,
	`${HASH}?x=1`,
	`${HASH}#frag`,
	`${HASH.toUpperCase()}`,
	HASH.slice(1),
	`${HASH}0`,
	"%2e%2e/meta",
	"",
	"x".repeat(64),
];

test("a reference that is not a sha256 is never requested: the resend fails with the loader untouched", async () => {
	for (const reference of NOT_STORED) {
		const asked: string[] = [];
		const m = user([{ type: "image", data: `blob:sha256:${reference}`, mimeType: "image/png" }]);
		await expect(
			promptImages(m, async (hash) => {
				asked.push(hash);
				return "AAAA";
			}),
		).rejects.toThrow("not a stored image");
		expect({ reference, asked }).toEqual({ reference, asked: [] });
	}
	// One bad reference fails the whole resend, even next to a good one: nothing is fetched.
	const asked: string[] = [];
	const mixed = user([
		{ type: "image", data: `blob:sha256:${HASH}`, mimeType: "image/png" },
		{ type: "image", data: "blob:sha256:../meta", mimeType: "image/png" },
	]);
	await expect(
		promptImages(mixed, async (hash) => {
			asked.push(hash);
			return "AAAA";
		}),
	).rejects.toThrow("not a stored image");
	expect(asked).not.toContain("../meta");
});

test("the fetch itself refuses what is not a sha256, whoever asks", async () => {
	const requested: string[] = [];
	const real = globalThis.fetch;
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		requested.push(String(input));
		return new Response(new Uint8Array([72, 105]));
	}) as typeof fetch;
	try {
		for (const reference of NOT_STORED) await expect(blobBase64(reference)).rejects.toThrow("Not a stored image");
		expect(requested).toEqual([]);
		expect(await blobBase64(HASH)).toBe("SGk=");
		expect(requested).toEqual([`/api/blob/${HASH}`]);
	} finally {
		globalThis.fetch = real;
	}
});
