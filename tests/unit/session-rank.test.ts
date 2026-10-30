import { describe, expect, test } from "bun:test";
import type { SessionSummary } from "../../shared/protocol.ts";
import {
	contentMatches,
	pageOf,
	rangeStart,
	rankSessions,
	type SessionFilters,
} from "../../web/src/lib/session-search.ts";

/**
 * The sidebar's search: what the filter field keeps, in what order, and what the project, date and archive filters do
 * with it. The conversations are built here rather than read from a server: this is about the ranking.
 */

const NOW = Date.parse("2026-10-25T12:00:00");

/** A conversation with only what the list reads (the rest of the summary is not used here). */
function session(
	i: number,
	o: Partial<SessionSummary> & {
		title?: string | null;
		preview?: string;
		project?: string;
		cwd?: string;
		daysAgo?: number;
	} = {},
): SessionSummary {
	const ago = o.daysAgo ?? 0;
	return {
		file: `/s/${i}.jsonl`,
		id: `id-${i}`,
		title: o.title === undefined ? `Session ${i}` : o.title,
		preview: o.preview ?? `preview ${i}`,
		cwd: o.cwd ?? `/work/${o.project ?? "alpha"}`,
		project: o.project ?? "alpha",
		createdAt: new Date(NOW - ago * 86_400_000).toISOString(),
		modifiedAt: NOW - ago * 86_400_000,
		size: 100,
		messageCount: 2,
		userMessageCount: 1,
		parentSession: null,
		models: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
		subagentUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
		subagentCount: 0,
		advisorUsage: { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 },
	} as unknown as SessionSummary;
}

const filters = (o: Partial<SessionFilters> = {}): SessionFilters => ({
	query: "",
	project: "all",
	range: "all",
	archived: false,
	...o,
});

const titles = (list: { session: SessionSummary }[]) => list.map((r) => r.session.title);

describe("what the filter field keeps", () => {
	test("an empty query keeps everything, in the order it came in", () => {
		const all = [session(1), session(2), session(3)];
		expect(titles(rankSessions(all, filters(), NOW))).toEqual(["Session 1", "Session 2", "Session 3"]);
	});

	test("the title is matched by subsequence, a word's start ranking higher", () => {
		const all = [
			session(1, { title: "Refactor the parser" }),
			session(2, { title: "Parser refactor notes" }),
			session(3, { title: "Something else entirely" }),
		];
		expect(titles(rankSessions(all, filters({ query: "ref par" }), NOW))).toEqual([
			"Refactor the parser",
			"Parser refactor notes",
		]);
	});

	test("the first prompt is matched when the conversation has no title", () => {
		const all = [session(1, { title: null, preview: "why does the build fail" }), session(2, { title: "Unrelated" })];
		expect(titles(rankSessions(all, filters({ query: "build" }), NOW))).toEqual([null]);
	});

	test("a project's name matches too, but a title that matches ranks above it", () => {
		const all = [
			session(1, { title: "Unrelated", project: "omp-webui", cwd: "/work/omp-webui" }),
			session(2, { title: "omp-webui search", project: "other", cwd: "/work/other" }),
		];
		expect(titles(rankSessions(all, filters({ query: "omp-webui" }), NOW))).toEqual(["omp-webui search", "Unrelated"]);
		// Only a title's characters are marked: a project has no place in the row's name.
		const [, byProject] = rankSessions(all, filters({ query: "ompwebui" }), NOW);
		expect(byProject?.positions).toEqual([]);
	});

	test("equal matches come newest first", () => {
		const all = [
			session(1, { title: "Deploy check", daysAgo: 5 }),
			session(2, { title: "Deploy check", daysAgo: 1 }),
			session(3, { title: "Deploy check", daysAgo: 3 }),
		];
		expect(rankSessions(all, filters({ query: "deploy" }), NOW).map((r) => r.session.id)).toEqual([
			"id-2",
			"id-3",
			"id-1",
		]);
	});

	test("a better match beats a newer one", () => {
		const all = [session(1, { title: "Notes on deploy", daysAgo: 0 }), session(2, { title: "Deploy", daysAgo: 30 })];
		expect(titles(rankSessions(all, filters({ query: "deploy" }), NOW))).toEqual(["Deploy", "Notes on deploy"]);
	});

	test("case and Chinese are matched as the scorer matches them", () => {
		const all = [session(1, { title: "DEPLOY Script" }), session(2, { title: "部署脚本" })];
		expect(titles(rankSessions(all, filters({ query: "deploy" }), NOW))).toEqual(["DEPLOY Script"]);
		expect(titles(rankSessions(all, filters({ query: "部署" }), NOW))).toEqual(["部署脚本"]);
	});

	test("the marks are where the query matched the title", () => {
		const [found] = rankSessions([session(1, { title: "Release the deploy" })], filters({ query: "deploy" }), NOW);
		const title = "Release the deploy";
		expect((found?.positions ?? []).map((i) => title[i]).join("")).toBe("deploy");
	});

	test("a title that contains the query as typed is marked there, in one run, and comes before scattered letters", () => {
		const all = [session(1, { title: "Draft the review" }), session(2, { title: "Migrate the rate limiter" })];
		const found = rankSessions(all, filters({ query: "rate" }), NOW);
		expect(titles(found)).toEqual(["Migrate the rate limiter", "Draft the review"]);
		const title = "Migrate the rate limiter";
		// The word "rate", not the end of "Migrate".
		expect(found[0]?.positions).toEqual([12, 13, 14, 15]);
		expect(found[0]?.positions.map((i) => title[i]).join("")).toBe("rate");
		// The title that has only the letters, spread out, is listed after it and carries no marks.
		expect(found[1]?.positions).toEqual([]);
	});

	test("a name with only the letters in order is listed and not marked: scattered letters read as noise (N1)", () => {
		const all = [
			session(1, { title: "Draft the changelog for 2.4" }),
			session(2, { title: "Rate limit across servers" }),
		];
		const found = rankSessions(all, filters({ query: "rate" }), NOW);
		expect(titles(found)).toEqual(["Rate limit across servers", "Draft the changelog for 2.4"]);
		expect(found[0]?.positions).toEqual([0, 1, 2, 3]);
		expect(found[1]?.positions).toEqual([]);
		// The same for an abbreviation: "mgrt" finds "Migrate the settings page" and marks nothing in it.
		const abbreviated = rankSessions(
			[session(3, { title: "Migrate the settings page" })],
			filters({ query: "mgrt" }),
			NOW,
		);
		expect(titles(abbreviated)).toEqual(["Migrate the settings page"]);
		expect(abbreviated[0]?.positions).toEqual([]);
	});

	test("of a query of several words, the words that stand as typed are marked, the others are not", () => {
		const title = "Refactor the parser";
		const [both] = rankSessions([session(1, { title })], filters({ query: "ref par" }), NOW);
		expect((both?.positions ?? []).map((i) => title[i]).join("")).toBe("Refpar");
		// "tsr" is only in order (the t of "the", the s and the r of "parser"): not marked, while "ref" is.
		const [partly] = rankSessions([session(2, { title })], filters({ query: "ref tsr" }), NOW);
		expect((partly?.positions ?? []).map((i) => title[i]).join("")).toBe("Ref");
	});
});

describe("the project, the date range and the archive", () => {
	test("the project filter keeps its folder only", () => {
		const all = [
			session(1, { project: "alpha", cwd: "/work/alpha" }),
			session(2, { project: "beta", cwd: "/work/beta" }),
		];
		expect(titles(rankSessions(all, filters({ project: "/work/beta" }), NOW))).toEqual(["Session 2"]);
	});

	test("today starts at local midnight, and the week and month count back from now", () => {
		const midnight = new Date(NOW);
		midnight.setHours(0, 0, 0, 0);
		expect(rangeStart("today", NOW)).toBe(midnight.getTime());
		expect(rangeStart("week", NOW)).toBe(NOW - 7 * 86_400_000);
		expect(rangeStart("month", NOW)).toBe(NOW - 30 * 86_400_000);
		expect(rangeStart("all", NOW)).toBeNull();
	});

	test("a range keeps the conversations changed since it began, and `all` keeps every one", () => {
		const all = [
			session(1, { daysAgo: 0 }),
			session(2, { daysAgo: 3 }),
			session(3, { daysAgo: 20 }),
			session(4, { daysAgo: 90 }),
		];
		expect(titles(rankSessions(all, filters({ range: "today" }), NOW))).toEqual(["Session 1"]);
		expect(titles(rankSessions(all, filters({ range: "week" }), NOW))).toEqual(["Session 1", "Session 2"]);
		expect(titles(rankSessions(all, filters({ range: "month" }), NOW))).toEqual([
			"Session 1",
			"Session 2",
			"Session 3",
		]);
		expect(titles(rankSessions(all, filters({ range: "all" }), NOW))).toHaveLength(4);
	});

	test("the range and the query are one filter: a match outside it is not listed", () => {
		const all = [session(1, { title: "Deploy", daysAgo: 20 }), session(2, { title: "Deploy", daysAgo: 1 })];
		expect(titles(rankSessions(all, filters({ query: "deploy", range: "week" }), NOW))).toEqual(["Deploy"]);
	});

	test("the archive filter is the caller's: the ranking does not read the archive itself", () => {
		// Which conversations are archived is the sidebar's set, not the summary's; the ranking is given what to list.
		const all = [session(1), session(2)];
		expect(titles(rankSessions(all, filters({ archived: true }), NOW))).toHaveLength(2);
	});
});

describe("content matches (#717)", () => {
	const hit = (i: number, entryId = `e${i}`) => ({ file: `/s/${i}.jsonl`, entryId, snippet: `line ${i}` });

	test("only conversations the filters keep, none listed by name, once each, in the server's order", () => {
		const scope = [session(1), session(2), session(3)];
		const { sessions, hits } = contentMatches(
			[hit(3), hit(9), hit(1), hit(2), hit(3, "later")],
			scope,
			new Set(["/s/1.jsonl"]),
		);
		expect(sessions.map((s) => s.file)).toEqual(["/s/3.jsonl", "/s/2.jsonl"]);
		expect(hits.get("/s/3.jsonl")?.entryId).toBe("e3");
	});

	test("a page asked one past its size says whether there are more", () => {
		expect(pageOf([1, 2, 3], 3)).toEqual({ hits: [1, 2, 3], more: false });
		expect(pageOf([1, 2, 3, 4], 3)).toEqual({ hits: [1, 2, 3], more: true });
		expect(pageOf([1], 3)).toEqual({ hits: [1], more: false });
	});
});
