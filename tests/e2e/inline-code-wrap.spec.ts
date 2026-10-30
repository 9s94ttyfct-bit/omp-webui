import { rmSync } from "node:fs";
import { writeChatSession } from "../support/chat-session.ts";
import { distance, pixelsAt } from "../support/pixels.ts";
import { expect, test } from "./fixtures.ts";

/**
 * A code span that does not fit on one line breaks like words do. Each line of it is its own box: with the default
 * `box-decoration-break: slice` the first line ended with no border and no padding and the next began without them, so
 * the span looked torn and its text touched the edge. Read from the pixels the page paints, not from the stylesheet.
 * No model call.
 */

const SPAN =
	"429 Too Many Requests and a Retry-After header that a client must honour before it sends the same request again";

test("inline code that wraps is boxed on every line", async ({ page }) => {
	const agentDir = process.env.OMPW_E2E_AGENT_DIR as string;
	const file = writeChatSession(agentDir, {
		n: 0x41,
		title: "Wrapped inline code",
		turns: [{ prompt: "What does the limiter answer?", reply: `The limiter answers \`${SPAN}\` and nothing else.` }],
	});
	try {
		await page.setViewportSize({ width: 760, height: 800 });
		await page.goto(`/#/s/${encodeURIComponent(file)}`);
		const code = page.getByTestId("msg-assistant").locator(".prose-omp code").first();
		await expect(code).toHaveText(SPAN);
		await code.scrollIntoViewIfNeeded();

		const { lines, border } = await code.evaluate((el) => ({
			lines: [...el.getClientRects()].map((r) => ({ left: r.left, right: r.right, top: r.top, height: r.height })),
			border: getComputedStyle(el).borderTopColor,
		}));
		// The span must really wrap for this to say anything.
		expect(lines.length).toBeGreaterThanOrEqual(2);
		const rgb = /^rgba?\((\d+), (\d+), (\d+)/.exec(border);
		expect(rgb, `the border colour is plain rgb(), not ${border}`).not.toBeNull();
		const edge = { r: Number(rgb?.[1]), g: Number(rgb?.[2]), b: Number(rgb?.[3]) };

		// Every line's two ends, each looked at over its two outermost pixel columns (the border is one pixel wide and
		// may land on either of two columns): the border's colour is in them.
		const points = lines.flatMap((l) => {
			const y = l.top + l.height / 2;
			return [
				[Math.floor(l.left), Math.floor(l.left) + 1],
				[Math.ceil(l.right) - 2, Math.ceil(l.right) - 1],
			].map((xs) => xs.map((x) => ({ x, y })));
		});
		const png = await page.screenshot();
		const seen = await pixelsAt(page, png, points.flat());
		points.forEach((pair, i) => {
			const near = Math.min(...pair.map((_, j) => distance(seen[i * 2 + j], edge)));
			const where = `${i % 2 === 0 ? "left" : "right"} end of line ${Math.floor(i / 2) + 1}`;
			expect(near, `the border is painted at the ${where}`).toBeLessThanOrEqual(6);
		});

		// Wherever the line breaks, a line of the span stays inside its paragraph's box: Chromium leaves the cloned end
		// padding and border out of where it breaks, and the box stuck out by them past the column, where its right border
		// was cut off (Linux's face did it at 760px, a Mac's at other widths). Every width from 300 to 760 px, set on the
		// Markdown block itself.
		const sticksOut = await code.evaluate((el) => {
			const prose = el.closest<HTMLElement>(".prose-omp");
			if (!prose) return ["no .prose-omp"];
			const found: string[] = [];
			for (let width = 300; width <= 760; width++) {
				prose.style.width = `${width}px`;
				const edge = prose.getBoundingClientRect().right;
				const right = Math.max(...[...el.getClientRects()].map((r) => r.right));
				if (right > edge + 0.05) found.push(`${width}px: ${(right - edge).toFixed(2)}px`);
			}
			prose.style.width = "";
			return found;
		});
		expect(sticksOut).toEqual([]);
	} finally {
		rmSync(file, { force: true });
	}
});
