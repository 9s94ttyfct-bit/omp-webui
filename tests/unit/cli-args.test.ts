import { expect, test } from "bun:test";
import { commandLine, splitArgs } from "../../web/src/lib/cli-args.ts";

/** The CLI page's command line: the arguments it shows are the arguments Run runs. */

test("a command line shown for arguments splits back into the same arguments", () => {
	for (const args of [
		["commit", "-m", "it's done"],
		["say", 'a "quoted" word'],
		["path", "C:\\Users\\someone\\x y"],
		["empty", ""],
		["tab\there", "new\nline", "'", "\\"],
		["plain", "--flag=value"],
	])
		expect(splitArgs(commandLine(args))).toEqual(args);
});

test("plain arguments are shown as they are, and only those that need it are quoted", () => {
	expect(commandLine(["status", "--short"])).toBe("status --short");
	expect(commandLine(["commit", "-m", "two words"])).toBe("commit -m 'two words'");
});

test("a typed line splits as a POSIX shell splits it", () => {
	expect(splitArgs(`a\\ b "c \\"d\\" \\\\e" 'f\\g' h''i ""`)).toEqual(["a b", 'c "d" \\e', "f\\g", "hi", ""]);
	expect(splitArgs("  one   two\tthree ")).toEqual(["one", "two", "three"]);
	expect(splitArgs("it\\'s")).toEqual(["it's"]);
});
