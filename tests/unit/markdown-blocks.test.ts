import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import type { Block, Blocks } from "../../web/src/components/markdown-blocks.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

// The page's modules read localStorage as they load; another test file's restore may have removed the stubs, so load after putting them back.
installGlobals();
const { Markdown, MarkdownBlock, MarkdownBlocks } = await import("../../web/src/components/Markdown.tsx");
const { SPLIT_MIN_CHARS, splitBlocks, splitStats } = await import("../../web/src/components/markdown-blocks.ts");
const { highlight } = await import("../../web/src/lib/highlight.ts");

/**
 * A long answer renders as top-level blocks so a streamed token parses and renders only the last one. What the blocks
 * render must be what the whole text renders, byte for byte.
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);

/** What the text rendered as before blocks existed: one react-markdown for all of it. */
const whole = (text: string) =>
	renderToString(createElement("div", { className: "prose-omp" }, createElement(MarkdownBlock, { text })));
/** The component, cut into blocks from scratch. */
const blocked = (text: string) => renderToString(createElement(Markdown, { text }));
/** The blocks `splitBlocks` made, rendered. */
const rendered = (s: Blocks) => renderToString(createElement(MarkdownBlocks, { blocks: s.blocks }));
/** The text of a block: Markdown, or a long list, table or quote in chunks (a table's head comes first). */
const textOf = (block: Block): string => (typeof block === "string" ? block : block.head + block.chunks.join(""));
/** `text` as a streaming message has it once it has grown: cut into blocks (a text shown for the first time is one block, never parsed to split it). */
const grown = (text: string) => splitBlocks(text, splitBlocks(text.slice(0, 1)));

/** What a rendering holds, without the element that holds it. */
const inner = (html: string) => html.replace(/^<div class="prose-omp">/, "").replace(/<\/div>$/, "");

/** Raw HTML in the text: react-markdown keeps it as it is, and marks where it is. */
const RAW_HTML = /<!--[\s\S]*?-->|<[A-Za-z!/][^>]*>/;

/**
 * The reference of a streaming text: what it renders as, the way the whole text renders it.
 *
 * The text of a streaming answer only grows at its end, and the blocks before the last one cannot change: the
 * rendering of a block that cannot change is the same at every step, and the rendering of the whole text is the
 * rendering of its blocks one after the other (react-markdown writes the top-level nodes one after the other). So
 * the reference of a step is the reference of each of its blocks — rendered once, and kept while the block is the
 * same — put together.
 *
 * That is what makes a long streaming answer cheap to check: the reference of the whole text would be rendered again
 * at every step, and each of those renders is as long as the text has grown (#555).
 *
 * A text that holds raw HTML is not cut this way: react-markdown marks a raw node with the comment that tells where
 * it is (`<!-- -->`), and the mark of the first one is not the mark of a later one. Such a text is rendered whole, as
 * before.
 */
function keptReference(): { html(blocks: Blocks): string } {
	/** What each block rendered as, as long as the block is the same. */
	const seen = new Map<string, string>();
	/** Whether the text holds raw HTML: the text grows, and only what came in is looked at. */
	let raw = false;
	let rawFrom = 0;
	return {
		html(blocks: Blocks): string {
			if (RAW_HTML.test(blocks.text.slice(rawFrom))) raw = true;
			rawFrom = blocks.text.length;
			if (raw) return whole(blocks.text);
			const parts = blocks.blocks.map((block) => {
				const text = textOf(block);
				const known = seen.get(text);
				if (known !== undefined) return known;
				const html = inner(whole(text));
				seen.set(text, html);
				return html;
			});
			return `<div class="prose-omp">${parts.join("\n")}</div>`;
		},
	};
}

const filler = (n: number) =>
	Array.from(
		{ length: n },
		(_, i) => `Paragraph ${i + 1} of the preface: ${"lorem ipsum dolor sit amet ".repeat(7)}`,
	).join("\n\n");
/** `body` among enough paragraphs to be cut into blocks, before it and after it. */
const long = (body: string) => `${filler(6)}\n\n${body}\n\nThe closing paragraph, after the block.`;

const TS = 'export function add(a: number, b: number): number {\n\treturn a + b; // <b>sum</b>\n}\nconst s = "x" + 1;';
const PY = 'def greet(name):\n    print(f"hello {name}")\n';

const cases: Record<string, string> = {
	"a table, aligned, with inline markup": [
		"| Name | Count | Share |",
		"| :--- | ---: | :---: |",
		"| `alpha` | 12 | **40%** |",
		"| [beta](https://example.com/b) | 7 | *23%* |",
		"| ~~gamma~~ | 11 | 37% |",
	].join("\n"),
	"a table whose next line, with no blank line, is another row":
		"| a | b |\n| - | - |\n| 1 | 2 |\nnot a paragraph: a row",
	"a table cut short while streaming": "| a | b |\n| - |",
	"nested lists, tight and loose, ordered and not": [
		"- one",
		"- two",
		"  1. two.one",
		"  2. two.two",
		"     - deep",
		"",
		"- three, after a blank line",
		"",
		"      indented code inside the item",
		"",
		"3. an ordered list that starts at three",
		"4. four",
	].join("\n"),
	"task lists": "- [x] done\n- [ ] open\n  - [x] nested done",
	"a fenced code block with a language": `\`\`\`ts\n${TS}\n\`\`\``,
	"a fenced code block in a list item, then the list goes on": `1. step\n\n   \`\`\`py\n${PY}   \`\`\`\n\n2. next step`,
	"a tilde fence holding a backtick fence": "~~~md\n```js\nlet x = 1;\n```\n~~~",
	"a code fence with no end (the answer is still streaming)": `\`\`\`ts\n${TS}\n\nstill typing`,
	"an indented code block with blank lines in it": "    first\n\n    second\n\n\n    third",
	"a link reference defined after its use and one defined before": [
		"See [the guide][g], [the faq][faq] and [itself].",
		"",
		"[faq]: https://example.com/faq 'The FAQ'",
		"",
		"Some text in between.",
		"",
		"[g]: <https://example.com/guide>",
		"[itself]: https://example.com/itself",
	].join("\n"),
	"a link used before the paragraph that defines it":
		"A [forward][ref] link.\n\nSomething else.\n\n[ref]: https://example.com/ahead",
	"a definition inside a block quote and inside a list item":
		"> [q]: https://example.com/q\n\n- [i]: https://example.com/i\n\nUse [q] and [i].",
	footnotes:
		"A claim[^1] and another[^note].\n\n[^1]: The first source.\n[^note]: A longer note\n    with a second line.",
	"html blocks, raw and inline":
		'<div class="x">\n  raw <b>html</b>\n\n  after a blank line\n</div>\n\n<!-- a comment\n\nspanning a blank line -->\n\nA paragraph with <span>inline</span> html.',
	"setext headings and rules": "Title\n=====\n\nSubtitle\n--------\n\n---\n\n***\n\nText\n---",
	"block quotes with lazy continuation and nested content":
		"> quote start\ncontinues lazily\n>\n> - list in a quote\n> - another\n>\n> > nested quote",
	"hard breaks, escapes, entities, autolinks":
		"line one  \nline two\\\nline three\n\n\\*not emphasis\\* &amp; &copy; <https://example.com/auto> www.example.com https://example.org/x_y_z.",
	"images, allowed and not": "![ok](/api/files/a.png) ![remote](https://tracker.example/p.gif) ![none]()",
	"math is plain text (no math plugin)": "Inline $a_1 + b_2$ and a block:\n\n$$\n\\int_0^1 x^2 dx\n$$",
	"unsafe links": "[js](javascript:alert(1)) [data](data:text/html;base64,AAAA) [ok](https://example.com)",
	"CRLF line endings":
		"# Title\r\n\r\nA paragraph\r\nwith two lines.\r\n\r\n- a\r\n- b\r\n\r\n```ts\r\nlet x = 1;\r\n```\r\n",
	tabs: "-\ttab list\n\t- nested by tab\n\n\tcode by tab",
	"blank lines at the start and a paragraph with leading spaces":
		"\n\n\n   indented by three spaces\n\n  also indented",
};

describe("rendering in blocks is rendering the whole text", () => {
	beforeAll(async () => {
		// Fenced code is coloured by a worker once it has been asked for; with the colours cached both renders have them.
		await Promise.all([
			highlight(TS, "ts"),
			highlight(`${TS}\n\nstill typing`, "ts"),
			highlight(PY.replace(/\n$/, ""), "py"),
		]);
	});

	for (const [name, body] of Object.entries(cases)) {
		test(name, () => {
			const text = long(body);
			expect(text.length).toBeGreaterThan(SPLIT_MIN_CHARS);
			const split = grown(text);
			// The case is cut into blocks, except where a definition ties the text together.
			if (/^\s*[>-]?\s*\[\^?[\w ]+\]:/m.test(body)) expect(split.blocks).toEqual([text]);
			else expect(split.blocks.length).toBeGreaterThan(3);
			expect(split.blocks.join("")).toBe(text);
			expect(blocked(text)).toBe(whole(text));
			expect(rendered(split)).toBe(whole(text));
		});
	}

	test("code that is coloured stays coloured: the same HTML for the block and for the whole text", () => {
		const text = long(`\`\`\`ts\n${TS}\n\`\`\`\n\nand\n\n\`\`\`py\n${PY}\`\`\``);
		const html = blocked(text);
		expect(html).toContain("shiki");
		expect(html).toBe(whole(text));
	});

	test("short text is one block, and the same markup as before", () => {
		for (const body of Object.values(cases)) {
			expect(splitBlocks(body).blocks).toEqual([body]);
			expect(blocked(body)).toBe(whole(body));
		}
	});

	test("text with no node to render at all, and the empty text", () => {
		for (const text of ["", " ", "\n\n", `${" ".repeat(SPLIT_MIN_CHARS)}\n`, "[x]: https://example.com\n".repeat(80)]) {
			expect(blocked(text)).toBe(whole(text));
		}
	});
});

/** The text of a streaming answer at every step: the same text cut in pieces of about `n` characters. */
function pieces(text: string, n: number): string[] {
	const out: string[] = [];
	for (let i = n; i < text.length + n; i += n) out.push(text.slice(0, Math.min(i, text.length)));
	return out;
}

const everything = Object.entries(cases)
	.filter(([name]) => !/definition|reference|footnote|forward/.test(name))
	.map(([, body]) => body)
	.join("\n\n");

describe("streaming: every step renders as the whole text of that step", () => {
	test("the constructs one after another, a few characters at a time", () => {
		const text = `${filler(3)}\n\n${everything}\n\nEnd.`;
		let prev: Blocks | undefined;
		let steps = 0;
		const reference = keptReference();
		for (const part of pieces(text, 29)) {
			prev = splitBlocks(part, prev);
			steps++;
			if (part.length < SPLIT_MIN_CHARS) continue;
			expect(rendered(prev), `after ${part.length} characters`).toBe(reference.html(prev));
		}
		expect(steps).toBeGreaterThan(40);
		// It got cut up on the way: this is not the whole-text path under another name.
		expect(prev?.blocks.length).toBeGreaterThan(10);
		expect(prev?.whole).toBe(false);
	});

	test("one character at a time across the places where a block can begin or change", () => {
		const text = `${filler(6)}\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n- item\n- item two\n\n    code\n\nPara\n---\n\n> q\n\n\`\`\`ts\nlet a;\n\`\`\`\n\n# Head\n\nend`;
		let prev: Blocks | undefined;
		const reference = keptReference();
		for (let n = SPLIT_MIN_CHARS - 20; n <= text.length; n++) {
			const part = text.slice(0, n);
			prev = splitBlocks(part, prev);
			if (n >= SPLIT_MIN_CHARS) expect(rendered(prev), `after ${n} characters`).toBe(reference.html(prev));
		}
	});

	test("a definition that arrives late changes the blocks before it, so the text goes back to one block", () => {
		const text = `${filler(8)}\n\nA [late][d] link.\n\nMore text, a few paragraphs of it.\n\n[d]: https://example.com/late\n\nAfter it.`;
		let prev: Blocks | undefined;
		let sawBlocks = false;
		const reference = keptReference();
		for (const part of pieces(text, 41)) {
			prev = splitBlocks(part, prev);
			sawBlocks ||= prev.blocks.length > 3;
			expect(rendered(prev)).toBe(reference.html(prev));
		}
		expect(sawBlocks).toBe(true);
		expect(prev?.whole).toBe(true);
		expect(prev?.blocks).toEqual([text]);
		expect(whole(text)).toContain('href="https://example.com/late"');
	});

	test("a definition is seen the moment it is a definition, however slowly its line comes in", () => {
		const def = '[d]: https://example.com/late "A title"';
		// The link is used in a block that is long frozen by the time its definition begins.
		const text = `${filler(3)}\n\nA [late][d] link.\n\n${filler(12)}\n\n${def}\n\nAfter it.`;
		const at = text.indexOf(def);
		let prev: Blocks | undefined;
		// Every 53rd length, and every length from just before the definition to just after it.
		const lengths = new Set<number>([text.length]);
		for (let n = SPLIT_MIN_CHARS; n < text.length; n += 53) lengths.add(n);
		for (let n = at - 6; n < at + def.length + 6; n++) lengths.add(n);
		const reference = keptReference();
		for (const n of [...lengths].sort((a, b) => a - b)) {
			const part = text.slice(0, n);
			prev = splitBlocks(part, prev);
			expect(rendered(prev), `after ${n} characters, …${part.slice(-30)}`).toBe(reference.html(prev));
		}
		expect(prev?.whole).toBe(true);
	});

	test("a block thousands of lines long is not parsed again for every line of it", () => {
		const code = `\`\`\`ts\n${Array.from({ length: 4000 }, (_, i) => `const value${i} = compute(${i}, "text ${i}");`).join("\n")}\n\`\`\``;
		const start = splitStats.parsedChars;
		let prev: Blocks | undefined;
		for (const part of pieces(`${filler(3)}\n\n${code}`, 60)) prev = splitBlocks(part, prev);
		const parsed = splitStats.parsedChars - start;
		const length = prev?.text.length ?? 0;
		expect(length).toBeGreaterThan(100_000);
		// Parsing again at every line would parse the block (up to 150 KB) thousands of times: some 100 MB. Here: a few times the text.
		expect(parsed).toBeLessThan(8 * length);
		expect(textOf(prev?.blocks.at(-1) ?? "").startsWith("```ts\n")).toBe(true);
	});

	test("randomly assembled Markdown, cut at random places", () => {
		const rng = mulberry32(268);
		const parts = [
			...Object.entries(cases)
				.filter(([name]) => !/CRLF/.test(name))
				.map(([, body]) => body),
			"Para\ncontinued\n",
			"1. a\n2. b\n   - c\n",
			"* x\n\n  y\n\n* z",
			"| h |\n| - |\n| c |",
			"<details>\n<summary>s</summary>\n\nbody\n\n</details>",
			"---",
			"Setext\n===",
			"    indented",
			"> a\n> b",
			"`inline` and **strong** and *em*",
			"text",
			"",
		];
		for (let doc = 0; doc < 14; doc++) {
			const body = Array.from(
				{ length: 14 + Math.floor(rng() * 8) },
				() => parts[Math.floor(rng() * parts.length)],
			).join(rng() < 0.7 ? "\n\n" : "\n");
			const text = `${filler(2)}\n\n${body}`;
			let prev: Blocks | undefined;
			const cuts = Array.from(
				{ length: 10 },
				() => SPLIT_MIN_CHARS + Math.floor(rng() * (text.length - SPLIT_MIN_CHARS + 1)),
			)
				.concat(text.length)
				.sort((a, b) => a - b);
			const reference = keptReference();
			for (const n of cuts) {
				const part = text.slice(0, n);
				prev = splitBlocks(part, prev);
				expect(rendered(prev), `document ${doc}, ${n} characters\n${part.slice(-300)}`).toBe(reference.html(prev));
			}
		}
	});
});

/** A small seeded generator: the same documents on every run. */
function mulberry32(seed: number): () => number {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** A ~45 KB answer: headings, paragraphs, lists, a table and fenced code, over and over. */
function answer(target = 45_000): string {
	const para = (i: number) =>
		`Section ${i} explains how the **scheduler** hands work to \`workers\` (see [the docs](https://example.com/docs/${i})). When a worker fails, the *supervisor* restarts it with backoff, and the job returns to the queue so nothing is lost.`;
	const list = (i: number) =>
		`- Step ${i}.1: read the config\n- Step ${i}.2: validate it\n  1. metrics\n  2. admin socket\n- Step ${i}.3: start`;
	const table = (i: number) =>
		`| Run ${i} | Workers | p50 |\n| --- | ---: | ---: |\n${Array.from({ length: 6 }, (_, r) => `| batch-${r} | ${r + 1} | ${12 + r} |`).join("\n")}`;
	const code = (i: number) =>
		`\`\`\`ts\nexport async function run${i}(queue: Queue): Promise<void> {\n\tfor await (const job of queue) await job.run();\n}\n\`\`\``;
	const out: string[] = [];
	for (let i = 1, len = 0; len < target; i++) {
		for (const b of [
			`## Part ${i}`,
			para(i),
			list(i),
			para(i + 100),
			table(i),
			code(i),
			`> **Note ${i}:** retried ten times, then parked.`,
		]) {
			out.push(b);
			len += b.length + 2;
		}
	}
	return out.join("\n\n");
}

describe("streaming a long answer: only the end is worked on", () => {
	const text = answer();
	const steps = pieces(text, 25);

	test("the blocks before the last are the same text at every step, and the text is the whole answer at the end", () => {
		let prev: Blocks | undefined;
		let changed = 0;
		for (const part of steps) {
			const next = splitBlocks(part, prev);
			expect(next.blocks.map(textOf).join("")).toBe(part);
			if (prev?.parsed) {
				// Everything a block ahead of the frozen ones could have changed is still what it was.
				for (let i = 0; i < prev.frozen; i++) expect(next.blocks[i]).toBe(prev.blocks[i]);
				// So a step renders at most the blocks from the last frozen one on: the ones that were being written, and the new one.
				for (let i = prev.frozen; i < next.blocks.length; i++) changed += next.blocks[i] === prev.blocks[i] ? 0 : 1;
			}
			prev = next;
		}
		expect(prev?.blocks.length).toBeGreaterThan(100);
		// Rendering each step whole costs one block per block there is, per step: tens of thousands in all. Here:
		// the last block per step, and one more each time a block ends.
		expect(changed).toBeLessThan(steps.length * 2 + (prev?.blocks.length ?? 0));
	});

	test("each step parses the end of the answer, not all of it", () => {
		let prev: Blocks | undefined;
		const parsed: number[] = [];
		let longest = 0;
		for (const part of steps) {
			const before = splitStats.parsedChars;
			prev = splitBlocks(part, prev);
			if (part.length > 5000) parsed.push(splitStats.parsedChars - before);
		}
		for (const b of prev?.blocks ?? []) longest = Math.max(longest, textOf(b).length);
		expect(longest).toBeLessThan(1500);
		// The most any step parsed is the end of the answer (a block, and what came in since the last parse), not the 45 KB there were by then.
		expect(Math.max(...parsed)).toBeLessThanOrEqual(3 * longest);
		expect(Math.max(...parsed)).toBeLessThan(text.length / 20);
		const total = parsed.reduce((a, b) => a + b, 0);
		expect(total).toBeLessThan(steps.length * longest);
	});

	test("text added within the last line is not parsed at all", () => {
		let prev = grown(text.slice(0, 20_000));
		prev = splitBlocks(text.slice(0, 20_100), prev);
		const before = splitStats.parses;
		// The next 10 characters hold no line break.
		const next = text.slice(0, 20_110);
		expect(next.slice(20_100)).not.toContain("\n");
		splitBlocks(next, prev);
		expect(splitStats.parses).toBe(before);
	});

	test("a message shown for the first time is not parsed to split it; once it grows it is, from the top, once", () => {
		const before = splitStats.parses;
		const first = splitBlocks(text.slice(0, 30_000));
		expect(first.blocks).toEqual([text.slice(0, 30_000)]);
		expect(blocked(text.slice(0, 30_000))).toBe(whole(text.slice(0, 30_000)));
		expect(splitStats.parses).toBe(before);
		const next = splitBlocks(text.slice(0, 30_040), first);
		expect(splitStats.parses).toBe(before + 1);
		expect(next.blocks.length).toBeGreaterThan(50);
		expect(rendered(next)).toBe(whole(text.slice(0, 30_040)));
	});

	test("text that does not continue the one before is a new text: one block, cut again once it grows", () => {
		const a = grown(text.slice(0, 30_000));
		expect(a.blocks.length).toBeGreaterThan(50);
		const edited = `${text.slice(0, 29_000)}\n\nA replacement for the rest.`;
		const b = splitBlocks(edited, a);
		expect(b.blocks).toEqual([edited]);
		const grew = `${edited}\n\nAnd a little more.\n\nAnd more.`;
		const c = splitBlocks(grew, b);
		expect(c.blocks.length).toBeGreaterThan(50);
		expect(c.blocks.join("")).toBe(grew);
		expect(rendered(c)).toBe(whole(grew));
	});

	test("the finished answer renders as the whole text does", () => {
		let prev: Blocks | undefined;
		for (const part of steps) prev = splitBlocks(part, prev);
		expect(prev?.text).toBe(text);
		expect(rendered(prev as Blocks)).toBe(whole(text));
		expect(blocked(text)).toBe(whole(text));
	});
});

/** `n` lines made by `line`. */
const lines = (n: number, line: (i: number) => string, sep = "\n") =>
	Array.from({ length: n }, (_, i) => line(i)).join(sep);
const prose = (i: number) => `item ${i}: **bold** and \`code\`, see [the docs](https://e.com/${i}) and ~~old~~`;
const cell = (i: number, c: number) =>
	c === 0 ? `row-${i}` : c === 1 ? `\`code ${i}\`` : c === 2 ? `**${i}**` : `[l${i}](https://example.com/${i})`;
const tableRow = (i: number) => `| ${[0, 1, 2, 3].map((c) => cell(i, c)).join(" | ")} |`;
const TABLE_HEAD = "| Name | Code | Count | Link |\n| :--- | --- | ---: | :---: |";

/** Lists, tables and quotes long enough to be cut in chunks while they stream, in the shapes that make a chunk read differently from the whole. */
const groupCases: Record<string, string> = {
	"a bullet list": lines(70, (i) => `- ${prose(i)}`),
	"an ordered list that starts at 7": lines(70, (i) => `${7 + i}. ${prose(i)}`),
	"an ordered list numbered 1. throughout": lines(70, (i) => `1. ${prose(i)}`),
	"a loose list": lines(55, (i) => `- ${prose(i)}`, "\n\n"),
	"a list that turns loose after chunks were complete": `${lines(60, (i) => `- ${prose(i)}`)}\n\n- the item after a blank line\n- and another\n- and one more`,
	"a list that turns loose by an item of two paragraphs": `${lines(60, (i) => `- ${prose(i)}`)}\n- an item\n\n  of two paragraphs\n- and a tight one`,
	"a list that gets its first checkbox late": `${lines(60, (i) => `- ${prose(i)}`)}\n- [x] done\n- [ ] open\n- plain again`,
	"a task list": lines(60, (i) => `- [${i % 3 ? " " : "x"}] ${prose(i)}`),
	"items that hold nested lists and a second line": lines(
		40,
		(i) => `- ${prose(i)}\ncontinued lazily ${i}\n  - nested a ${i}\n  - nested b\n    1. deep ${i}\n    2. deeper`,
	),
	"items indented by one to three spaces": lines(50, (i) => `${" ".repeat(1 + (i % 3))}- ${prose(i)}`),
	"an item holding indented code, and a block quote": lines(
		30,
		(i) => `- ${prose(i)}\n\n      code ${i}\n\n  > quoted ${i}\n`,
		"\n",
	),
	"a list with an empty item and a number past nine": `${lines(9, (i) => `${i + 1}. ${prose(i)}`)}\n10.\n11. ${prose(11)}\n${lines(40, (i) => `${i + 12}. ${prose(i)}`)}`,
	"a list that ends in a paragraph": `${lines(60, (i) => `- ${prose(i)}`)}\n\nAfter the list: *a paragraph*.\n\n- a second, short list\n- ends`,
	"a list that ends in a heading that follows with no blank line": `${lines(60, (i) => `- ${prose(i)}`)}\n# Heading right after\ntext`,
	"two lists of different markers one after the other": `${lines(40, (i) => `- ${prose(i)}`)}\n\n${lines(40, (i) => `* ${prose(i)}`)}`,
	"a list of CRLF lines": `${lines(70, (i) => `- ${prose(i)}`, "\r\n")}\r\n\r\ntext`,
	"a table": `${TABLE_HEAD}\n${lines(100, tableRow)}`,
	"a table with short and long rows and an escaped pipe": `${TABLE_HEAD}\n${lines(80, (i) => (i % 3 === 0 ? `| only ${i} |` : i % 3 === 1 ? `${tableRow(i)} extra | cells |` : `| a \\| b ${i} | \`x | y\` | ${i} | z |`))}`,
	"a table that goes on in lines with no pipe, then a paragraph": `${TABLE_HEAD}\n${lines(90, tableRow)}\nno pipe: still a row\n\nA paragraph.`,
	"a table indented by two spaces, in CRLF": `  ${TABLE_HEAD.replace("\n", "\r\n  ")}\r\n${lines(90, (i) => `  ${tableRow(i)}`, "\r\n")}\r\n`,
	"a table that a heading ends": `${TABLE_HEAD}\n${lines(90, tableRow)}\n## Heading\n\n${TABLE_HEAD}\n| after | 1 | 2 | 3 |`,
	"a block quote of paragraphs and lists": lines(40, (i) => `> ${prose(i)}\n>\n> - point ${i}\n> - another\n>`),
	"a block quote with lazy continuation and nested quotes": lines(
		40,
		(i) => `> ${prose(i)}\nlazy line ${i}\n>\n> > nested ${i}\n> > more`,
	),
};

/**
 * `text` streamed in pieces of `n` characters, each one cut into blocks from the one before. Every `every`th step (and
 * the last) must render as the whole text of that step does.
 */
function stream(text: string, n: number, every = 1): { last: Blocks; groups: number } {
	let prev: Blocks | undefined;
	let groups = 0;
	const parts = pieces(text, n);
	// The reference of the text: what it renders as, the way the whole text renders it (see `keptReference`).
	const reference = keptReference();
	for (const [step, part] of parts.entries()) {
		prev = splitBlocks(part, prev);
		if (part.length < SPLIT_MIN_CHARS) continue;
		if (typeof prev.blocks.at(-1) === "object") groups++;
		if (step % every === 0 || step === parts.length - 1)
			expect(rendered(prev), `after ${part.length} characters, …${part.slice(-120)}`).toBe(reference.html(prev));
	}
	return { last: prev as Blocks, groups };
}

describe("a long list, table or quote streams in chunks", () => {
	beforeAll(async () => {
		await Promise.all([highlight(TS, "ts"), highlight(`${TS}\n\nstill typing`, "ts")]);
	});

	for (const [name, body] of Object.entries(groupCases)) {
		test(`${name}: every step renders as the whole text, and the chunks are what rendered it`, () => {
			const text = `${filler(6)}\n\n${body}\n\nThe closing paragraph, after the block.`;
			const { last, groups } = stream(text, 223);
			expect(groups).toBeGreaterThan(3);
			expect(last.text).toBe(text);
			expect(blocked(text)).toBe(whole(text));
			expect(rendered(last)).toBe(whole(text));
			const group = last.blocks.find((b) => typeof b === "object");
			expect((group?.chunks.length ?? 0) > 2, "cut in chunks").toBe(true);
			expect(last.blocks.map(textOf).join("")).toBe(text);
		});
	}

	test("the constructs one after another, with a few characters at a time", () => {
		const text = `${filler(3)}\n\n${Object.values(groupCases)
			.filter((b, i) => i % 2 === 0 && !b.includes("\r"))
			.join("\n\n")}\n\nEnd.`;
		const { last, groups } = stream(text, 211, 10);
		expect(groups).toBeGreaterThan(20);
		expect(last.blocks.filter((b) => typeof b === "object").length).toBeGreaterThan(6);
	});

	test("one character at a time across the places where a chunk ends, a list turns loose and a checkbox comes", () => {
		const text = `${filler(6)}\n\n${lines(24, (i) => `- ${prose(i)}`)}\n\n- loose after a blank\n- [x] a task\n- tail\n\n${TABLE_HEAD}\n${lines(24, tableRow)}\n\n> quote\n\nend`;
		// Every length within a few characters of a place where something changes, and every 97th length elsewhere.
		const lengths = new Set<number>([text.length]);
		for (let n = SPLIT_MIN_CHARS; n < text.length; n += 97) lengths.add(n);
		for (const marker of ["\n\n- loose", "- [x] a task", "- tail", TABLE_HEAD, "\n\n> quote", "- item 20:"]) {
			const at = text.indexOf(marker);
			for (let n = at - 4; n < at + marker.length + 4; n++) lengths.add(n);
		}
		let prev: Blocks | undefined;
		const reference = keptReference();
		for (let n = SPLIT_MIN_CHARS - 20; n <= text.length; n++) {
			const part = text.slice(0, n);
			prev = splitBlocks(part, prev);
			if (lengths.has(n))
				expect(rendered(prev), `after ${n} characters, …${part.slice(-60)}`).toBe(reference.html(prev));
		}
	});

	test("randomly assembled Markdown with long lists and tables, cut at random places", () => {
		const rng = mulberry32(429);
		const parts = [
			...Object.values(groupCases).filter((b) => !b.includes("\r")),
			"Para\ncontinued\n",
			"1. a\n2. b\n   - c\n",
			"| h |\n| - |\n| c |",
			"---",
			"> a\n> b",
			"text",
			"",
		];
		for (let doc = 0; doc < 4; doc++) {
			const body = Array.from(
				{ length: 4 + Math.floor(rng() * 3) },
				() => parts[Math.floor(rng() * parts.length)],
			).join(rng() < 0.7 ? "\n\n" : "\n");
			const text = `${filler(2)}\n\n${body}`;
			let prev: Blocks | undefined;
			const cuts = Array.from(
				{ length: 14 },
				() => SPLIT_MIN_CHARS + Math.floor(rng() * (text.length - SPLIT_MIN_CHARS + 1)),
			)
				.concat(text.length)
				.sort((a, b) => a - b);
			const reference = keptReference();
			for (const n of cuts) {
				const part = text.slice(0, n);
				prev = splitBlocks(part, prev);
				expect(rendered(prev), `document ${doc}, ${n} characters\n${part.slice(-300)}`).toBe(reference.html(prev));
			}
		}
	});

	test("a definition that arrives while a list is in chunks takes the text back to one block", () => {
		const text = `${filler(3)}\n\n${lines(60, (i) => `- ${prose(i)}`)}\n\nSee [the late one][d].\n\n[d]: https://example.com/late\n\nAfter.`;
		const { last, groups } = stream(text, 61);
		expect(groups).toBeGreaterThan(3);
		expect(last.whole).toBe(true);
		expect(last.blocks).toEqual([text]);
	});
});

/** What react-markdown is handed when `next` replaces `prev` on the page: every block, chunk and last chunk that React does not skip because its text is what it was. */
function handed(prev: Blocks | undefined, next: Blocks): number {
	let chars = 0;
	next.blocks.forEach((block, i) => {
		const before = prev?.blocks[i];
		if (block === before) return;
		if (typeof block === "string") {
			chars += block.length;
			return;
		}
		const was = typeof before === "object" ? before : undefined;
		const rest = block.chunks.length - 1;
		chars += block.head.length + block.chunks[rest].length;
		for (let c = 0; c < rest; c++) {
			if (was?.chunks[c] !== block.chunks[c] || was.loose !== block.loose)
				chars += block.head.length + block.chunks[c].length;
		}
	});
	return chars;
}

describe("streaming a long list or table: only the end is worked on", () => {
	const bullets = `${filler(3)}\n\n${lines(2000, (i) => `- ${prose(i)}`)}`;
	const rows = `${filler(3)}\n\n${TABLE_HEAD}\n${lines(1500, tableRow)}`;
	const quote = `${filler(3)}\n\n${lines(1200, (i) => `> ${prose(i)}\n>`)}`;
	const quoted = `${filler(3)}\n\n${lines(900, (i) => `- ${prose(i)}\n\n  second paragraph of ${i}`, "\n\n")}`;

	for (const [name, text] of Object.entries({ bullets, rows, quote, "a loose list": quoted })) {
		test(`${name}: what a step has react-markdown render does not grow with the text`, () => {
			let prev: Blocks | undefined;
			let total = 0;
			let worst = 0;
			let parsed = 0;
			let steps = 0;
			for (const part of pieces(text, 50)) {
				const before = splitStats.parsedChars;
				const next = splitBlocks(part, prev);
				if (part.length > 30_000) {
					const work = handed(prev, next);
					total += work;
					worst = Math.max(worst, work);
					parsed += splitStats.parsedChars - before;
					steps++;
				}
				prev = next;
			}
			expect(prev?.text.length).toBeGreaterThan(60_000);
			// Rendering the whole list at every step is the text so far, per step: ~100 KB each, thousands of steps. Here a step
			// is the chunk being written and the chunk that has just been completed, and the text a step parsed is no more.
			expect(worst).toBeLessThan(8 * 1024);
			expect(total / steps).toBeLessThan(3 * 1024);
			expect(parsed / steps).toBeLessThan(3 * 1024);
			expect(typeof prev?.blocks.at(-1)).toBe("object");
		});
	}

	test("the chunks before the last one are never changed by the text that follows", () => {
		let prev: Blocks | undefined;
		for (const part of pieces(bullets, 97)) {
			const next = splitBlocks(part, prev);
			const was = prev?.blocks.at(-1);
			const is = next.blocks.at(-1);
			if (typeof was === "object" && typeof is === "object") {
				for (let c = 0; c < was.chunks.length - 1; c++) expect(is.chunks[c]).toBe(was.chunks[c]);
			}
			prev = next;
		}
	});
});
