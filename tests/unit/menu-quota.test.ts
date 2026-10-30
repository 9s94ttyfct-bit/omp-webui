import { expect, test } from "bun:test";
import { menuQuotaLines } from "../../server/menu-quota.ts";
import type { UsageLimit, UsageReport } from "../../shared/protocol.ts";

const NOW = new Date(2026, 9, 27, 10, 0).getTime();
const HOUR = 3_600_000;
const limit = (id: string, remaining: number, resetsAt?: number, scope?: UsageLimit["scope"]): UsageLimit => ({
	id,
	label: id,
	amount: { remainingFraction: remaining },
	window: resetsAt === undefined ? undefined : { resetsAt },
	scope,
});

test("each provider is one line: its window that runs out first, of its account with the most left", () => {
	const reports: UsageReport[] = [
		{ provider: "anthropic", limits: [limit("5h", 0.62, NOW + 4.5 * HOUR), limit("week", 0.9, NOW + 3 * 24 * HOUR)] },
		{ provider: "openai-codex", limits: [limit("5h", 0.1, NOW + HOUR)], metadata: { email: "a@x" } },
		{ provider: "openai-codex", limits: [limit("5h", 0.4, NOW + 2 * HOUR)], metadata: { email: "b@x" } },
	];
	expect(menuQuotaLines(reports, "en", NOW)).toEqual([
		"anthropic: 62% left · resets 14:30",
		"openai-codex: 40% left · resets 12:00",
	]);
	expect(menuQuotaLines(reports, "zh-CN", NOW)[0]).toBe("anthropic: 剩余 62% · 14:30 重置");
});

test("a window that caps one model family does not set the line, and a reset that is past or a day away is said so", () => {
	const reports: UsageReport[] = [
		{
			provider: "anthropic",
			limits: [limit("shared", 0.5, NOW - HOUR, { shared: true }), limit("opus", 0.01, NOW + HOUR, { tier: "opus" })],
		},
		{ provider: "zai", limits: [limit("week", 0.3, NOW + 2 * 24 * HOUR)] },
		{ provider: "none", limits: [{ id: "x", label: "x", amount: {} }] },
	];
	const [anthropic, zai, ...rest] = menuQuotaLines(reports, "en", NOW);
	expect(anthropic).toBe("anthropic: 50% left");
	expect(zai).toMatch(/^zai: 30% left · resets Thu 10:00$/);
	expect(rest).toEqual([]);
});
