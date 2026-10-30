import { expect, test } from "bun:test";
import {
	isCommand,
	loadedCommands,
	loadedSlash,
	slashName,
	unknownSlash,
	WEB_EQUIVALENTS,
} from "../../web/src/lib/slash.ts";
import type { SlashCommand } from "../../web/src/store/live.ts";

/**
 * omp sends a `/name` it does not know to the model as an ordinary message, which costs a turn. The composer
 * holds such a message back; what counts as unknown is decided by the live process's own command catalog.
 */

const cmd = (name: string, aliases?: string[]): SlashCommand => ({ name, source: "builtin", aliases });
const catalog = [cmd("context"), cmd("model", ["models"]), cmd("force", ["force:"]), cmd("skill:review"), cmd("retry")];

test("a command of the catalog is known by its name or an alias, whatever the case", () => {
	expect(unknownSlash("/context", catalog)).toBeNull();
	expect(unknownSlash("/models", catalog)).toBeNull();
	expect(unknownSlash("/Context now", catalog)).toBeNull();
	expect(unknownSlash("/skill:review the diff", catalog)).toBeNull();
});

test("a prefix omp dispatches on before the colon is known (/force:read)", () => {
	expect(unknownSlash("/force:read fix it", catalog)).toBeNull();
	expect(unknownSlash("/skill:other", catalog)).toBe("skill:other");
});

test("a name the catalog lacks is reported without the slash", () => {
	expect(unknownSlash("/clear", catalog)).toBe("clear");
	expect(unknownSlash("/tree show me", catalog)).toBe("tree");
	expect(unknownSlash("/clear\nand more lines", catalog)).toBe("clear");
});

test("text that only starts with a slash is not a command", () => {
	for (const text of [
		"/Users/me/project/src/main.ts is broken",
		"/ 5 is the divisor",
		"/5 of them",
		"hello /clear",
		"/",
	]) {
		expect(slashName(text), text).toBeNull();
		expect(unknownSlash(text, catalog), text).toBeNull();
	}
});

test("without a catalog only the names that are terminal-only are held back", () => {
	expect(unknownSlash("/clear", [])).toBe("clear");
	expect(unknownSlash("/new", [])).toBe("new");
	expect(unknownSlash("/context", [])).toBeNull();
	expect(unknownSlash("/some-prompt-template", [])).toBeNull();
});

test("the terminal-only commands that have a web counterpart name it", () => {
	for (const name of ["new", "clear", "resume", "tree", "branch", "settings", "hotkeys"]) {
		expect(WEB_EQUIVALENTS[name], name).toBeDefined();
	}
	expect(WEB_EQUIVALENTS.context).toBeUndefined();
});

test("/status, /extensions and /skills ask for the Loaded dialog, unless omp's own catalog has a command of that name", () => {
	for (const text of ["/status", "/extensions", "/skills", "/Status", "/skills now", "/status\nmore"])
		expect(loadedSlash(text, catalog), text).toBe(true);
	// Before the catalog has loaded they are still those commands.
	expect(loadedSlash("/skills", [])).toBe(true);
	// A future omp that runs one of them over RPC gets the line.
	expect(loadedSlash("/status", [...catalog, cmd("status")])).toBe(false);
	expect(loadedSlash("/extensions", [...catalog, cmd("ext", ["extensions"])])).toBe(false);
	// Neighbours are not them: a skill command, a longer name, text that is not a command.
	for (const text of ["/skill:review", "/statuses", "/context", "status", "/ status", "check /status"])
		expect(loadedSlash(text, catalog), text).toBe(false);
});

test("the Loaded commands are suggested with the catalog's, except the ones it has", () => {
	expect(loadedCommands(catalog, "Show it").map((c) => c.name)).toEqual(["status", "extensions", "skills"]);
	expect(loadedCommands(catalog, "Show it")[0]).toMatchObject({ description: "Show it" });
	expect(loadedCommands([...catalog, cmd("status")], "Show it").map((c) => c.name)).toEqual(["extensions", "skills"]);
});

test("without a conversation to show it for, the new-chat page holds them back and says where the dialog is", () => {
	expect(unknownSlash("/status", [])).toBe("status");
	expect(WEB_EQUIVALENTS.skills?.hint).toBe("loaded.slashHint");
});

test("a command omp runs at once is told from a message that only looks like one", () => {
	// A command of the catalog: omp runs it itself.
	expect(isCommand("/context now", false, catalog)).toBe(true);
	expect(isCommand("/models", false, catalog)).toBe(true);
	// A path, a sentence, a lone slash: the model gets it as text.
	for (const text of [
		"/Users/me/project/src/main.ts is broken",
		"/ 5 is the divisor",
		"/5 of them",
		"hello /clear",
		"/",
	])
		expect(isCommand(text, false, catalog), text).toBe(false);
	// A name omp does not know is a message too (the composer holds it back, and it can be sent anyway).
	expect(isCommand("/clear", false, catalog)).toBe(false);
	// Without a catalog nothing says it is a message, so it is left to omp.
	expect(isCommand("/nonsense", false, [])).toBe(true);
	// Text with images is a message: the composer reads no command out of it.
	expect(isCommand("/context now", true, catalog)).toBe(false);
});
