import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, realpathSync } from "node:fs";
import { startTestServer, type TestServer } from "../support/server.ts";

/** `/api/family` and `/api/session` revalidation against the real server. No omp is started. */

interface Family {
	file: string;
	members: { file: string }[];
}

let s: TestServer;
const authed = () => ({ "x-omp-webui-token": s.accessToken });
beforeAll(async () => {
	s = await startTestServer();
});
afterAll(async () => {
	await s?.stop();
});

test("a transcript answer carries an ETag, and a request that shows it is answered with a 304 and no body", async () => {
	const url = `${s.url}/api/session?file=${encodeURIComponent(s.fixtures.alpha)}`;
	const headers = { ...authed(), "accept-encoding": "gzip" };
	const first = await fetch(url, { headers });
	expect(first.status).toBe(200);
	const etag = first.headers.get("etag") as string;
	expect(etag).toBeTruthy();
	const session: { file: string; entries: { id: string }[]; subagents: unknown[] } = await first.json();
	expect(session.file).toBe(realpathSync(s.fixtures.alpha));
	expect(session.entries.length).toBeGreaterThan(0);

	const again = await fetch(url, { headers: { ...headers, "if-none-match": etag } });
	expect(again.status).toBe(304);
	expect(await again.text()).toBe("");
	// A file outside the sessions dir is none of its business.
	expect((await fetch(`${s.url}/api/session?file=${encodeURIComponent("/etc/hosts")}`, { headers })).status).toBe(404);
});

test("a family answer carries an ETag, and a request that shows it is answered with a 304 and no body", async () => {
	const url = `${s.url}/api/family?file=${encodeURIComponent(s.fixtures.alpha)}`;
	const headers = { ...authed(), "accept-encoding": "gzip" };
	const first = await fetch(url, { headers });
	expect(first.status).toBe(200);
	const etag = first.headers.get("etag") as string;
	expect(etag).toBeTruthy();
	const family: Family = await first.json();
	expect(family.members.map((m) => m.file)).toEqual([realpathSync(s.fixtures.alpha), realpathSync(s.fixtures.beta)]);

	const again = await fetch(url, { headers: { ...headers, "if-none-match": etag } });
	expect(again.status).toBe(304);
	expect(await again.text()).toBe("");
	expect(again.headers.get("etag")).toBe(etag);
	// Every response still goes through the server's header pass.
	expect(again.headers.get("content-security-policy")).toBeTruthy();

	// A conversation of the lineage that grows is a new document.
	appendFileSync(
		s.fixtures.beta,
		`${JSON.stringify({ type: "message", id: "f00000ff", parentId: "f0000015", message: { role: "user", content: [{ type: "text", text: "later" }] } })}\n`,
	);
	const grown = await fetch(url, { headers: { ...headers, "if-none-match": etag } });
	expect(grown.status).toBe(200);
	expect(grown.headers.get("etag")).not.toBe(etag);
});

test("a client that can put the shared path back together is sent it once, and every file whole otherwise", async () => {
	const url = `${s.url}/api/family?file=${encodeURIComponent(s.fixtures.alpha)}`;
	const shared = { ...authed(), "accept-encoding": "gzip", "x-family-dedup": "1" };
	// The branch (beta) holds the path of the conversation it was made from copied: that path is sent once.
	const deduped = await (await fetch(url, { headers: shared })).json();
	expect(deduped.members[0].order).toBeUndefined();
	expect(deduped.members[1].order.length).toBeGreaterThan(0);
	// The entries themselves are in the file that was sent first, and the fork has only its own.
	expect(deduped.members[1].entries.length).toBeLessThan(deduped.members[1].order.length);
	// A client that does not say so is sent every file whole.
	const whole = await (await fetch(url, { headers: { ...authed(), "accept-encoding": "gzip" } })).json();
	expect(whole.members.every((m: { order?: string[] }) => m.order === undefined)).toBe(true);
	expect(whole.members[1].entries.length).toBeGreaterThan(deduped.members[1].entries.length);
});

test("a client that names the files it holds is sent the file that was written to, and the others by name", async () => {
	const url = `${s.url}/api/family?file=${encodeURIComponent(s.fixtures.alpha)}`;
	const headers = { ...authed(), "accept-encoding": "gzip", "x-family-dedup": "1" };
	const first = await fetch(url, { headers });
	const held: { file: string; tag: string }[] = (await first.json()).members;
	expect(held.map((m) => m.file)).toEqual([realpathSync(s.fixtures.alpha), realpathSync(s.fixtures.beta)]);
	const have = held.map((m) => m.tag).join(",");

	// The branch is written to while a tab shows the conversation.
	appendFileSync(
		s.fixtures.beta,
		`${JSON.stringify({ type: "message", id: "f00000fe", parentId: "f0000015", message: { role: "user", content: [{ type: "text", text: "later still" }] } })}\n`,
	);
	const next = await fetch(url, { headers: { ...headers, "x-family-have": have } });
	expect(next.status).toBe(200);
	expect(next.headers.get("etag")).not.toBe(first.headers.get("etag"));
	const members: { file: string; tag: string; kept?: boolean; entries?: { id: string }[] }[] = (await next.json())
		.members;
	// The conversation is named, as the tab holds it; the branch is sent, with the entry that was written.
	expect(members[0]).toEqual({ file: held[0]?.file, tag: held[0]?.tag, kept: true });
	expect(members[1]?.kept).toBeUndefined();
	expect(members[1]?.tag).not.toBe(held[1]?.tag);
	expect(members[1]?.entries?.map((e) => e.id)).toContain("f00000fe");
});

test("the family answer says what it varies on: the encoding, the shared path, and the files a client holds", async () => {
	const url = `${s.url}/api/family?file=${encodeURIComponent(s.fixtures.alpha)}`;
	// A body in which some files are only named is not the body of a request that holds other files, and the ETag is
	// the same for both: a cache that keeps the answer of one for the other needs to know they differ.
	const vary = (
		await fetch(url, { headers: { ...authed(), "accept-encoding": "gzip", "x-family-dedup": "1" } })
	).headers.get("vary");
	expect(vary).toContain("accept-encoding");
	expect(vary).toContain("x-family-dedup");
	expect(vary).toContain("x-family-have");
	// The same for a transcript, which is one file and varies on nothing else.
	const one = await fetch(`${s.url}/api/session?file=${encodeURIComponent(s.fixtures.alpha)}`, {
		headers: { ...authed(), "accept-encoding": "gzip" },
	});
	expect(one.headers.get("vary")).toContain("accept-encoding");
});
