import { expect, test } from "bun:test";
import { RepoVisibility } from "../../server/feedback.ts";
import {
	answerStarPrompt,
	dayKey,
	type KeyValueStorage,
	recordUsageDay,
	STAR_AFTER_DAYS,
	STAR_LOOKUP_RETRY_MS,
	STAR_SNOOZE_MS,
	setStarPromptEnabled,
	showStarPrompt,
	starLookupWanted,
	starPromptDue,
	starPromptEnabled,
	usageDays,
} from "../../web/src/lib/usage-days.ts";

/** The star prompt: sustained use, never on a private repository, and "don't ask again" is for good. */

function memory(): KeyValueStorage {
	const m = new Map<string, string>();
	return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
}

const DAY = 24 * 60 * 60 * 1000;
/** Noon, local time, so a day's key never depends on the machine's time zone. */
const noon = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12).getTime();
const day1 = noon(2026, 10, 1);

function useOnDays(storage: KeyValueStorage, days: number, from = day1): number {
	let at = from;
	for (let i = 0; i < days; i++) {
		recordUsageDay(storage, at);
		at += DAY;
	}
	return at - DAY;
}

test("a day counts once however many messages it had", () => {
	const s = memory();
	expect(recordUsageDay(s, day1)).toBe(true);
	expect(recordUsageDay(s, day1 + 3 * 60 * 60 * 1000)).toBe(false);
	expect(usageDays(s)).toEqual([dayKey(day1)]);
	expect(dayKey(day1)).toBe("2026-10-01");
});

test("the prompt waits for enough days with a message, on a public repository only", () => {
	const s = memory();
	const last = useOnDays(s, STAR_AFTER_DAYS - 1);
	expect(showStarPrompt(s, last, true)).toBe(false);
	recordUsageDay(s, last + DAY);
	const now = last + DAY;
	expect(showStarPrompt(s, now, true)).toBe(true);
	// A private repository has nothing to star: never, however long it has been used.
	expect(showStarPrompt(s, now, false)).toBe(false);
	useOnDays(s, 40, day1 + 100 * DAY);
	expect(showStarPrompt(s, now + 200 * DAY, false)).toBe(false);
});

test("days without a message do not count, and gaps between days are fine", () => {
	const s = memory();
	for (const d of [1, 9, 17, 25, 33]) recordUsageDay(s, day1 + d * DAY);
	expect(usageDays(s)).toHaveLength(5);
	expect(showStarPrompt(s, day1 + 40 * DAY, true)).toBe(true);
});

test("'not now' hides the prompt for a while; 'don't ask again' for good", () => {
	const s = memory();
	const now = useOnDays(s, STAR_AFTER_DAYS);
	expect(showStarPrompt(s, now, true)).toBe(true);
	answerStarPrompt(s, { until: now + STAR_SNOOZE_MS });
	expect(showStarPrompt(s, now, true)).toBe(false);
	expect(showStarPrompt(s, now + STAR_SNOOZE_MS - 1, true)).toBe(false);
	expect(showStarPrompt(s, now + STAR_SNOOZE_MS, true)).toBe(true);
	answerStarPrompt(s, { never: true });
	expect(showStarPrompt(s, now + 10 * STAR_SNOOZE_MS, true)).toBe(false);
	// More use does not bring it back.
	useOnDays(s, 20, now + 11 * STAR_SNOOZE_MS);
	expect(showStarPrompt(s, now + 12 * STAR_SNOOZE_MS, true)).toBe(false);
});

test("storage that holds something else is read as nothing, and a full one does not throw", () => {
	const s = memory();
	s.setItem("ompw.usageDays", '{"not":"a list"}');
	s.setItem("ompw.star", "garbage");
	expect(usageDays(s)).toEqual([]);
	s.setItem("ompw.usageDays", '["2026-10-01","yesterday",7,"2026-10-01","2026-09-30"]');
	expect(usageDays(s)).toEqual(["2026-09-30", "2026-10-01"]);
	const full: KeyValueStorage = {
		getItem: () => null,
		setItem: () => {
			throw new Error("QuotaExceededError");
		},
	};
	expect(recordUsageDay(full, day1)).toBe(false);
	expect(() => answerStarPrompt(full, { never: true })).not.toThrow();
});

test("only the last two months of days are kept", () => {
	const s = memory();
	useOnDays(s, 90);
	const days = usageDays(s);
	expect(days).toHaveLength(60);
	expect(days.at(-1)).toBe(dayKey(day1 + 89 * DAY));
});

/** GitHub as an anonymous caller sees it. */
function github(reply: () => Response | Promise<Response>) {
	const calls: { url: string; headers: Headers }[] = [];
	const fetcher = (async (url: string, init?: RequestInit) => {
		calls.push({ url, headers: new Headers(init?.headers) });
		return reply();
	}) as unknown as typeof fetch;
	return { calls, fetcher };
}

test("a repository GitHub shows to anyone is public; one it hides is private", async () => {
	const open = github(() => Response.json({ private: false, visibility: "public" }));
	expect(await new RepoVisibility("https://gh.test", open.fetcher).isPublic()).toBe(true);
	expect(open.calls[0].url).toBe("https://gh.test/repos/9s94ttyfct-bit/omp-webui");
	// Anonymous: no credentials ride along.
	expect(open.calls[0].headers.has("authorization")).toBe(false);

	const hidden = github(() => new Response("Not Found", { status: 404 }));
	expect(await new RepoVisibility("https://gh.test", hidden.fetcher).isPublic()).toBe(false);
});

test('every failure is "could not tell", never public', async () => {
	for (const reply of [
		() => new Response("rate limited", { status: 403 }),
		() => new Response("oops", { status: 500 }),
		() => new Response("<html>", { status: 200 }),
		() => Response.json({ name: "omp-webui" }),
		() => Response.json({ private: "no" }),
		() => {
			throw new Error("offline");
		},
	]) {
		expect(await new RepoVisibility("https://gh.test", github(reply).fetcher).isPublic()).toBeNull();
	}
});

test("an answer is kept a day, a failure only an hour, and callers at the same time share one request", async () => {
	let now = 1_000_000;
	let status = 404;
	const g = github(() => (status === 404 ? new Response("", { status }) : Response.json({ private: false })));
	const repo = new RepoVisibility("https://gh.test", g.fetcher, () => now);
	const [a, b] = await Promise.all([repo.isPublic(), repo.isPublic()]);
	expect([a, b]).toEqual([false, false]);
	expect(g.calls).toHaveLength(1);

	// The repository goes public; the cached "private" holds for the day.
	status = 200;
	now += 23 * 60 * 60 * 1000;
	expect(await repo.isPublic()).toBe(false);
	expect(g.calls).toHaveLength(1);
	now += 2 * 60 * 60 * 1000;
	expect(await repo.isPublic()).toBe(true);
	expect(g.calls).toHaveLength(2);

	// An outage is retried within the hour instead of hiding the answer for a day.
	const down = github(() => new Response("", { status: 503 }));
	let t = 0;
	const flaky = new RepoVisibility("https://gh.test", down.fetcher, () => t);
	expect(await flaky.isPublic()).toBeNull();
	t += 30 * 60 * 1000;
	await flaky.isPublic();
	expect(down.calls).toHaveLength(1);
	t += 31 * 60 * 1000;
	await flaky.isPublic();
	expect(down.calls).toHaveLength(2);
});

test("a lookup that could not tell is made again after a day; a clear answer is not", () => {
	const at = day1;
	expect(starLookupWanted(null, at)).toBe(true);
	expect(starLookupWanted({ public: null, at }, at + STAR_LOOKUP_RETRY_MS - 1)).toBe(false);
	expect(starLookupWanted({ public: null, at }, at + STAR_LOOKUP_RETRY_MS)).toBe(true);
	expect(starLookupWanted({ public: false, at }, at + 10 * STAR_LOOKUP_RETRY_MS)).toBe(false);
	expect(starLookupWanted({ public: true, at }, at + 10 * STAR_LOOKUP_RETRY_MS)).toBe(false);
});

test("Settings can turn the prompt off, which is 'don't ask again', and back on", () => {
	const s = memory();
	const now = useOnDays(s, STAR_AFTER_DAYS);
	expect(starPromptEnabled(s)).toBe(true);
	setStarPromptEnabled(s, false);
	expect(starPromptEnabled(s)).toBe(false);
	// With the prompt off it is never due, so the page never asks the server to look the repository up.
	expect(starPromptDue(s, now + 100 * DAY)).toBe(false);
	expect(showStarPrompt(s, now + 100 * DAY, true)).toBe(false);
	setStarPromptEnabled(s, true);
	expect(starPromptEnabled(s)).toBe(true);
	expect(showStarPrompt(s, now, true)).toBe(true);
	// "Don't ask again" on the card shows as off in Settings; "Not now" is still on.
	answerStarPrompt(s, { never: true });
	expect(starPromptEnabled(s)).toBe(false);
	answerStarPrompt(s, { until: now + STAR_SNOOZE_MS });
	expect(starPromptEnabled(s)).toBe(true);
});
