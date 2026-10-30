import { describe, expect, test } from "bun:test";
import { numbered, safeName, uploadDate } from "../../server/upload.ts";

const size = (s: string) => Buffer.byteLength(s);

describe("safeName", () => {
	test("a name that is fine stays as it is", () => {
		for (const name of [
			"report.pdf",
			"My Photo (1).jpg",
			"a.tar.gz",
			".env",
			".gitignore",
			"README",
			"é你😀.txt",
			"a-b_c.d",
		]) {
			expect(safeName(name), name).toBe(name);
		}
	});

	test("only the part after the last slash or backslash is kept", () => {
		expect(safeName("../../x")).toBe("x");
		expect(safeName("../../outside.txt")).toBe("outside.txt");
		expect(safeName("/etc/passwd")).toBe("passwd");
		expect(safeName("a/b/c.txt")).toBe("c.txt");
		expect(safeName("a\\b")).toBe("b");
		expect(safeName("..\\..\\windows\\system32\\x.dll")).toBe("x.dll");
		expect(safeName("C:\\Users\\me\\a.txt")).toBe("a.txt");
		expect(safeName("a/b\\c")).toBe("c");
		expect(safeName("a\\b/c")).toBe("c");
		expect(safeName("./a.txt")).toBe("a.txt");
		expect(safeName("//a.txt")).toBe("a.txt");
	});

	test("nothing left of a name makes it `file`", () => {
		for (const name of [
			"",
			".",
			"..",
			"...",
			"/",
			"\\",
			"a/",
			"a\\",
			"../",
			"..\\",
			" ",
			"   ",
			" . ",
			". . .",
			".. ",
			"x/..",
		]) {
			expect(safeName(name), JSON.stringify(name)).toBe("file");
		}
	});

	test("control characters become underscores, NUL included", () => {
		expect(safeName("a\0b")).toBe("a_b");
		expect(safeName("a\tb\nc\rd")).toBe("a_b_c_d");
		expect(safeName("a\x01\x1fb")).toBe("a__b");
		expect(safeName("a\x7fb")).toBe("a_b");
		expect(safeName("a\x7f")).toBe("a_");
		expect(safeName("\0")).toBe("_");
		expect(safeName("a\0/b")).toBe("b");
	});

	test("direction characters become underscores, so that `gpj.exe` cannot read as `exe.jpg`", () => {
		const bidi = [
			"\u200e",
			"\u200f",
			"\u202a",
			"\u202b",
			"\u202c",
			"\u202d",
			"\u202e",
			"\u2066",
			"\u2067",
			"\u2068",
			"\u2069",
		];
		for (const c of bidi) {
			expect(safeName(`photo${c}gpj.exe`), c.codePointAt(0)?.toString(16)).toBe("photo_gpj.exe");
		}
		expect(safeName("photo\u202Egpj.exe")).not.toContain("\u202e");
	});

	test("C1 controls, line and paragraph separators and characters that do not show become underscores", () => {
		const invisible = [
			"\u0080",
			"\u0085",
			"\u009f",
			"\u2028",
			"\u2029",
			"\u061c",
			"\u200b",
			"\u200c",
			"\u200d",
			"\u2060",
			"\u2061",
			"\u2062",
			"\u2063",
			"\u2064",
			"\u2065",
			"\u2066",
			"\ufeff",
		];
		for (const c of invisible) {
			const code = c.codePointAt(0)?.toString(16);
			expect(safeName(`a${c}b.txt`), code).toBe("a_b.txt");
			expect(safeName(`${c}x.txt`), code).toBe("_x.txt");
		}
		expect(safeName("a\u200b\u200c\u200d.txt")).toBe("a___.txt");
		expect(safeName("\ufeffbom.txt")).toBe("_bom.txt");
	});

	test("the characters next to the replaced ranges are kept", () => {
		// U+00A0 (no-break space), U+00A1, U+061B, U+202F (narrow no-break space), U+2010 (hyphen), U+2030, U+2070, U+FEFE, U+FF10.
		for (const c of ["\u00a0", "\u00a1", "\u061b", "\u202f", "\u2010", "\u2030", "\u2070", "\ufefe", "\uff10"]) {
			const name = `a${c}b.txt`;
			expect(safeName(name), c.codePointAt(0)?.toString(16)).toBe(name);
		}
	});

	test("a name made only of invisible characters is not empty, and a visible one around them stays visible", () => {
		expect(safeName("\u200b")).toBe("_");
		expect(safeName("\u200b\u200b.txt")).toBe("__.txt");
		expect(safeName("\u2028")).toBe("_");
		// At the end they are underscores, not trimmed away to a different name.
		expect(safeName("report\u200b")).toBe("report_");
	});

	test("what other systems refuse in a name becomes an underscore", () => {
		expect(safeName('a:b*c?d"e<f>g|h')).toBe("a_b_c_d_e_f_g_h");
		expect(safeName(':*?"<>|')).toBe("_______");
		expect(safeName("12:30 notes.txt")).toBe("12_30 notes.txt");
	});

	test("dots and spaces at the end go, spaces at the start too", () => {
		expect(safeName("a.txt.")).toBe("a.txt");
		expect(safeName("a.txt. . ")).toBe("a.txt");
		expect(safeName("name  ")).toBe("name");
		expect(safeName("  name")).toBe("name");
		expect(safeName("a...")).toBe("a");
		expect(safeName(".env.")).toBe(".env");
		expect(safeName("a b ")).toBe("a b");
		// Inside the name they stay.
		expect(safeName("a..b")).toBe("a..b");
		expect(safeName("a  b")).toBe("a  b");
		expect(safeName(".hidden")).toBe(".hidden");
	});

	test("a name is made of one form of its letters: NFC", () => {
		const decomposed = "e\u0301.txt";
		expect(safeName(decomposed)).toBe("\u00e9.txt");
		expect(safeName(decomposed)).toBe(safeName("\u00e9.txt"));
		expect(safeName("Cafe\u0301")).toBe("Caf\u00e9");
	});

	test("a name of up to 120 bytes is kept whole, a longer one is cut to at most 120 and keeps its extension", () => {
		const edge = `${"a".repeat(116)}.pdf`;
		expect(size(edge)).toBe(120);
		expect(safeName(edge)).toBe(edge);
		const over = `${"a".repeat(117)}.pdf`;
		const cut = safeName(over);
		expect(size(cut)).toBeLessThanOrEqual(120);
		expect(cut.endsWith(".pdf")).toBe(true);
		expect(cut).toBe(`${"a".repeat(116)}.pdf`);

		const huge = safeName(`${"x".repeat(5000)}.tar.gz`);
		expect(size(huge)).toBeLessThanOrEqual(120);
		expect(huge.endsWith(".gz")).toBe(true);
		expect(huge.startsWith("xxx")).toBe(true);
	});

	test("a long name with no extension, or one that is not an extension, is cut too", () => {
		const plain = safeName("n".repeat(500));
		expect(plain).toBe("n".repeat(120));
		const longExt = safeName(`name.${"e".repeat(300)}`);
		expect(size(longExt)).toBeLessThanOrEqual(120);
		expect(longExt.startsWith("name.")).toBe(true);
		const dotfile = safeName(`.${"h".repeat(300)}`);
		expect(size(dotfile)).toBeLessThanOrEqual(120);
		expect(dotfile.startsWith(".hhh")).toBe(true);
	});

	test("a character is never split by the cut, whatever its width in bytes", () => {
		for (const ch of ["é", "你", "😀", "e\u0301"]) {
			for (const ext of ["", ".txt"]) {
				const name = safeName(`${ch.repeat(200)}${ext}`);
				expect(size(name), `${ch}${ext}`).toBeLessThanOrEqual(120);
				// Round trips through UTF-8: no half of a pair, no replacement character.
				expect(Buffer.from(name).toString("utf8"), `${ch}${ext}`).toBe(name);
				expect(name).not.toContain("\ufffd");
				expect(name.endsWith(ext)).toBe(true);
				expect(name.length).toBeGreaterThan(ext.length);
			}
		}
		// 4-byte characters: 30 fit.
		expect(Array.from(safeName("😀".repeat(100))).length).toBe(30);
	});

	test("what the cut leaves does not end in a dot or a space either", () => {
		const dotted = safeName(`${"a".repeat(119)}.${"b".repeat(20)}`);
		expect(size(dotted)).toBeLessThanOrEqual(120);
		expect(dotted).not.toMatch(/[. ]$/);
		const spaced = safeName(`${"a".repeat(119)} ${"b".repeat(20)}`);
		expect(size(spaced)).toBeLessThanOrEqual(120);
		expect(spaced).not.toMatch(/[. ]$/);
	});

	test("a path that holds a long name gets the long name's last part", () => {
		const name = safeName(`../../${"d".repeat(300)}/${"f".repeat(300)}.txt`);
		expect(name.startsWith("fff")).toBe(true);
		expect(name.endsWith(".txt")).toBe(true);
		expect(size(name)).toBeLessThanOrEqual(120);
	});

	test("the result is never a path: no separator, no dot-only name, not empty", () => {
		const samples = [
			"../..",
			"..%2f..",
			"a/../b",
			"\\\\server\\share\\x",
			"x\0/../../y",
			"....//....//z",
			"/..",
			"\u202e/\u202e",
		];
		for (const given of samples) {
			const name = safeName(given);
			expect(name, given).not.toMatch(/[/\\\0]/);
			expect(name, given).not.toMatch(/^\.+$/);
			expect(name.length, given).toBeGreaterThan(0);
		}
	});

	test("tidying a name twice changes nothing", () => {
		for (const given of [
			"../../x",
			"a\0b.txt",
			"photo\u202Egpj.exe",
			`${"é".repeat(200)}.txt`,
			"e\u0301 .",
			"a:b",
			" . ",
		]) {
			const once = safeName(given);
			expect(safeName(once), given).toBe(once);
		}
	});
});

describe("numbered", () => {
	test("the number goes before the extension", () => {
		expect(numbered("a.pdf", 2)).toBe("a (2).pdf");
		expect(numbered("report.final.docx", 1)).toBe("report.final (1).docx");
		expect(numbered("a.tar.gz", 3)).toBe("a.tar (3).gz");
		expect(numbered("My Photo.jpg", 10)).toBe("My Photo (10).jpg");
	});

	test("a dotfile or a name without an extension gets it at the end", () => {
		expect(numbered(".env", 1)).toBe(".env (1)");
		expect(numbered(".gitignore", 2)).toBe(".gitignore (2)");
		expect(numbered("Makefile", 1)).toBe("Makefile (1)");
		expect(numbered("README", 12)).toBe("README (12)");
	});

	test("numbering a numbered name goes on from the name, so that every number is tried once", () => {
		expect(numbered("a (1).pdf", 1)).toBe("a (1) (1).pdf");
	});
});

describe("uploadDate", () => {
	test("the day in the server's time zone, with two-digit month and day", () => {
		expect(uploadDate(new Date(2026, 9, 24, 12, 0, 0))).toBe("2026-10-24");
		expect(uploadDate(new Date(2026, 0, 5, 0, 0, 0))).toBe("2026-01-05");
		expect(uploadDate(new Date(2026, 11, 31, 23, 59, 59, 999))).toBe("2026-12-31");
		expect(uploadDate(new Date(2028, 1, 29, 6, 30))).toBe("2028-02-29");
	});

	test("a name of a day is a plain folder name", () => {
		expect(uploadDate(new Date(2026, 9, 24))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
	});
});
