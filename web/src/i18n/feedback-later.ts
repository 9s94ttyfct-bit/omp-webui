/**
 * Strings for the Feedback dialog and the GitHub star prompt.
 *
 * The strings only code outside the first page load asks for, which `later.ts` registers: a module that uses one
 * imports `later.ts` (`tests/unit/i18n-first-load.test.ts`). The ones the first page asks for are in `feedback.ts`.
 */
export const en = {
	helpPrompt: "Something broken or missing?",
	title: "Send feedback",
	intro:
		"Tell us what went wrong, or what you would like. This opens a prefilled issue on GitHub; nothing is sent until you submit it there (a GitHub account is needed).",
	kind: "What kind of feedback is it?",
	kindBug: "Something is broken",
	kindFeature: "I'd like a feature",
	summary: "Short summary",
	summaryBugHint: "e.g. The sidebar loses my selection after archiving",
	summaryFeatureHint: "e.g. Export a conversation as PDF",
	required: "required",
	optional: "optional",
	happened: "What happened?",
	happenedHint: "Describe what you saw.",
	steps: "Steps to reproduce",
	stepsHint: "1. Open … 2. Click … 3. …",
	expected: "What did you expect?",
	actual: "What happened instead?",
	problem: "What problem are you trying to solve?",
	problemHint: "What are you doing, and what gets in the way?",
	solution: "What would you like to see?",
	solutionHint: "How could it work? Alternatives you considered are welcome.",
	cleaned:
		"Tokens, keys (private keys included), passwords, cookies, webhook links, the sign-in part of links and commands, e-mail addresses, your user name and your home folder are removed from everything you write here.",
	diagnostics: "Attach diagnostics",
	diagnosticsHint:
		"Versions of this web UI and omp, your operating system, the mode and your browser. No conversations, paths or credentials.",
	preview: "Preview",
	back: "Back",
	previewIntro: "This is what will be in the GitHub issue. You can still edit it there.",
	previewTitle: "Title",
	previewLabels: "Labels",
	previewBody: "Description",
	truncatedDiagnostics: "The link would have been too long, so the diagnostics were cut.",
	truncatedText:
		"The text is too long for a link and will be cut there. Open on GitHub copies the full text to your clipboard first: paste it into the issue.",
	open: "Open on GitHub",
	copy: "Copy text",
	copied: "Copied",
	copyFailed: "Could not copy",
	navFeedback: "Send feedback",
	settingsSendHint:
		"Report something broken or ask for a feature. This opens a prefilled issue on GitHub; nothing is sent until you submit it there.",
	settingsTitle: "Feedback",
	settingsStar: "Offer to ask for a GitHub star",
	settingsStarHint:
		"After several days of use the sidebar may ask once for a star, only while the repository is public. Turn this off and the app neither asks nor looks up the repository on GitHub.",
};
