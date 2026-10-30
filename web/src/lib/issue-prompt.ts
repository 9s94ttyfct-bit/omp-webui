import type { IssueDetail } from "@shared/github.ts";
import type { Translate } from "../i18n/index.ts";

/** The most of an issue a prompt carries: a long thread is cut, with the issue's address for the rest. */
export const ISSUE_PROMPT_MAX = 12_000;

/**
 * An issue as the text the Issues tab hands to the agent (#653): its number, title and address, state, labels and author,
 * the body, and the comments in order. Cut at `ISSUE_PROMPT_MAX` characters, at a line, with a note naming the address.
 */
export function issuePrompt(issue: IssueDetail, t: Translate): string {
	const head = [
		t("issues.promptIntro", { number: issue.number, title: issue.title }),
		issue.url,
		t("issues.promptState", { state: issue.state === "open" ? t("issues.stateOpen") : t("issues.stateClosed") }),
		...(issue.labels.length ? [t("issues.promptLabels", { labels: issue.labels.map((l) => l.name).join(", ") })] : []),
		...(issue.author ? [t("issues.promptAuthor", { author: issue.author })] : []),
	].join("\n");
	const parts = [head];
	if (issue.body.trim()) parts.push(issue.body.trim());
	if (issue.comments.length) {
		parts.push(
			[
				t("issues.promptComments"),
				...issue.comments.map((c) =>
					[`— ${c.author ?? "?"}${c.createdAt ? ` (${c.createdAt.slice(0, 10)})` : ""}:`, c.body.trim()].join("\n"),
				),
			].join("\n\n"),
		);
	}
	const text = parts.join("\n\n");
	if (text.length <= ISSUE_PROMPT_MAX) return text;
	const note = t("issues.promptCut", { url: issue.url });
	const room = ISSUE_PROMPT_MAX - note.length - 2;
	const cut = text.slice(0, room);
	const line = cut.lastIndexOf("\n");
	return `${line > room / 2 ? cut.slice(0, line) : cut}\n\n${note}`;
}
