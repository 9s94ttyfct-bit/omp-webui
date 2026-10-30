import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { chain, eager, ROOT, WEB } from "../support/entry-graph.ts";

/**
 * The modules the first page load fetches are the ones `web/src/main.tsx` imports statically, and so on down (see
 * `tests/support/entry-graph.ts`). The history of a conversation (`lib/history.ts`, its store, the hand-scroll and
 * entry-anchor helpers) is what the conversation view uses, which is lazy; one eager module that imports a function of
 * it pulls all of it into the first load (and the first load has a budget, `scripts/check-entry-size.ts`).
 */

test("the history of a conversation is not part of the first page load", () => {
	const reached = eager();
	// Sanity: the walk reaches the app, and does not follow what is loaded later.
	expect(reached.has(join(WEB, "App.tsx"))).toBe(true);
	expect(reached.has(join(WEB, "components", "ChatView.tsx"))).toBe(false);
	for (const lazy of ["lib/history.ts", "store/history.ts", "lib/hand-scroll.ts", "lib/entry-anchor.ts"]) {
		const file = join(WEB, ...lazy.split("/"));
		expect(existsSync(file)).toBe(true);
		expect(reached.has(file) ? chain(reached, file) : null).toBeNull();
	}
});

test("dropped files (#617) load with the composer's drop, not with the first page", () => {
	const reached = eager();
	// The drafts mirror checks the shape of attached files itself, and the composer takes the files of a drop with a few
	// lines of its own (`lib/drop-items.ts`): both are eager. What decides what to do with them is not.
	expect(reached.has(join(WEB, "lib", "drafts.ts"))).toBe(true);
	expect(reached.has(join(WEB, "lib", "drop-items.ts"))).toBe(true);
	const lazy = [
		["shared", "attachment.ts"],
		["shared", "upload.ts"],
		["web", "src", "lib", "drop-flow.ts"],
		["web", "src", "lib", "drop-run.ts"],
		["web", "src", "lib", "shell-drop.ts"],
		// The picture helpers (shrinking, limits) are the choice's: the composer counts nothing of them.
		["web", "src", "lib", "images.ts"],
		["web", "src", "components", "DropChoice.tsx"],
		["web", "src", "components", "DropSettings.tsx"],
		["web", "src", "lib", "drop-prefs.ts"],
		["web", "src", "lib", "drop-strings.ts"],
		["web", "src", "lib", "upload.ts"],
		// The conversation's message rows show attached files as chips (`splitMessage`).
		["web", "src", "components", "Message.tsx"],
	];
	for (const parts of lazy) {
		const file = join(ROOT, ...parts);
		expect(existsSync(file)).toBe(true);
		expect(reached.has(file) ? chain(reached, file) : null).toBeNull();
	}
});

/**
 * A file, or a change, opened large in the main area (#635) is the Files tab's own code: the store it is kept in is what
 * the panel and `ChatView` read (both chunks of their own), and the view itself loads only when something is opened large.
 */
test("the large view of a file or a change is not part of the first page load", () => {
	const reached = eager();
	expect(reached.has(join(WEB, "components", "ChatView.tsx"))).toBe(false);
	for (const lazy of [
		["components", "BigView.tsx"],
		["components", "files", "FileBody.tsx"],
		["components", "changes", "use-diff.ts"],
		["store", "big.ts"],
	]) {
		const file = join(WEB, ...lazy);
		expect(existsSync(file)).toBe(true);
		expect(reached.has(file) ? chain(reached, file) : null).toBeNull();
	}
});

/**
 * The New chat view's request cards and footer pickers load as chunks of their own (`NewChat.tsx` starts them when the
 * warm-up starts): the pickers pull the model search, the preset dialogs and the approval menu with them.
 */
test("the New chat pickers and request cards are not part of the first page load", () => {
	const reached = eager();
	expect(reached.has(join(WEB, "components", "NewChat.tsx"))).toBe(true);
	for (const lazy of [
		"UIRequests",
		"NewChatPickers",
		"PresetPicker",
		"PresetDialogs",
		"ModelPicker",
		"ModelSearch",
		"ApprovalPicker",
		"SessionGuard",
	]) {
		const file = join(WEB, "components", `${lazy}.tsx`);
		expect(existsSync(file)).toBe(true);
		expect(reached.has(file) ? chain(reached, file) : null).toBeNull();
	}
});

/** The Host load chip is a loader in the first load: the indicator, the pane, the tab and the stores load when it is shown or asked for. */
test("the Host load page is not part of the first page load", () => {
	const reached = eager();
	expect(reached.has(join(WEB, "components", "HostChip.tsx"))).toBe(true);
	for (const lazy of [
		["components", "HostIndicator.tsx"],
		["components", "HostPane.tsx"],
		["components", "HostTab.tsx"],
		["lib", "host-rows.ts"],
		["lib", "host-store.ts"],
		["lib", "host-strings.ts"],
		["lib", "host-watch.ts"],
	]) {
		const file = join(WEB, ...lazy);
		expect(existsSync(file)).toBe(true);
		expect(reached.has(file) ? chain(reached, file) : null).toBeNull();
	}
});

/**
 * The machine switcher (#628) is a row a computer with a saved Mac shows under the New chat button: `MachineChip` is the
 * first load's part of it (the sidebar renders it; it reads `meta.macs` and loads the rest), and the menu, the dialog that adds a
 * Mac, the page's side of the app's bridge and its strings are chunks of their own. The export and import of the remote
 * settings is a part of that card, which is lazy.
 */
test("the machine switcher, its dialog, its bridge and its strings are not part of the first page load", () => {
	const reached = eager();
	expect(reached.has(join(WEB, "components", "MachineChip.tsx"))).toBe(true);
	for (const lazy of [
		["web", "src", "components", "MachineSwitcher.tsx"],
		["web", "src", "components", "MacAddDialog.tsx"],
		["web", "src", "components", "RemoteTransfer.tsx"],
		["web", "src", "lib", "macs.ts"],
		["web", "src", "lib", "macs-strings.ts"],
		["web", "src", "i18n", "macs.ts"],
		["shared", "remote-transfer.ts"],
	]) {
		const file = join(ROOT, ...lazy);
		expect(existsSync(file)).toBe(true);
		expect(reached.has(file) ? chain(reached, file) : null).toBeNull();
	}
});
