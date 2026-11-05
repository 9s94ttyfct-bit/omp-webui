import { expect, test } from "bun:test";
import { commandLine, splitArgs } from "../../web/src/lib/cli-args.ts";

/** The CLI page's command line: the arguments it shows are the arguments Run runs. */

test("a command line shown for arguments splits back into the same arguments", () => {
	for (const args of [
		["commit", "-m", "it's done"],
		["say", 'a "quoted" word'],
		["both", `it's "this"`],
		["path", "C:\\Users\\someone\\x y"],
		["empty", ""],
		["tab\there", "new\nline", "'", '"', "\\"],
		["plain", "--flag=value"],
	])
		expect(splitArgs(commandLine(args))).toEqual(args);
});

test("plain arguments are shown as they are, and only those that need it are quoted", () => {
	expect(commandLine(["status", "--short"])).toBe("status --short");
	expect(commandLine(["commit", "-m", "two words"])).toBe("commit -m 'two words'");
	// A Windows path is no special case: its backslashes are ordinary characters.
	expect(commandLine(["--resume", "C:\\Users\\someone\\x.jsonl"])).toBe("--resume C:\\Users\\someone\\x.jsonl");
});

test("a typed line keeps its backslashes, and quoted parts next to each other make one argument", () => {
	expect(splitArgs("--resume C:\\Users\\someone\\x.jsonl")).toEqual(["--resume", "C:\\Users\\someone\\x.jsonl"]);
	expect(splitArgs(`'it'"'"'s' "a b" h''i ""`)).toEqual(["it's", "a b", "hi", ""]);
	expect(splitArgs("  one   two\tthree ")).toEqual(["one", "two", "three"]);
});
