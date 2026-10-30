import { expect, test } from "bun:test";
import { grammarFor, highlightToHtml, MAX_LINE_CHARS } from "../../web/src/lib/highlighter.ts";

/** Code blocks: which grammar a fence names, and the HTML a block turns into (no browser, no WebAssembly). */

test("a fence names a grammar by its own name or a common alias, in any case; anything else is plain text", () => {
	expect(grammarFor("typescript")).toBe("typescript");
	for (const alias of ["ts", "TS", " Ts "]) expect(grammarFor(alias)).toBe("typescript");
	expect(grammarFor("bash")).toBe("shellscript");
	expect(grammarFor("zsh")).toBe("shellscript");
	expect(grammarFor("C++")).toBe("cpp");
	expect(grammarFor("golang")).toBe("go");
	expect(grammarFor("console")).toBe("shellsession");
	expect(grammarFor("yml")).toBe("yaml");
	for (const none of ["", "text", "plaintext", "no-such-language", "constructor", "__proto__", "toString"]) {
		expect(grammarFor(none), none).toBeNull();
	}
});

test("a block comes out coloured with the palette's code variables, with its code escaped", async () => {
	const html = await highlightToHtml("const x: number = 1; // <b>&</b>", "ts");
	expect(html).toStartWith('<pre class="shiki omp"');
	// No colour of its own: each token names a variable palettes.css defines, so one HTML suits every palette and mode.
	expect(html).toContain('<span style="color:var(--shiki-token-keyword)">const</span>');
	expect(html).toContain('<span style="color:var(--shiki-token-comment)">// &#x3C;b>&#x26;&#x3C;/b></span>');
	expect(html).not.toMatch(/#[0-9A-Fa-f]{6}/);
	// More than one colour: the grammar was applied.
	expect(colours(html)).toBeGreaterThan(2);
	expect(html).not.toContain("<b>");
	expect(html).toContain("&#x3C;b>&#x26;&#x3C;/b>");
});

test("a language that is not bundled, or none, is shown as plain themed text", async () => {
	for (const lang of ["text", "no-such-language", ""]) {
		const html = await highlightToHtml("a < b", lang);
		expect(html, lang).toStartWith('<pre class="shiki omp"');
		expect(html, lang).toContain("<span>a &#x3C; b</span>");
		expect(html, lang).not.toContain("<span style=");
	}
});
test("several blocks of one language at once, and one after another, all come out the same", async () => {
	const code = 'def f(x):\n    return "a" + str(x)\n';
	const [a, b, c] = await Promise.all([
		highlightToHtml(code, "py"),
		highlightToHtml(code, "python"),
		highlightToHtml(code, "Python"),
	]);
	expect(b).toBe(a);
	expect(c).toBe(a);
	expect(await highlightToHtml(code, "python")).toBe(a);
	expect(a).toContain("color:var(--shiki-token-");
});

/** How many different token colours (CSS variables) `html` uses. */
const colours = (html: string) => new Set(html.match(/<span style="color:var\(--shiki-[\w-]+\)/g)).size;

test("how a block comes out does not depend on how fast the machine is", async () => {
	// shiki's tokenizer used to give up on a line once 500 ms had passed since it began, and the first line of a
	// grammar pays about 400 ms to compile it: on a busy machine (or a phone) the first block of a language kept
	// only its first word coloured, and the page kept that result. Here the clock is a second further on at every look.
	const now = Date.now;
	let t = now();
	Date.now = () => {
		t += 1000;
		return t;
	};
	try {
		const html = await highlightToHtml("const x: number = 1; // slow machine", "ts");
		expect(colours(html)).toBeGreaterThan(2);
		expect(html).toContain("// slow machine</span>");
	} finally {
		Date.now = now;
	}
});

test("a line of MAX_LINE_CHARS or more is shown as it is, and the lines around it keep their colours", async () => {
	// Tokenising a long string literal takes time quadratic in its length (2,000 characters about 0.4 s), and all of
	// it falls on the one worker that colours every block of the page: past the limit the line is not tokenised.
	const long = `const s = "<${"A".repeat(MAX_LINE_CHARS + 500)}>";`;
	const html = await highlightToHtml(`const a: number = 1;\n${long}\nconst b: number = 2;`, "ts");
	const lines = html.split("\n");
	expect(lines).toHaveLength(3);
	expect(colours(lines[0])).toBeGreaterThan(2);
	expect(colours(lines[2])).toBeGreaterThan(2);
	expect(lines[1]).toBe(`<span class="line"><span>${long.replace("<", "&#x3C;")}</span></span>`);

	// The limit is on the length of the line: one character less is coloured, exactly that long is not.
	const row = (n: number) => `[${"1,".repeat(n)}`.slice(0, n - 1).padEnd(n, "]");
	expect(row(MAX_LINE_CHARS)).toHaveLength(MAX_LINE_CHARS);
	expect(colours(await highlightToHtml(row(MAX_LINE_CHARS - 1), "json"))).toBeGreaterThan(0);
	expect(colours(await highlightToHtml(row(MAX_LINE_CHARS), "json"))).toBe(0);
});
