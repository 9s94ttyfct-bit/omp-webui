import { strToU8, zipSync } from "fflate";

/**
 * PDF and Word documents made on the spot for the specs of #697, so that no binary is committed: a small PDF is plain text
 * (objects, a cross-reference table of their byte offsets), and a `.docx` is a zip of a few XML parts.
 */

export interface PdfPage {
	/** The lines of text, top to bottom, in Helvetica. */
	lines?: string[];
	/** An 8 × 8 grey picture over the page and no text: a scan. */
	picture?: boolean;
}

const pdfString = (line: string) => line.replace(/[\\()]/g, (c) => `\\${c}`);

/** A PDF of `pages`, one object after another with the offsets of each in the cross-reference table at the end. */
export function makePdf(pages: PdfPage[]): Buffer {
	// Objects 1 to 4: the catalog, the page list, the font, the picture; then a page and its content for each page.
	const objects: (string | { dict: string; stream: Buffer })[] = [];
	const kids = pages.map((_, i) => `${5 + i * 2} 0 R`).join(" ");
	objects.push("<< /Type /Catalog /Pages 2 0 R >>");
	objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
	objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
	objects.push({
		dict: "/Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray /BitsPerComponent 8",
		stream: Buffer.from(Array.from({ length: 64 }, (_, i) => 30 + ((i * 5) % 200))),
	});
	pages.forEach((page, i) => {
		const content = page.picture
			? "q 468 0 0 468 72 150 cm /Im1 Do Q"
			: `BT /F1 16 Tf 18 TL 72 720 Td ${(page.lines ?? []).map((l) => `(${pdfString(l)}) Tj T*`).join(" ")} ET`;
		objects.push(
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> /XObject << /Im1 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`,
		);
		objects.push({ dict: "", stream: Buffer.from(content, "latin1") });
	});

	const parts: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1")];
	const offsets: number[] = [];
	let at = parts[0]?.length ?? 0;
	objects.forEach((object, i) => {
		offsets.push(at);
		const piece =
			typeof object === "string"
				? Buffer.from(`${i + 1} 0 obj\n${object}\nendobj\n`, "latin1")
				: Buffer.concat([
						Buffer.from(`${i + 1} 0 obj\n<< ${object.dict} /Length ${object.stream.length} >>\nstream\n`, "latin1"),
						object.stream,
						Buffer.from("\nendstream\nendobj\n", "latin1"),
					]);
		parts.push(piece);
		at += piece.length;
	});
	const xref = [
		`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`,
		...offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`),
		`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${at}\n%%EOF\n`,
	].join("");
	parts.push(Buffer.from(xref, "latin1"));
	return Buffer.concat(parts);
}

/** A page of text with `n` lines of enough words to count as text (a scan has none). */
export const textPage = (title: string, n = 3): PdfPage => ({
	lines: [title, ...Array.from({ length: n }, (_, i) => `Line ${i + 1} of ${title}: the quick brown fox jumps.`)],
});

const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

export const wordRun = (text: string) => `<w:r><w:t xml:space="preserve">${text}</w:t></w:r>`;
export const wordPara = (...runs: string[]) => `<w:p><w:pPr><w:jc w:val="left"/></w:pPr>${runs.join("")}</w:p>`;
const cell = (text: string) =>
	`<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${wordPara(wordRun(text))}</w:tc>`;
export const wordTable = (rows: string[][]) =>
	`<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid/>${rows
		.map((r) => `<w:tr>${r.map(cell).join("")}</w:tr>`)
		.join("")}</w:tbl>`;

/** A `.docx` whose body is `body` (the XML inside `<w:body>`). */
export function makeDocx(body: string): Buffer {
	const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${body}<w:sectPr/></w:body></w:document>`;
	return Buffer.from(
		zipSync({
			"[Content_Types].xml": strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'),
			"word/document.xml": strToU8(xml),
		}),
	);
}
