import { describe, expect, test } from "bun:test";
import {
	ATTACH_LIMITS,
	actionAllowed,
	canAttachKind,
	classify,
	DOCUMENT_LIMITS,
	type DropFileInfo,
	fenceFor,
	formatTextFile,
	hasMention,
	hasTextFiles,
	isDocumentName,
	joinMessage,
	looksLikeText,
	parseChoices,
	pathText,
	serializeChoices,
	splitMessage,
	type TextFile,
} from "../../shared/attachment.ts";

const bytes = (...values: number[]) => new Uint8Array(values);
const enc = (text: string) => new TextEncoder().encode(text);

const file = (name: string, over: Partial<DropFileInfo> = {}): DropFileInfo => ({ name, type: "", size: 100, ...over });

describe("classify", () => {
	test("a file whose first bytes are text is text, by whatever name or type the browser gave it", () => {
		expect(classify(file("main.ts"), true)).toEqual({ kind: "text", attach: true });
		expect(classify(file("Makefile"), true)).toEqual({ kind: "text", attach: true });
		expect(classify(file("notes"), true)).toEqual({ kind: "text", attach: true });
		expect(classify(file(".env"), true)).toEqual({ kind: "text", attach: true });
		expect(classify(file("data.json", { type: "application/json" }), true)).toEqual({ kind: "text", attach: true });
		expect(classify(file("x", { type: "text/plain" }), true)).toEqual({ kind: "text", attach: true });
	});

	test("what is not text cannot be attached, whatever it is called or says it is", () => {
		expect(classify(file("main.ts"), false)).toEqual({ kind: "other", attach: "binary" });
		expect(classify(file("data.json", { type: "application/json" }), false)).toEqual({
			kind: "other",
			attach: "binary",
		});
		expect(classify(file("x", { type: "text/plain" }), false)).toEqual({ kind: "other", attach: "binary" });
		expect(classify(file("archive.zip", { type: "application/zip" }), false)).toEqual({
			kind: "other",
			attach: "binary",
		});
	});

	test("an image is attached as an image, without looking at its bytes, and at any size", () => {
		expect(classify(file("a.png", { type: "image/png" }), false)).toEqual({ kind: "image", attach: true });
		expect(classify(file("a.jpg", { type: "image/jpeg", size: ATTACH_LIMITS.textFileBytes * 10 }), false)).toEqual({
			kind: "image",
			attach: true,
		});
	});

	test("an SVG is text (its markup), by type or by name, and an image type with no bytes of text is not one", () => {
		expect(classify(file("a.svg", { type: "image/svg+xml" }), true)).toEqual({ kind: "text", attach: true });
		expect(classify(file("a.svg"), true)).toEqual({ kind: "text", attach: true });
		expect(classify(file("A.SVG", { type: "image/png" }), true)).toEqual({ kind: "text", attach: true });
		expect(classify(file("a.svg", { type: "image/svg+xml" }), false)).toEqual({ kind: "other", attach: "binary" });
	});

	test("a PDF and a .docx are documents that can be attached, by name, whatever they hold and whatever type they say", () => {
		for (const name of ["a.pdf", "a.docx", "REPORT.PDF", "Memo.Docx"]) {
			expect(classify(file(name, { type: "application/octet-stream" }), false), name).toEqual({
				kind: "document",
				attach: true,
			});
			expect(classify(file(name), true), `${name} that looks like text`).toEqual({ kind: "document", attach: true });
		}
		expect(classify(file("scan.pdf", { type: "image/png" }), false)).toEqual({ kind: "document", attach: true });
	});

	test("a document over the limit is too large to read, one at the limit is attached", () => {
		const limit = DOCUMENT_LIMITS.fileBytes;
		expect(classify(file("a.pdf", { size: limit }), false)).toEqual({ kind: "document", attach: true });
		expect(classify(file("a.pdf", { size: limit + 1 }), false)).toEqual({
			kind: "document",
			attach: "documentTooLarge",
		});
		expect(classify(file("a.docx", { size: limit + 1 }), false)).toEqual({
			kind: "document",
			attach: "documentTooLarge",
		});
		expect(classify(file("a.pdf", { size: 0 }), false)).toEqual({ kind: "document", attach: true });
	});

	test("the other documents omp reads from a path are a path only: an old .doc cannot be attached", () => {
		for (const name of ["a.doc", "a.ppt", "a.pptx", "a.xls", "a.xlsx", "a.rtf", "a.epub"]) {
			expect(classify(file(name, { type: "application/octet-stream" }), false), name).toEqual({
				kind: "other",
				attach: "document",
			});
			expect(classify(file(name), true), `${name} that looks like text`).toEqual({ kind: "other", attach: "document" });
		}
	});

	test("a name that only ends in a document's letters is not a document", () => {
		expect(isDocumentName("a.pdf")).toBe(true);
		expect(isDocumentName("A.Docx")).toBe(true);
		expect(isDocumentName("pdf")).toBe(false);
		expect(isDocumentName(".pdf")).toBe(false);
		expect(isDocumentName("a.pdf.txt")).toBe(false);
		expect(isDocumentName("a.pdfx")).toBe(false);
		expect(isDocumentName("a.constructor")).toBe(false);
		expect(isDocumentName("a.__proto__")).toBe(false);
		expect(classify(file("a.pdf.txt"), true)).toEqual({ kind: "text", attach: true });
	});

	test("a folder is a folder first, whatever it is called", () => {
		expect(classify(file("src", { directory: true }), true)).toEqual({ kind: "folder", attach: "folder" });
		expect(classify(file("scans.pdf", { directory: true, type: "image/png" }), false)).toEqual({
			kind: "folder",
			attach: "folder",
		});
	});

	test("a text file over the limit is text that is too large; one at the limit is attached", () => {
		const limit = ATTACH_LIMITS.textFileBytes;
		expect(classify(file("a.txt", { size: limit }), true)).toEqual({ kind: "text", attach: true });
		expect(classify(file("a.txt", { size: limit + 1 }), true)).toEqual({ kind: "text", attach: "tooLarge" });
		expect(classify(file("a.txt", { size: 0 }), true)).toEqual({ kind: "text", attach: true });
		// A binary file is a binary file, not a large one.
		expect(classify(file("a.bin", { size: limit + 1 }), false)).toEqual({ kind: "other", attach: "binary" });
	});
});

describe("kinds and actions", () => {
	test("text, images and the two documents carry content a message can hold", () => {
		expect(canAttachKind("text")).toBe(true);
		expect(canAttachKind("image")).toBe(true);
		expect(canAttachKind("document")).toBe(true);
		expect(canAttachKind("other")).toBe(false);
		expect(canAttachKind("folder")).toBe(false);
		expect(actionAllowed("other", "attach")).toBe(false);
		expect(actionAllowed("folder", "attach")).toBe(false);
		expect(actionAllowed("other", "path")).toBe(true);
		expect(actionAllowed("folder", "path")).toBe(true);
		expect(actionAllowed("text", "attach")).toBe(true);
		expect(actionAllowed("document", "attach")).toBe(true);
		expect(actionAllowed("image", "path")).toBe(true);
	});
});

describe("looksLikeText", () => {
	test("plain text, any script, and an empty file are text", () => {
		expect(looksLikeText(enc("hello\nworld\r\n\ttab"))).toBe(true);
		expect(looksLikeText(enc("héllo wörld, 你好, 😀, שלום"))).toBe(true);
		expect(looksLikeText(enc("\uFEFFwith a byte order mark"))).toBe(true);
		expect(looksLikeText(new Uint8Array(0))).toBe(true);
	});

	test("a NUL byte anywhere is not text, even in a file that is valid UTF-8 otherwise", () => {
		expect(looksLikeText(bytes(0))).toBe(false);
		expect(looksLikeText(enc("text\0text"))).toBe(false);
		expect(looksLikeText(bytes(0x68, 0x69, 0))).toBe(false);
		// UTF-16 text is NUL-studded.
		expect(looksLikeText(bytes(0xff, 0xfe, 0x68, 0, 0x69, 0))).toBe(false);
	});

	test("bytes that are not UTF-8 are not text", () => {
		expect(looksLikeText(bytes(0xff, 0xfe))).toBe(false);
		expect(looksLikeText(bytes(0x80))).toBe(false);
		expect(looksLikeText(bytes(0xc3, 0x28))).toBe(false);
		expect(looksLikeText(bytes(0x68, 0xe9, 0x6c))).toBe(false); // Latin-1 "hél"
		expect(looksLikeText(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe(false); // a PNG
	});

	test("a character cut at the end of the sample is let by, one cut in the middle of it is not", () => {
		const e = enc("é"); // c3 a9
		expect(looksLikeText(Uint8Array.of(0x68, e[0] as number))).toBe(true);
		const euro = enc("€"); // e2 82 ac
		expect(looksLikeText(Uint8Array.of(0x68, ...euro.slice(0, 1)))).toBe(true);
		expect(looksLikeText(Uint8Array.of(0x68, ...euro.slice(0, 2)))).toBe(true);
		const emoji = enc("😀"); // f0 9f 98 80
		for (let cut = 1; cut < 4; cut++) expect(looksLikeText(emoji.slice(0, cut)), `cut at ${cut}`).toBe(true);
		// The same bytes with something after them are broken.
		expect(looksLikeText(Uint8Array.of(0x68, e[0] as number, 0x68))).toBe(false);
		expect(looksLikeText(Uint8Array.of(...euro.slice(0, 2), 0x68))).toBe(false);
	});

	test("a sample that is the whole file may not end in a cut character, however it is cut", () => {
		const e = enc("é");
		const euro = enc("€");
		const emoji = enc("😀");
		expect(looksLikeText(Uint8Array.of(0x68, e[0] as number), true)).toBe(false);
		expect(looksLikeText(Uint8Array.of(0x68, ...euro.slice(0, 1)), true)).toBe(false);
		expect(looksLikeText(Uint8Array.of(0x68, ...euro.slice(0, 2)), true)).toBe(false);
		for (let cut = 1; cut < 4; cut++) expect(looksLikeText(emoji.slice(0, cut), true), `cut at ${cut}`).toBe(false);
		// Whole characters, and the empty file, are text either way.
		for (const whole of [true, false]) {
			expect(looksLikeText(enc("héllo € 😀"), whole)).toBe(true);
			expect(looksLikeText(new Uint8Array(0), whole)).toBe(true);
			expect(looksLikeText(enc("plain"), whole)).toBe(true);
			expect(looksLikeText(bytes(0x68, 0), whole)).toBe(false);
			expect(looksLikeText(bytes(0xff), whole)).toBe(false);
		}
		// Left out, it is the start of a longer file.
		expect(looksLikeText(Uint8Array.of(0x68, e[0] as number))).toBe(true);
		expect(looksLikeText(Uint8Array.of(0x68, e[0] as number), false)).toBe(true);
	});

	test("a sample that is not the whole is still not text when a character is broken in its middle", () => {
		expect(looksLikeText(bytes(0x68, 0xc3, 0x68, 0x69), false)).toBe(false);
		expect(looksLikeText(bytes(0xe2, 0x82, 0x68), false)).toBe(false);
	});

	test("the same sample does not carry over between calls: a cut character in one does not spoil the next", () => {
		const e = enc("é");
		expect(looksLikeText(Uint8Array.of(e[0] as number))).toBe(true);
		expect(looksLikeText(enc("a"), true)).toBe(true);
		expect(looksLikeText(Uint8Array.of(e[1] as number))).toBe(false);
	});
});

describe("remembered choices", () => {
	test("nothing, garbage and the wrong shape of JSON give no choices", () => {
		for (const raw of [null, "", "not json", "{", "[]", '["text","attach"]', "null", "42", '"text"', "true"]) {
			expect(parseChoices(raw), String(raw)).toEqual({});
		}
	});

	test("known kinds with known actions are kept", () => {
		expect(parseChoices('{"text":"attach","image":"path","other":"path","folder":"path"}')).toEqual({
			text: "attach",
			image: "path",
			other: "path",
			folder: "path",
		});
		expect(parseChoices('{"text":"path"}')).toEqual({ text: "path" });
	});

	test("an unknown kind, an unknown action or one of the wrong type is dropped", () => {
		expect(parseChoices('{"video":"attach","text":"copy","image":1,"other":null,"folder":["path"]}')).toEqual({});
		expect(parseChoices('{"text":"attach","video":"path","__proto__":"path","constructor":"path"}')).toEqual({
			text: "attach",
		});
	});

	test("attach for something that has no content to attach is dropped, its path is kept", () => {
		expect(parseChoices('{"other":"attach","folder":"attach"}')).toEqual({});
		expect(parseChoices('{"other":"attach","folder":"path","text":"attach"}')).toEqual({
			folder: "path",
			text: "attach",
		});
	});

	test("a document can be remembered as attached or as a path", () => {
		expect(parseChoices('{"document":"attach"}')).toEqual({ document: "attach" });
		expect(parseChoices('{"document":"path","other":"path"}')).toEqual({ document: "path", other: "path" });
		expect(serializeChoices({ document: "attach", text: "attach" })).toBe('{"text":"attach","document":"attach"}');
	});

	test("serializing gives null for no choice, and only what parsing would keep otherwise", () => {
		expect(serializeChoices({})).toBeNull();
		expect(serializeChoices({ other: "attach" })).toBeNull();
		expect(serializeChoices({ folder: "attach", other: "attach" })).toBeNull();
		expect(serializeChoices({ text: "attach", other: "path" })).toBe('{"text":"attach","other":"path"}');
		expect(serializeChoices({ other: "attach", image: "attach" })).toBe('{"image":"attach"}');
		const choices = { text: "path", image: "attach", other: "path", folder: "path" } as const;
		expect(parseChoices(serializeChoices(choices))).toEqual(choices);
		expect(parseChoices(serializeChoices({}))).toEqual({});
	});
});

const textFile = (name: string, text: string, size = text.length): TextFile => ({ name, bytes: size, text });

/** What a file comes back as from a message: the text without the one newline the block adds. */
const comes = (text: string) => (text.endsWith("\n") ? text.slice(0, -1) : text);

describe("text files in a message", () => {
	test("a file is a block with its name, size and text in a fence named for its language", () => {
		expect(formatTextFile(textFile("a.ts", "let a = 1;\n", 11))).toBe(
			'<file name="a.ts" size="11">\n```ts\nlet a = 1;\n```\n</file>',
		);
		expect(formatTextFile(textFile("run.SH", "echo hi", 7))).toBe(
			'<file name="run.SH" size="7">\n```sh\necho hi\n```\n</file>',
		);
		expect(formatTextFile(textFile("Makefile", "all:\n", 5))).toBe(
			'<file name="Makefile" size="5">\n```\nall:\n```\n</file>',
		);
		expect(formatTextFile(textFile("a.unknownext", "x", 1))).toBe(
			'<file name="a.unknownext" size="1">\n```\nx\n```\n</file>',
		);
		// An extension that is an Object.prototype member is no language.
		expect(formatTextFile(textFile("a.constructor", "x", 1))).toBe(
			'<file name="a.constructor" size="1">\n```\nx\n```\n</file>',
		);
	});

	test("the size is the one given, whole and not below zero", () => {
		expect(formatTextFile(textFile("a.txt", "x", 3.9))).toContain('size="3"');
		expect(formatTextFile(textFile("a.txt", "x", -5))).toContain('size="0"');
		expect(formatTextFile(textFile("a.txt", "x", 0))).toContain('size="0"');
	});

	test("the fence is longer than any run of backticks in the file", () => {
		expect(fenceFor("")).toBe("```");
		expect(fenceFor("no ticks")).toBe("```");
		expect(fenceFor("`one` and ``two``")).toBe("```");
		expect(fenceFor("a ``` b")).toBe("````");
		expect(fenceFor("a ```` b")).toBe("`````");
		expect(fenceFor("```\n````\n```")).toBe("`````");
		expect(formatTextFile(textFile("a.md", "```js\ncode\n```\n"))).toBe(
			'<file name="a.md" size="15">\n````md\n```js\ncode\n```\n````\n</file>',
		);
	});

	test("one file comes back as it went in, in any shape", () => {
		const texts = [
			"plain\n",
			"no trailing newline",
			"",
			"line one\n\nline three\n\n\nline six",
			"with ``` three ticks\n",
			"```js\nfenced\n```\n",
			"````\nfour ticks alone\n````",
			"`````\n```` \n```\n",
			"ends with ticks ```",
			"\nstarts with a newline",
			"windows\r\nlines\r\n",
			'<file name="inner.txt" size="3">\n```\nabc\n```\n</file>\n',
			"</file>\n```\n</file>\n",
			'tabs\t\tand <b>tags</b> & "quotes"\n',
			"你好，世界 😀\n",
		];
		for (const text of texts) {
			const block = formatTextFile(textFile("f.txt", text));
			const split = splitMessage(block);
			expect(split.files, JSON.stringify(text)).toHaveLength(1);
			expect(split.files[0]?.text, JSON.stringify(text)).toBe(comes(text));
			expect(split.files[0]?.name).toBe("f.txt");
			expect(split.files[0]?.raw).toBe(block);
			expect(split.text).toBe("");
		}
	});

	test("an empty file is an empty block, and an empty file comes back empty", () => {
		const block = formatTextFile(textFile("empty.txt", "", 0));
		expect(block).toBe('<file name="empty.txt" size="0">\n```\n```\n</file>');
		expect(splitMessage(block)).toEqual({
			text: "",
			files: [{ name: "empty.txt", bytes: 0, text: "", raw: block }],
		});
	});

	test("the one newline a block ends the text with is not the file's: a file ending in one comes back without it", () => {
		const one = splitMessage(formatTextFile(textFile("a.txt", "a\n"))).files[0];
		const none = splitMessage(formatTextFile(textFile("a.txt", "a"))).files[0];
		expect(one?.text).toBe("a");
		expect(none?.text).toBe("a");
		expect(splitMessage(formatTextFile(textFile("a.txt", "a\n\n"))).files[0]?.text).toBe("a\n");
		expect(splitMessage(formatTextFile(textFile("a.txt", "\n"))).files[0]?.text).toBe("");
	});

	test("a name cannot end its attribute, open a tag or start another line", () => {
		const names: Array<[string, string]> = [
			['a"b.txt', "a_b.txt"],
			["a\nb.txt", "a_b.txt"],
			["a\r\nb.txt", "a__b.txt"],
			["<script>.txt", "_script_.txt"],
			['x" size="9" evil="', "x_ size=_9_ evil=_"],
			["a\0b\x07c.txt", "a_b_c.txt"],
		];
		for (const [name, shown] of names) {
			const block = formatTextFile(textFile(name, "body\n", 5));
			const header = block.split("\n")[0];
			expect(header, JSON.stringify(name)).toBe(`<file name="${shown}" size="5">`);
			const split = splitMessage(block);
			expect(split.files, JSON.stringify(name)).toHaveLength(1);
			expect(split.files[0]).toMatchObject({ name: shown, bytes: 5, text: "body" });
		}
		// A name the header keeps whole: spaces, quotes of the other kind, brackets, non-ASCII.
		const kept = "my file (1) 'x' [y] é你.txt";
		expect(splitMessage(formatTextFile(textFile(kept, "x"))).files[0]?.name).toBe(kept);
	});

	test("a long name is cut in the header", () => {
		const long = `${"n".repeat(300)}.txt`;
		const split = splitMessage(formatTextFile(textFile(long, "x")));
		expect(split.files[0]?.name).toBe(long.slice(0, 200));
	});

	test("with no files the text is the message", () => {
		expect(joinMessage("hello", [])).toBe("hello");
		expect(joinMessage("", [])).toBe("");
		expect(joinMessage("  spaced  ", [])).toBe("  spaced  ");
	});

	test("the files follow the text, one block each, and come back with the text", () => {
		const a = textFile("a.ts", "export const a = 1;\n");
		const b = textFile("b.md", "# B\n\n```\ncode\n```\n");
		const c = textFile("c.txt", "no newline");
		const message = joinMessage("Please look at these", [a, b, c]);
		expect(message).toBe(`Please look at these\n\n${formatTextFile(a)}\n${formatTextFile(b)}\n${formatTextFile(c)}`);
		const split = splitMessage(message);
		expect(split.text).toBe("Please look at these");
		expect(split.files.map((f) => [f.name, f.text])).toEqual([
			["a.ts", comes(a.text)],
			["b.md", comes(b.text)],
			["c.txt", "no newline"],
		]);
		expect(split.files.map((f) => f.raw)).toEqual([formatTextFile(a), formatTextFile(b), formatTextFile(c)]);
		expect(hasTextFiles(message)).toBe(true);
	});

	test("files without text are the whole message", () => {
		const a = textFile("a.txt", "A\n");
		const message = joinMessage("", [a, textFile("b.txt", "B\n")]);
		expect(message.startsWith("<file ")).toBe(true);
		const split = splitMessage(message);
		expect(split.text).toBe("");
		expect(split.files.map((f) => f.name)).toEqual(["a.txt", "b.txt"]);
	});

	test("text written before and after a block stays text, in order, without the blank lines between", () => {
		const block = formatTextFile(textFile("a.txt", "A\n"));
		const split = splitMessage(`before\n\n${block}\n\nafter`);
		expect(split.text).toBe("before\n\nafter");
		expect(split.files).toHaveLength(1);
		const between = splitMessage(`one\n\n${block}\n\ntwo\n\n${formatTextFile(textFile("b.txt", "B"))}\n\nthree`);
		expect(between.text).toBe("one\n\ntwo\n\nthree");
		expect(between.files.map((f) => f.name)).toEqual(["a.txt", "b.txt"]);
		expect(splitMessage(`  padded  \n\n${block}`).text).toBe("padded");
	});

	test("the same name twice is two files", () => {
		const message = joinMessage("", [textFile("a.txt", "one\n"), textFile("a.txt", "two\n")]);
		expect(splitMessage(message).files.map((f) => f.text)).toEqual(["one", "two"]);
	});

	test("a file that holds a message with files in it is one file", () => {
		const inner = joinMessage("inner text", [textFile("in.txt", "in\n")]);
		const message = joinMessage("outer", [textFile("transcript.md", inner)]);
		const split = splitMessage(message);
		expect(split.text).toBe("outer");
		expect(split.files).toHaveLength(1);
		expect(split.files[0]?.name).toBe("transcript.md");
		expect(split.files[0]?.text).toBe(inner);
	});

	test("a message that only mentions a file tag is text", () => {
		const mentions = [
			"what does <file name= do in this format?",
			'<file name="a.txt" size="1">',
			'<file name="a.txt" size="1">\nnot fenced\n</file>',
			'<file name="a.txt" size="x">\n```\nabc\n```\n</file>',
			'<file name="a.txt">\n```\nabc\n```\n</file>',
			'<file name="a.txt" size="1">\n```\nunclosed\n',
			'<file name="a.txt" size="1">\n```\nclosing fence not at a line start```\n</file>',
			'<file name="a.txt" size="1">\n``\nabc\n``\n</file>',
			'<file path="a.txt">\n```\nabc\n```\n</file>',
		];
		for (const message of mentions) {
			expect(splitMessage(message), message).toEqual({ text: message, files: [] });
			expect(hasTextFiles(message), message).toBe(false);
		}
	});

	test("a mention next to a real block leaves the mention in the text", () => {
		const block = formatTextFile(textFile("a.txt", "A\n"));
		const split = splitMessage(`the <file name= tag is odd\n\n${block}`);
		expect(split.text).toBe("the <file name= tag is odd");
		expect(split.files).toHaveLength(1);
	});

	test("a message with no tag at all is returned whole, untouched", () => {
		const message = "  leading and trailing space  \n\n\nand blank lines\n\n";
		expect(splitMessage(message)).toEqual({ text: message, files: [] });
		expect(hasTextFiles("")).toBe(false);
	});
});

describe("hasMention", () => {
	test("an @ that omp reads as a file mention: at the start or after whitespace, then a quote, ~, / or a dot", () => {
		for (const text of [
			'@"a b"',
			'@"a b.txt" is odd',
			"@~/x",
			"@/etc/hosts",
			"@./a",
			"@../up/a.ts",
			"@.env",
			"look at @~/notes please",
			"look at @/etc/hosts",
			"see\n@./a.ts",
			"see\t@./a.ts",
			"see\r\n@/x",
			"two  @/x",
			"a @src is not, but @./yes is",
		]) {
			expect(hasMention(text), JSON.stringify(text)).toBe(true);
		}
	});

	test("what is not one: an address, a bare name, a mention in the middle of a word, an @ alone", () => {
		for (const text of [
			"",
			"@",
			"@src",
			"@src/a.ts",
			"@name",
			"@ ./a",
			"a@b.c",
			"x@/y",
			"x@./y",
			"x@~/y",
			"mail me: me@example.com",
			"email @ home",
			"@@/a",
			"price is 5@/unit",
			'a@"q"',
		]) {
			expect(hasMention(text), JSON.stringify(text)).toBe(false);
		}
	});

	test("a mention inside a text file's text is found, one in a message's other text is a different question", () => {
		expect(hasMention(formatTextFile(textFile("a.md", "run @./script.sh now\n")))).toBe(true);
		expect(hasMention(textFile("a.md", "no mention\n").text)).toBe(false);
	});
});

describe("pathText", () => {
	test("a path without whitespace is written as it is", () => {
		expect(pathText("/Users/me/notes.txt")).toBe("/Users/me/notes.txt");
		expect(pathText("C:\\Users\\me\\a.txt")).toBe("C:\\Users\\me\\a.txt");
		expect(pathText("")).toBe("");
	});

	test("a path with whitespace of any kind is quoted, so that it reads as one thing", () => {
		expect(pathText("/Users/me/my notes.txt")).toBe('"/Users/me/my notes.txt"');
		expect(pathText("/tmp/a\tb")).toBe('"/tmp/a\tb"');
		expect(pathText("/tmp/a\nb")).toBe('"/tmp/a\nb"');
		expect(pathText("/tmp/a\u00a0b")).toBe('"/tmp/a\u00a0b"');
	});
});
