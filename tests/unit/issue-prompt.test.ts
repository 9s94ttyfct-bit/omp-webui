import { expect, test } from "bun:test";
import type { IssueDetail } from "../../shared/github.ts";
import type { Translate } from "../../web/src/i18n/index.ts";
import { ISSUE_PROMPT_MAX, issuePrompt } from "../../web/src/lib/issue-prompt.ts";

/** The text an issue becomes when it is handed to the agent (#653): what it carries, and where a long one is cut. */

const t: Translate = (key, vars) => `${key}${vars ? ` ${JSON.stringify(vars)}` : ""}`;

const ISSUE: IssueDetail = {
	number: 7,
	title: "Crash on start",
	state: "open",
	labels: [{ name: "bug" }],
	author: "ana",
	assignees: [],
	createdAt: "2026-10-01T10:00:00Z",
	updatedAt: "2026-10-01T10:00:00Z",
	url: "https://github.com/o/r/issues/7",
	body: "It crashes.",
	comments: [{ author: "bo", body: "Same here", createdAt: "2026-10-03T00:00:00Z" }],
};

test("an issue carries its number, title, address, labels, author, body and comments in order", () => {
	const text = issuePrompt(ISSUE, t);
	const order = [
		"issues.promptIntro",
		ISSUE.url,
		"issues.promptLabels",
		"It crashes.",
		"— bo (2026-10-03):",
		"Same here",
	];
	const at = order.map((s) => text.indexOf(s));
	expect(at.every((i) => i >= 0)).toBe(true);
	expect([...at].sort((a, b) => a - b)).toEqual(at);
	expect(text).not.toContain("issues.promptCut");
});

test("a long issue is cut at a line, within the bound, with the address for the rest", () => {
	const line = "x".repeat(99);
	const body = Array.from({ length: 400 }, () => line).join("\n");
	const text = issuePrompt({ ...ISSUE, body }, t);
	expect(text.length).toBeLessThanOrEqual(ISSUE_PROMPT_MAX);
	expect(text.endsWith(`issues.promptCut ${JSON.stringify({ url: ISSUE.url })}`)).toBe(true);
	// Cut at a line: no partial line of x before the note.
	const kept = text.slice(0, text.lastIndexOf("\n\nissues.promptCut")).split("\n");
	expect(kept.at(-1)).toBe(line);
});
