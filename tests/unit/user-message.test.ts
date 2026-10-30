import { expect, test } from "bun:test";
import { joinMessage } from "../../shared/attachment.ts";
import { editedMessage, mayHaveFiles, recallable, userParts } from "../../web/src/lib/user-message.ts";

/** A user message with attached text files (#617) is shown as its typed part and chips, and edited without touching the files. */

const notes = { name: "notes.md", bytes: 12, text: "# Notes\n\nok\n" };
const fenced = { name: "readme.md", bytes: 40, text: "```ts\nconst a = 1;\n```\nand more" };
const sent = joinMessage("look at these", [notes, fenced]);

test("a message without file blocks is its own typed part, at no cost", () => {
	for (const text of ["", "plain words", "!ls -la", "```\ncode\n```", '<file path="x">not ours</file>']) {
		const parts = userParts(text);
		expect(parts.typed).toBe(text);
		expect(parts.files).toEqual([]);
	}
	expect(mayHaveFiles("plain")).toBe(false);
	expect(mayHaveFiles(sent)).toBe(true);
	// The marker alone is not a file: what `joinMessage` did not write stays in the text.
	const lookalike = 'I typed <file name="x" size="1"> by hand';
	expect(userParts(lookalike)).toEqual({ typed: lookalike, files: [] });
});

test("the typed part and the files are told apart, the files with their text", () => {
	const { typed, files } = userParts(sent);
	expect(typed).toBe("look at these");
	expect(files.map((f) => [f.name, f.bytes, f.text])).toEqual([
		["notes.md", 12, "# Notes\n\nok"],
		["readme.md", 40, fenced.text],
	]);
	expect(userParts(joinMessage("", [notes])).typed).toBe("");
});

test("editing the words puts the attached files back as they were, byte for byte", () => {
	const { typed, files } = userParts(sent);
	// Saving without a change sends the message as it was.
	expect(editedMessage(typed, files)).toBe(sent);
	// New words, the same files.
	const edited = editedMessage("look at these again", files);
	expect(edited).toBe(joinMessage("look at these again", [notes, fenced]));
	expect(userParts(edited).files.map((f) => f.raw)).toEqual(files.map((f) => f.raw));
	// A message that was only files stays that, and can gain words.
	const only = userParts(joinMessage("", [notes]));
	expect(editedMessage("", only.files)).toBe(joinMessage("", [notes]));
	expect(editedMessage("now with words", only.files)).toBe(joinMessage("now with words", [notes]));
	// Nothing attached: the edit is the typed text.
	expect(editedMessage("just words", [])).toBe("just words");
});

test("Up recalls what was typed, not the files; a message of files alone is not recalled", () => {
	const plain = ["first", "!ls", "second"];
	// No file anywhere: the very same list, so nothing downstream sees a change.
	expect(recallable(plain)).toBe(plain);
	const onlyFiles = joinMessage("", [notes]);
	expect(recallable(["first", sent, onlyFiles, "second"])).toEqual(["first", "look at these", "second"]);
	// A repeat in a row counts once, as in the transcript's own history.
	expect(recallable(["look at these", sent])).toEqual(["look at these"]);
});
