import { expect, test } from "bun:test";
import { type AppDownload, CefLink, type ServerToApp } from "../../server/browser/cef.ts";
import { DownloadList, KEPT_PER_CONVERSATION } from "../../server/browser/downloads.ts";

/**
 * The built-in browser's downloads as the server keeps them (server/browser/downloads.ts): each one is the conversation's
 * whose page started it, from the first word of it on, and a conversation keeps its newest ones.
 */

const download = (id: string, over: Partial<AppDownload> = {}): AppDownload => ({
	id,
	targetId: "T1",
	name: `${id}.txt`,
	path: `/Users/me/Downloads/${id}.txt`,
	state: "progress",
	received: 0,
	total: 100,
	...over,
});

function list(owners: Record<string, string | null> = { T1: "c1" }) {
	const changed: string[] = [];
	const l = new DownloadList(
		(targetId) => owners[targetId] ?? null,
		(owner) => changed.push(owner),
	);
	return { l, changed, owners };
}

test("a download is the conversation's whose page started it, and that conversation is told", () => {
	const { l, changed } = list();
	l.update(download("d1"));
	expect(l.of("c1").map((d) => d.id)).toEqual(["d1"]);
	expect(l.of("c2")).toEqual([]);
	expect(changed).toEqual(["c1"]);
});

test("it stays the conversation's after its page closed", () => {
	const { l, owners } = list();
	l.update(download("d1"));
	owners.T1 = null;
	l.update(download("d1", { state: "done", received: 100 }));
	expect(l.of("c1")).toMatchObject([{ id: "d1", state: "done", received: 100 }]);
});

test("a download of a page nobody owns is not kept", () => {
	const { l, changed } = list({});
	l.update(download("d1"));
	expect(l.get("d1")).toBeNull();
	expect(changed).toEqual([]);
});

test("a download of a page that is already gone is the conversation of the page that opened it", () => {
	const { l } = list({ OPENER: "c1" });
	l.update(download("d1", { targetId: "GONE", openerId: "OPENER" }));
	expect(l.of("c1").map((d) => d.id)).toEqual(["d1"]);
});

test("a page is told the name, never the path; an unknown size is null", () => {
	const { l } = list();
	l.update(download("d1", { total: -1 }));
	const [item] = l.of("c1");
	expect(item).not.toHaveProperty("path");
	expect(item?.total).toBeNull();
	expect(l.get("d1")?.path).toBe("/Users/me/Downloads/d1.txt");
});

test("newest first; past the limit the oldest finished go, a running one never does", () => {
	const { l } = list();
	l.update(download("running"));
	for (let i = 0; i < KEPT_PER_CONVERSATION; i++) l.update(download(`f${i}`, { state: "done", received: 100 }));
	const ids = l.of("c1").map((d) => d.id);
	expect(ids).toHaveLength(KEPT_PER_CONVERSATION);
	expect(ids[0]).toBe(`f${KEPT_PER_CONVERSATION - 1}`);
	expect(ids).toContain("running");
	expect(ids).not.toContain("f0");
});

test("a finished download is not changed back by a late progress report", () => {
	const { l } = list();
	l.update(download("d1", { state: "done", received: 100 }));
	l.update(download("d1", { state: "progress", received: 50 }));
	expect(l.of("c1")[0]).toMatchObject({ state: "done", received: 100 });
});

test("a moved conversation's downloads follow it and a gone one's are dropped, each told at once; nothing to move tells nobody", () => {
	const { l, changed } = list({ T1: "c1", T2: "c2" });
	l.update(download("d1"));
	l.update(download("d2", { targetId: "T2" }));
	changed.length = 0;
	l.rekey("c1", "moved");
	expect(changed).toEqual(["c1", "moved"]);
	expect(l.of("c1")).toEqual([]);
	expect(l.of("moved").map((d) => d.id)).toEqual(["d1"]);
	l.forget("c2");
	expect(changed).toEqual(["c1", "moved", "c2"]);
	expect(l.of("c2")).toEqual([]);
	l.rekey("nobody", "else");
	l.forget("nobody");
	expect(changed).toEqual(["c1", "moved", "c2"]);
});

test("the app's download ids are its CEF run's: after CEF started again the same id is another download, and only the current run's is stopped", () => {
	const told: ServerToApp[] = [];
	const got: AppDownload[] = [];
	const link = new CefLink(
		{ send: (text) => told.push(JSON.parse(text) as ServerToApp) },
		() => {},
		(d) => got.push(d),
	);
	for (const run of ["r1", "r2"]) {
		link.receive(JSON.stringify({ t: "hello", run, version: "156.0.0", pages: [] }));
		link.receive(JSON.stringify({ t: "download", download: download("7") }));
	}
	expect(got.map((d) => d.id)).toEqual(["r1.7", "r2.7"]);
	link.cancelDownload("r1.7");
	link.cancelDownload("r2.7");
	expect(told).toEqual([{ t: "download_cancel", id: "7" }]);
});
