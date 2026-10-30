import { describe, expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { DOCUMENT_LIMITS } from "../../shared/attachment.ts";
import {
	cutToBytes,
	decodeXml,
	docxMessage,
	docxText,
	isScanned,
	MIN_TEXT_BUDGET,
	pageRanges,
	pageText,
	pdfMessage,
	readDocx,
	scannedPages,
	utf8Bytes,
} from "../../web/src/lib/document-text.ts";

/**
 * What a Word document says and what a PDF's pages become in a message (#697): the parts of `lib/document-text.ts` that need
 * no PDF reader and no browser. A `.docx` is a small zip built here with the same reader's counterpart (fflate).
 */

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const body = (inner: string) =>
	`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${inner}<w:sectPr/></w:body></w:document>`;
const run = (text: string) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
const para = (...runs: string[]) => `<w:p><w:pPr><w:jc w:val="left"/></w:pPr>${runs.join("")}</w:p>`;
const cell = (...paragraphs: string[]) =>
	`<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${paragraphs.join("")}</w:tc>`;
const row = (...cells: string[]) => `<w:tr><w:trPr><w:cantSplit/></w:trPr>${cells.join("")}</w:tr>`;
const table = (...rows: string[]) =>
	`<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid/>${rows.join("")}</w:tbl>`;

/** A `.docx`: a zip with the body, and some other parts a Word file has. */
function docx(xml: string, extra: Record<string, Uint8Array> = {}): Uint8Array {
	return zipSync({
		"[Content_Types].xml": strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
		"word/document.xml": strToU8(xml),
		"word/styles.xml": strToU8("<w:styles/>"),
		...extra,
	});
}

describe("docxText: the words of a Word document body", () => {
	test("a paragraph is a line, runs join, an empty paragraph is a break, tabs and line breaks stay", () => {
		const xml = body(
			para(run("Hello"), run(", world")) +
				para() +
				para(run("Second"), "<w:r><w:tab/></w:r>", run("after tab")) +
				para(run("one"), "<w:r><w:br/></w:r>", run("two")),
		);
		expect(docxText(xml)).toBe("Hello, world\n\nSecond\tafter tab\none\ntwo");
	});

	test("entities are decoded, in text and as numbers", () => {
		expect(decodeXml("a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos; &#65;&#x42; &unknown; &#0;")).toBe(
			`a & b <c> "d" 'e' AB &unknown; &#0;`,
		);
		expect(docxText(body(para(run("Fish &amp; Chips &#x4F60;&#22909;"))))).toBe("Fish & Chips 你好");
	});

	test("tab stops of a paragraph's properties are not tab characters, and deleted text is not text", () => {
		const props =
			'<w:pPr><w:tabs><w:tab w:val="left" w:pos="720"/><w:tab w:val="right" w:pos="9000"/></w:tabs></w:pPr>';
		const xml = body(
			`<w:p>${props}${run("kept")}<w:del><w:r><w:delText>gone</w:delText></w:r></w:del><w:ins>${run(" added")}</w:ins></w:p>`,
		);
		expect(docxText(xml)).toBe("kept added");
	});

	test("a self-closing paragraph or text is empty, and runs of empty paragraphs are one break", () => {
		const xml = body(`<w:p/>${para(run("a"))}<w:p/><w:p/>${para(run("<b/>"))}<w:p><w:r><w:t/></w:r></w:p><w:p/>`);
		expect(docxText(xml.replace("<b/>", "b"))).toBe("a\n\nb");
	});

	test("a table is a line for each row, its cells between bars, an empty row is left out", () => {
		const xml = body(
			para(run("before")) +
				table(
					row(cell(para(run("Name"))), cell(para(run("Qty")))),
					row(cell(para(run("apple"))), cell(para(run("3")))),
					row(cell(para()), cell(para())),
					row(cell(para(run("two")), para(run("paragraphs"))), cell(para(run("x")))),
				) +
				para(run("after")),
		);
		expect(docxText(xml)).toBe("before\nName | Qty\napple | 3\ntwo paragraphs | x\nafter");
	});

	test("a table inside a cell is flattened into that cell", () => {
		const inner = table(
			row(cell(para(run("p"))), cell(para(run("q")))),
			row(cell(para(run("r"))), cell(para(run("s")))),
		);
		const xml = body(table(row(cell(para(run("outer")), inner), cell(para(run("side"))))));
		expect(docxText(xml)).toBe("outer p | q; r | s | side");
	});

	test("a text box written twice (for older readers) is read once", () => {
		const choice = `<mc:Choice Requires="wps">${para(run("in the box"))}</mc:Choice>`;
		const fallback = `<mc:Fallback>${para(run("in the box"))}</mc:Fallback>`;
		const xml = body(`<mc:AlternateContent>${choice}${fallback}</mc:AlternateContent>${para(run("tail"))}`);
		expect(docxText(xml)).toBe("in the box\ntail");
	});

	test("a document with no words is empty text", () => {
		expect(docxText(body(""))).toBe("");
		expect(docxText(body(para() + para()))).toBe("");
	});

	test("a tag cut off in the middle ends what could be read, and loses nothing before it", () => {
		expect(docxText(body(`${para(run("whole"))}<w:p><w:r><w:t>cut`))).toBe("whole");
	});
});

describe("readDocx: a .docx file's bytes", () => {
	test("the body's text is read from the zip, whatever else the zip holds", () => {
		const bytes = docx(body(para(run("Dear reader,")) + para(run("the end"))), {
			"word/media/image1.png": new Uint8Array(1000).fill(7),
		});
		expect(readDocx(bytes)).toEqual({ text: "Dear reader,\nthe end" });
	});

	test("an old Word file, or an encrypted one (both are OLE compound files), is told apart from a damaged one", () => {
		const ole = Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0);
		expect(readDocx(ole)).toEqual({ error: "oldWord" });
	});

	test("what is no zip, a zip with no body and a zip cut short are damaged", () => {
		expect(readDocx(strToU8("just some text"))).toEqual({ error: "damaged" });
		expect(readDocx(new Uint8Array(0))).toEqual({ error: "damaged" });
		expect(readDocx(zipSync({ "xl/workbook.xml": strToU8("<x/>") }))).toEqual({ error: "damaged" });
		const whole = docx(body(para(run("hello"))));
		expect(readDocx(whole.slice(0, Math.floor(whole.length / 2)))).toEqual({ error: "damaged" });
	});

	test("a body that would inflate to more than the page will hold is refused before it is inflated", () => {
		// 80 MB of one byte deflates to under 100 KB.
		const big = body(para(run("x".repeat(80 * 1024 * 1024))));
		const bytes = docx(big);
		expect(bytes.length).toBeLessThan(1024 * 1024);
		expect(readDocx(bytes)).toEqual({ error: "tooLarge" });
	});
});

describe("a PDF page's text", () => {
	test("runs join, lines end where the PDF says, marks hold no text, spaces and empty lines are tidied", () => {
		const items = [
			{ str: "First line", hasEOL: true },
			{ type: "beginMarkedContent" },
			{ str: "Second ", hasEOL: false },
			{ str: "line  ", hasEOL: true },
			{ str: "", hasEOL: true },
			{ str: "", hasEOL: true },
			{ str: "", hasEOL: true },
			{ str: "After a gap\u0000", hasEOL: false },
		];
		expect(pageText(items)).toBe("First line\nSecond line\n\nAfter a gap");
	});

	test("a page is a scan when it has fewer letters and digits than a page of text has", () => {
		const few = DOCUMENT_LIMITS.scannedBelowChars;
		expect(isScanned("")).toBe(true);
		expect(isScanned("   \n  --- ... ")).toBe(true);
		expect(isScanned("a".repeat(few - 1))).toBe(true);
		expect(isScanned("a".repeat(few))).toBe(false);
		// Any script counts, and punctuation does not.
		expect(isScanned("你".repeat(few))).toBe(false);
		expect(isScanned("1234567890".repeat(2))).toBe(false);
		expect(isScanned("...,,,;;;".repeat(10))).toBe(true);
	});

	test("which pages have no text, counted from 1", () => {
		const text = "A page of real words, long enough to count.";
		expect(scannedPages([text, "", text, "x", ""])).toEqual([2, 4, 5]);
		expect(scannedPages([text])).toEqual([]);
		expect(scannedPages([])).toEqual([]);
	});

	test("page numbers as ranges", () => {
		expect(pageRanges([1])).toBe("1");
		expect(pageRanges([1, 2, 3])).toBe("1–3");
		expect(pageRanges([1, 4, 5, 6, 9])).toBe("1, 4–6, 9");
		expect(pageRanges([2, 4, 6])).toBe("2, 4, 6");
		expect(pageRanges([])).toBe("");
	});
});

const WORDS = "The quick brown fox jumps over the lazy dog. ";
const text = (n: number) => WORDS.repeat(n).trim();

describe("pdfMessage: what a PDF becomes in the message", () => {
	test("pages that fit are in it after a marker each, and nothing is said to be left out", () => {
		const m = pdfMessage({ pages: 3, texts: [text(2), text(3), text(1)], pictures: [], budget: 100_000 });
		expect(m.text.startsWith("PDF, 3 pages.\n\n--- page 1 ---\n")).toBe(true);
		expect(m.text).toContain(`--- page 2 ---\n${text(3)}\n--- page 3 ---\n${text(1)}`);
		expect(m).toMatchObject({ included: 3, leftOut: 0, pictured: 0, bare: 0, cut: false });
		expect(m.text).not.toContain("Left out");
		expect(m.bytes).toBe(utf8Bytes(m.text));
	});

	test("a one-page PDF is a page, not 1 pages", () => {
		expect(pdfMessage({ pages: 1, texts: [text(1)], pictures: [], budget: 10_000 }).text).toStartWith("PDF, 1 page.\n");
	});

	test("pages past the page limit were never read: the text says which are left out and why", () => {
		const texts = Array.from({ length: DOCUMENT_LIMITS.textPages }, () => text(1));
		const m = pdfMessage({ pages: 60, texts, pictures: [], budget: 200_000 });
		expect(m.included).toBe(50);
		expect(m.leftOut).toBe(10);
		expect(m.text).toContain("Left out (limit of 50 pages): pages 51–60.");
		expect(m.text).toContain("--- page 50 ---");
		expect(m.text).not.toContain("--- page 51 ---");
	});

	test("pages that do not fit the text budget are left out from the first that does not, and the text says so", () => {
		const texts = [text(10), text(10), text(10), text(10)];
		const one = utf8Bytes(`--- page 1 ---\n${texts[0]}`) + 1;
		const m = pdfMessage({ pages: 4, texts, pictures: [], budget: 768 + 2 * one + 10 });
		expect(m.included).toBe(2);
		expect(m.leftOut).toBe(2);
		expect(m.text).toContain("Left out (limit of the text a message carries): pages 3–4.");
		expect(m.text).not.toContain("--- page 3 ---");
		expect(m.cut).toBe(false);
	});

	test("a first page longer than the whole budget goes in cut, and the text says so", () => {
		const budget = MIN_TEXT_BUDGET + 200;
		const m = pdfMessage({ pages: 2, texts: [text(500), text(1)], pictures: [], budget });
		expect(m.cut).toBe(true);
		expect(m.included).toBe(1);
		expect(m.leftOut).toBe(1);
		expect(m.text).toContain("Cut short (limit of the text a message carries): page 1.");
		expect(m.text).toContain("Left out (limit of the text a message carries): page 2.");
		expect(m.bytes).toBeLessThanOrEqual(budget);
	});

	test("the pages with no text that went as pictures are named, and so are the ones that came as nothing", () => {
		const real = text(2);
		const m = pdfMessage({ pages: 5, texts: [real, "", "", "scribble", real], pictures: [2, 3], budget: 100_000 });
		expect(m).toMatchObject({ pictured: 2, bare: 1, leftOut: 0 });
		expect(m.text).toContain("Pages with no text, attached as images: 2–3.");
		expect(m.text).toContain("Pages with little or no text, no image attached: 4.");
		expect(m.text).toContain("--- page 2 ---\n[no text on this page; it is attached as an image]");
		// What little text a page without a picture has is kept; a page with nothing says so.
		expect(m.text).toContain("--- page 4 ---\nscribble");
		const empty = pdfMessage({ pages: 1, texts: [""], pictures: [], budget: 10_000 });
		expect(empty.text).toContain("--- page 1 ---\n[no text on this page, and no image of it is attached]");
	});

	test("a scanned PDF (no text on any page, pictures of them) is all notes and pictures", () => {
		const m = pdfMessage({ pages: 3, texts: ["", "", ""], pictures: [1, 2, 3], budget: 10_000 });
		expect(m).toMatchObject({ included: 3, pictured: 3, bare: 0 });
		expect(m.text).toContain("Pages with no text, attached as images: 1–3.");
	});

	test("whatever the budget and the pages, the message never weighs more than the budget", () => {
		const pageSet = [
			[text(1), text(40), "", text(5), "scrap", text(80)],
			Array.from({ length: 50 }, (_, i) => (i % 7 === 3 ? "" : text(i % 5 === 0 ? 60 : 3))),
			[text(2000)],
			["你好".repeat(300), "世界".repeat(300), "", "é".repeat(500)],
		];
		for (const texts of pageSet) {
			for (const pages of [texts.length, texts.length + 25]) {
				for (const budget of [MIN_TEXT_BUDGET, 1500, 2500, 6000, 20_000, 262_144]) {
					const pictures = scannedPages(texts).filter((n) => n % 2 === 0);
					const m = pdfMessage({ pages, texts, pictures, budget });
					expect(m.bytes, `budget ${budget}, ${texts.length} of ${pages} pages`).toBeLessThanOrEqual(budget);
					expect(m.bytes).toBe(utf8Bytes(m.text));
					expect(m.included + m.leftOut).toBe(pages);
				}
			}
		}
	});
});

describe("docxMessage and the cut of text", () => {
	test("text within the budget goes in as it is", () => {
		expect(docxMessage("short text", 5000)).toEqual({ text: "short text", cut: false });
	});

	test("text over the budget is cut at the end of a line, says it goes on, and fits", () => {
		const lines = Array.from({ length: 400 }, (_, i) => `line ${i} ${text(1)}`);
		const m = docxMessage(lines.join("\n"), 4000);
		expect(m.cut).toBe(true);
		expect(m.text).toContain("[The document continues:");
		expect(utf8Bytes(m.text)).toBeLessThanOrEqual(4000);
		// A whole line before the note: the last kept line is not cut in the middle.
		const kept = m.text.split("\n\n[The document continues")[0] as string;
		expect(lines).toContain(kept.split("\n").at(-1) as string);
	});

	test("cutToBytes keeps whole characters", () => {
		expect(cutToBytes("abc", 10)).toBe("abc");
		expect(cutToBytes("abcdef", 3)).toBe("abc");
		// "é" is two bytes, "你" three, "😀" four: a cut inside one drops all of it.
		expect(cutToBytes("aé", 2)).toBe("a");
		expect(cutToBytes("a你b", 3)).toBe("a");
		expect(cutToBytes("a你b", 4)).toBe("a你");
		expect(cutToBytes("😀😀", 6)).toBe("😀");
		expect(cutToBytes("anything", 0)).toBe("");
	});
});
