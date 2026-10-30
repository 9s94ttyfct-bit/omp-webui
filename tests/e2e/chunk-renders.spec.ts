import { ownSession, startLive } from "../support/live.ts";
import { COUNT_RENDERS, countRendersOf, painted, rendersCounted } from "../support/render-count.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, test } from "./fixtures.ts";

/**
 * What a token of a long answer costs the page: the answer is cut into chunks, and the chunks that are complete are
 * rendered once each — only the chunk that grows is rendered again for every token (#558).
 *
 * What is counted is the renders of the chunk component (`render-count.ts`): the component that takes a chunk's props
 * (its head, its text and whether it is loose), every instance of it in the answer. No model is called: the reply is
 * pushed to the page over its socket.
 */

const item = (i: number) => `- item ${i} with a little text in it, so that the list is long\n`;
const list = (n: number) => Array.from({ length: n }, (_, i) => item(i)).join("");

/** The shapes a long answer comes in: a list, a table, a list of tasks. */
const SHAPES: Record<string, { text: (n: number) => string; element: string }> = {
	"a list": { text: (n) => list(n), element: "li" },
	"a table": {
		text: (n) =>
			`| Name | Code | Count | Link |\n| :--- | --- | ---: | :---: |\n${Array.from({ length: n }, (_, i) => `| row-${i} | \`code ${i}\` | **${i}** | [l${i}](https://example.com/${i}) |`).join("\n")}`,
		element: "td",
	},
	"a list of tasks": {
		text: (n) =>
			Array.from({ length: n }, (_, i) => `- [${i % 3 ? " " : "x"}] item ${i}: **bold** and \`code\``).join("\n"),
		element: "li",
	},
};

for (const [name, shape] of Object.entries(SHAPES)) {
	test(`${name} that streams in: the chunks that cannot change are not rendered again for every token (#558)`, async ({
		page,
	}) => {
		const title = `Chunk renders ${name}`;
		ownSession(0xeb + name.length, title);
		await page.addInitScript(COUNT_RENDERS);
		await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
		const tap = await tapSocket(page);
		await page.goto("/");
		const liveId = await startLive(page, tap, title, `chunk-renders-${name.replace(/\W/g, "")}`);
		const frame = (f: Record<string, unknown>) => tap.push({ t: "frame", liveId, frame: f });
		const event = (type: string, extra: Record<string, unknown> = {}) =>
			frame({
				type: "message_update",
				messageId: "m1",
				message: { role: "assistant" },
				assistantMessageEvent: { type, contentIndex: 0, ...extra },
			});

		frame({ type: "agent_start" });
		frame({ type: "message_start", messageId: "m1", message: { role: "assistant", content: [], timestamp: 5 } });
		event("text_start");
		await painted(page);

		// The answer is written in pieces, as a token comes in.
		const text = shape.text(120);
		for (const piece of [text.slice(0, 3000), text.slice(3000, 6000), text.slice(6000)]) {
			event("text_delta", { delta: piece });
			await painted(page);
		}
		await painted(page);
		await painted(page);
		// The answer is on the page, cut into chunks: the chunk component is there.
		const answer = page.getByTestId("msg-assistant");
		await expect(answer.locator(shape.element).first()).toBeVisible({ timeout: 30_000 });
		await countRendersOf(page, {
			element: `[data-testid='msg-assistant'] ${shape.element}`,
			props: ["head", "text", "loose"],
			within: "[data-testid='msg-assistant']",
		});

		// What the page rendered for the answer so far, and what it renders for the tokens that follow.
		const before = await rendersCounted(page);
		const began = Date.now();
		for (let i = 0; i < 10; i++) {
			event("text_delta", { delta: `- a token ${i}\n` });
			await painted(page);
		}
		const took = Date.now() - began;
		const after = await rendersCounted(page);

		// Ten tokens cost the page no renders of the chunks that cannot change: only the chunk that grows is rendered
		// again. A few are allowed for a chunk that is completed on the way; one chunk rendered for every token is not.
		const grew = after - before;
		console.log(`DIAG ${name}: ten tokens cost ${grew} chunk renders in ${took} ms`);
		expect(grew).toBeLessThanOrEqual(3);
	});
}
