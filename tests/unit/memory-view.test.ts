import { describe, expect, test } from "bun:test";
import {
	looksLikeSecret,
	MEMORY_CONTENT_MAX,
	type MemoryBank,
	type MemoryDetail,
	queryString,
} from "../../shared/memory.ts";
import { en } from "../../web/src/i18n/memory.ts";
import { zh } from "../../web/src/i18n/zh-CN/memory.ts";
import {
	changeOf,
	dirty,
	draftOf,
	INITIAL_FILTERS,
	importanceOf,
	importanceValid,
	movedOn,
	projectNames,
	queryOf,
	rebase,
	saveable,
	secretTyped,
} from "../../web/src/lib/memory-view.ts";

/** The Memory page's own logic outside the page: what it asks the server for, what an edit would change, its words. */

const item = (over: Partial<MemoryDetail> = {}): MemoryDetail => ({
	bank: "default",
	id: "m1",
	store: "working",
	kind: "note",
	scope: "global",
	content: "Prefers tabs.",
	length: 13,
	truncated: false,
	importance: 0.75,
	createdAt: null,
	retired: false,
	provenance: { source: null, origin: "other", tool: null, sessionId: null, cwd: null, context: null },
	veracity: null,
	memoryType: null,
	trustTier: null,
	author: null,
	consolidatedAt: null,
	validUntil: null,
	supersededBy: null,
	recallCount: null,
	lastRecalled: null,
	summaryOf: [],
	consolidatedInto: [],
	etag: "e",
	editable: true,
	retirable: true,
	...over,
});

const bank = (name: string, label: string, cwd?: string): MemoryBank => ({
	bank: name,
	scope: "project",
	label,
	cwds: cwd ? [cwd] : [],
	working: 1,
	episodic: 0,
	retired: 0,
	bytes: 1,
	writeProblem: null,
});

describe("what the list is asked for", () => {
	test("is the filters and the search, and a project's bank only while the scope is project", () => {
		expect(queryOf(INITIAL_FILTERS, "  zebra ", 50, 0)).toEqual({
			q: "zebra",
			scope: "all",
			bank: "",
			kinds: ["note", "consolidated"],
			retired: "active",
			limit: 50,
			offset: 0,
		});
		const project = { ...INITIAL_FILTERS, scope: "project" as const, bank: "app-1", includeRetired: true };
		expect(queryOf(project, "", 50, 50)).toMatchObject({ scope: "project", bank: "app-1", retired: "all", offset: 50 });
		// A bank left in the filters by a scope that was then changed is not asked for.
		expect(queryOf({ ...project, scope: "global" }, "", 50, 0).bank).toBe("");
	});

	test("goes into the URL as the server reads it, leaving out what is the default", () => {
		expect(queryString(queryOf(INITIAL_FILTERS, "", 50, 0))).toBe("kinds=note%2Cconsolidated&limit=50");
		expect(
			queryString({ q: "a b&c", scope: "project", bank: "x-1", kinds: ["conversation"], retired: "all", offset: 50 }),
		).toBe("q=a+b%26c&scope=project&bank=x-1&kinds=conversation&retired=all&offset=50");
	});
});

describe("an edit", () => {
	const edit = (m: MemoryDetail, over: { content?: string; importance?: string } = {}) => ({ ...draftOf(m), ...over });

	test("changes only what differs from what it began from, and an importance is a number from 0 to 1", () => {
		const m = item();
		expect(changeOf(draftOf(m))).toEqual({});
		expect(changeOf(edit(m, { content: "Prefers spaces." }))).toEqual({ content: "Prefers spaces." });
		expect(changeOf(edit(m, { importance: "0.5" }))).toEqual({ importance: 0.5 });
		expect(importanceOf("1")).toBe(1);
		expect(importanceOf("0")).toBe(0);
		expect(importanceOf("1.01")).toBeUndefined();
		expect(importanceOf("-0.1")).toBeUndefined();
		expect(importanceOf("abc")).toBeUndefined();
		expect(importanceOf("  ")).toBeNull();
	});

	test("cannot be saved empty, too long, unchanged, or with an importance that is none (a memory that has one keeps one)", () => {
		const m = item();
		expect(saveable(edit(m, { content: "Changed." }))).toBe(true);
		expect(saveable(draftOf(m))).toBe(false);
		expect(saveable(edit(m, { content: "  \n " }))).toBe(false);
		expect(saveable(edit(m, { content: "x".repeat(MEMORY_CONTENT_MAX + 1) }))).toBe(false);
		expect(saveable(edit(m, { content: "x".repeat(MEMORY_CONTENT_MAX) }))).toBe(true);
		expect(saveable(edit(m, { content: "Changed.", importance: "2" }))).toBe(false);
		expect(saveable(edit(m, { content: "Changed.", importance: "" }))).toBe(false);
		// One that has none may be saved with none.
		const bare = item({ importance: null });
		expect(importanceValid(edit(bare, { importance: "" }))).toBe(true);
		expect(saveable(edit(bare, { content: "Changed.", importance: "" }))).toBe(true);
	});

	test("is unsaved as typed: a stray zero in the importance field counts, so that Discard is offered", () => {
		const m = item();
		expect(dirty(draftOf(m))).toBe(false);
		expect(dirty(edit(m, { importance: "0.750" }))).toBe(true);
		expect(dirty(edit(m, { importance: " 0.75 " }))).toBe(false);
		expect(dirty(edit(m, { content: `${m.content} ` }))).toBe(true);
	});

	test("a memory that moved on since the edit began is known by the etag the edit began from", () => {
		const m = item();
		const mine = edit(m, { content: "My version." });
		expect(movedOn(mine, m)).toBe(false);
		const current = item({ etag: "newer", content: "omp's rewrite.", importance: 0.5 });
		expect(movedOn(mine, current)).toBe(true);
		// What is sent is still a change of what the edit began from, whatever was read since: a second save cannot carry the
		// old text of an importance-only edit, nor take the newer text for its own.
		expect(changeOf(mine)).toEqual({ content: "My version." });
		expect(changeOf(edit(m, { importance: "0.9" }))).toEqual({ importance: 0.9 });
	});

	test("kept over a memory that moved on: what was changed stays, what was not is what the memory holds now", () => {
		const m = item();
		const current = item({ etag: "newer", content: "omp's rewrite.", importance: 0.5 });
		const textOnly = rebase(edit(m, { content: "My version." }), current);
		expect(textOnly).toMatchObject({
			content: "My version.",
			importance: "0.5",
			base: { etag: "newer", content: "omp's rewrite." },
		});
		expect(changeOf(textOnly)).toEqual({ content: "My version." });
		const importanceOnly = rebase(edit(m, { importance: "0.9" }), current);
		expect(importanceOnly).toMatchObject({ content: "omp's rewrite.", importance: "0.9" });
		expect(changeOf(importanceOnly)).toEqual({ importance: 0.9 });
		expect(movedOn(textOnly, current)).toBe(false);
	});

	test("asks for the secret tick only for a text the edit typed, so an importance-only change of a memory that holds one does not", () => {
		const holds = item({ content: "The key is sk-abcdefghijklmnopqrstuvwxyz0123456789." });
		// The memory's own text is never asked about: the server asks about what is sent, and this sends no text.
		expect(secretTyped(draftOf(holds))).toBe(false);
		expect(secretTyped(edit(holds, { importance: "0.9" }))).toBe(false);
		// A text typed in is asked about, and so is a secret left in a text that was changed.
		expect(secretTyped(edit(item(), { content: "sk-abcdefghijklmnopqrstuvwxyz0123456789" }))).toBe(true);
		expect(secretTyped(edit(item(), { content: "A plain note." }))).toBe(false);
	});
});

describe("naming projects", () => {
	test("by their folder, and with the path too where two share a name", () => {
		const names = projectNames(
			[
				bank("a-1", "app", "/home/me/work/app"),
				bank("b-2", "app", "/home/me/play/app"),
				bank("c-3", "site", "/home/me/work/site"),
			],
			"/home/me",
		);
		expect(names.get("a-1")).toBe("app (~/work/app)");
		expect(names.get("b-2")).toBe("app (~/play/app)");
		expect(names.get("c-3")).toBe("site");
		// No folder known: the label alone, even when it is shared.
		expect(projectNames([bank("a-1", "app"), bank("b-2", "app")]).get("a-1")).toBe("app");
	});
});

/** `unit` repeated to exactly `MEMORY_CONTENT_MAX` characters (a memory's longest text), so a cost is measured on the worst one. */
const fill = (unit: string): string =>
	unit.repeat(Math.ceil(MEMORY_CONTENT_MAX / unit.length)).slice(0, MEMORY_CONTENT_MAX);

describe("a secret in a memory", () => {
	test("is recognised by its shape, and an ordinary sentence is not one", () => {
		for (const s of [
			"sk-abcdefghijklmnopqrstuvwxyz0123456789",
			"ghp_abcdefghijklmnopqrstuvwxyz0123456789",
			"AKIAABCDEFGHIJKLMNOP",
			"-----BEGIN RSA PRIVATE KEY-----",
			"xoxb-1234567890-abcdefghij",
			// A connection URL with a password is one, whatever its scheme (one of 32 characters at most, as a scheme is).
			"postgres://user:s3cr3t@db.example.test/app",
			"mongodb+srv://u:p@h/db",
			"redis://:pw@host:6379",
			"postgresql+psycopg2://u:pw@h/db",
		]) {
			expect(looksLikeSecret(`the key is ${s} ok`), s).toBe(true);
		}
		expect(looksLikeSecret("Run the sk-learn tests, then ask about ghp-style tokens.")).toBe(false);
		expect(looksLikeSecret("The AKIA prefix is Amazon's.")).toBe(false);
		// A URL with no password is not one, and neither is a scheme of more than 32 characters (which is not a scheme).
		expect(looksLikeSecret("The docs are at https://example.test/guide and postgres://db.example.test/app.")).toBe(
			false,
		);
	});

	test("a long run of scheme-like characters is not quadratic: 64,000 characters are looked at in well under 50 ms", () => {
		// The scheme is the one part of the URL pattern that may run long; unbounded, a run of `a.a.` costs hundreds of ms.
		for (const [label, text] of [
			["a.a.", fill("a.a.")],
			["a-a-", fill("a-a-")],
			["a+a+", fill("a+a+")],
			["a.a.…:/", `${fill("a.a.")}://`],
		] as const) {
			const started = performance.now();
			const found = looksLikeSecret(text);
			const took = performance.now() - started;
			expect(found, label).toBe(false);
			expect(took, `${label} took ${took.toFixed(1)} ms`).toBeLessThan(50);
		}
	});
});

describe("the Memory page's words", () => {
	const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

	test("every string is in both languages, with the same parameters", () => {
		expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
		for (const key of Object.keys(en) as (keyof typeof en)[]) {
			expect(zh[key].trim(), key).not.toBe("");
			expect(placeholders(zh[key]), key).toEqual(placeholders(en[key]));
		}
	});

	test("the Chinese pack says 对话 for a conversation, never 会话, and 账号 never 账户", () => {
		const offenders = Object.entries(zh)
			.filter(([, text]) => text.includes("会话") || text.includes("账户"))
			.map(([key]) => key);
		expect(offenders).toEqual([]);
	});

	test("says that a deleted memory cannot be undone here and where the copy of the store is kept", () => {
		expect(en.deleteBody).toMatch(/cannot be undone/);
		expect(en.deleteBody).toContain("`memory-backups`");
		expect(zh.deleteBody).toContain("无法撤销");
		expect(zh.deleteBody).toContain("`memory-backups`");
	});
});
