import { expect, test } from "bun:test";
import { checkboxDialog, picked, tickedIn } from "../../web/src/lib/ask-checks.ts";

/** omp's checkbox loop over RPC: the same `select` again after each pick, its count in the title, "Done selecting" last. */
const OPTIONS = ["Network", "Disk", "Other (type your own)", "✔ Done selecting"];

test("a checkbox loop is told from an ordinary choice, with its question and count", () => {
	expect(checkboxDialog("Show what", OPTIONS)).toEqual({ question: "Show what", count: 0, done: "✔ Done selecting" });
	expect(checkboxDialog("(2 selected) Show what", OPTIONS)).toMatchObject({ question: "Show what", count: 2 });
	expect(checkboxDialog("Pick one", ["A", "B"])).toBeNull();
	expect(checkboxDialog(undefined, OPTIONS)).toBeNull();
});

test("each pick ticks or unticks its option, as omp does, and Done ends the question", () => {
	const scope = "live-1\u0000<form>";
	const ask = (title: string) => {
		const dialog = checkboxDialog(title, OPTIONS);
		if (!dialog) throw new Error("not a checkbox loop");
		return dialog;
	};
	expect([...(tickedIn(scope, ask("Show what"), OPTIONS, null) ?? [])]).toEqual([]);
	picked(scope, ask("Show what"), "Network");
	expect([...(tickedIn(scope, ask("(1 selected) Show what"), OPTIONS, null) ?? [])]).toEqual(["Network"]);
	picked(scope, ask("(1 selected) Show what"), "Disk");
	expect([...(tickedIn(scope, ask("(2 selected) Show what"), OPTIONS, null) ?? [])].sort()).toEqual([
		"Disk",
		"Network",
	]);
	picked(scope, ask("(2 selected) Show what"), "Network");
	expect([...(tickedIn(scope, ask("(1 selected) Show what"), OPTIONS, null) ?? [])]).toEqual(["Disk"]);
	// An "Other" whose text was left empty: omp does not count it, and neither does the page.
	picked(scope, ask("(1 selected) Show what"), "Other (type your own)");
	expect([...(tickedIn(scope, ask("(1 selected) Show what"), OPTIONS, null) ?? [])]).toEqual(["Disk"]);
	picked(scope, ask("(1 selected) Show what"), "✔ Done selecting");
	// The question asked again later starts from nothing the page remembers.
	expect([...(tickedIn(scope, ask("Show what"), OPTIONS, null) ?? [])]).toEqual([]);
});

test("ticks that do not add up to omp's count are not shown", () => {
	const scope = "live-2\u0000<form>";
	const dialog = checkboxDialog("(2 selected) Show what", OPTIONS);
	if (!dialog) throw new Error("not a checkbox loop");
	// A page that opened in the middle of the questions knows nothing of the picks before it.
	expect(tickedIn(scope, dialog, OPTIONS, null)).toBeNull();
});
