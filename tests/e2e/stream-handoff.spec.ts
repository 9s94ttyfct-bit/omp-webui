import { ownSession, startLive } from "../support/live.ts";
import { type Command, tapSocket } from "../support/socket-tap.ts";
import { expect, test } from "./fixtures.ts";

/**
 * A message streams as a live row and, when omp saves it, is a row of the saved transcript. It is one message to the
 * reader: the row must not be torn down and drawn again (the text fades in from nothing, a thinking block opened by
 * hand closes). Frames are injected and the entries answered by the spec: no model runs.
 */

const ANSWER = "The answer is forty-two, as the handoff probe shows.";

test("the row that streamed is the row that is saved: same element, never faded, thinking still open", async ({
	page,
}) => {
	const title = "Stream handoff probe";
	ownSession(0x91, title);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, title, "handoff-probe");
	const frame = (f: Record<string, unknown>) => tap.push({ t: "frame", liveId, frame: f });

	// omp's side: the prompt is saved first, the answer when its message ends.
	const stamp = Date.now();
	const message = (role: string, content: unknown[], extra: Record<string, unknown> = {}) => ({
		role,
		content,
		timestamp: stamp,
		...extra,
	});
	const answer = message(
		"assistant",
		[
			{ type: "thinking", thinking: "Weighing the question." },
			{ type: "text", text: ANSWER },
		],
		{
			provider: "anthropic",
			model: "claude-haiku-5-5",
			stopReason: "stop",
		},
	);
	let released = 0;
	let base: string | null = null;
	const entry = (id: string, parentId: string | null, m: Record<string, unknown>) => ({
		type: "message",
		id,
		parentId,
		timestamp: new Date(stamp).toISOString(),
		message: m,
	});
	tap.answer("get_entries", (command: Command) => {
		if (!released) return undefined;
		const since = typeof command.since === "string" ? command.since : null;
		const user = entry("handoff-user", base ?? since, {
			role: "user",
			content: [{ type: "text", text: "What is the answer?" }],
			attribution: "user",
			timestamp: stamp - 1,
		});
		base ??= since;
		const saved = [user, ...(released > 1 ? [entry("handoff-asst", "handoff-user", answer)] : [])];
		const from = saved.findIndex((e) => e.id === since) + 1;
		return { ok: true, data: { entries: saved.slice(from), leafId: saved.at(-1)?.id } };
	});

	// The prompt is saved, then the answer starts to stream.
	frame({ type: "agent_start" });
	released = 1;
	frame({
		type: "message_end",
		messageId: "m-user",
		message: message("user", [{ type: "text", text: "What is the answer?" }]),
	});
	await expect(page.getByText("What is the answer?")).toBeVisible();
	frame({ type: "message_start", messageId: "m-handoff", message: { ...answer, stopReason: undefined } });
	const row = page.locator('[data-testid="msg-assistant"]', { hasText: ANSWER });
	await expect(row).toHaveCount(1);
	await expect(row).not.toHaveAttribute("data-entry-id", /./);
	// Past its fade-in, the reader opens the thinking block by hand and the row is marked.
	await expect.poll(() => row.evaluate((el) => getComputedStyle(el).opacity)).toBe("1");
	const thinking = row.getByTestId("thinking").getByRole("button");
	await thinking.click();
	await expect(thinking).toHaveAttribute("aria-expanded", "true");
	await row.evaluate((el) => {
		Reflect.set(el, "__streamed", true);
		// What every frame shows of the message: how faint it gets, and the frames it is not on the page at all.
		const seen = { lowest: 1, gone: 0 };
		Reflect.set(window, "__handoff", seen);
		const sample = () => {
			const shown = [...document.querySelectorAll('[data-testid="msg-assistant"]')].find((n) =>
				n.textContent?.includes("as the handoff probe shows"),
			);
			if (!shown) seen.gone++;
			else seen.lowest = Math.min(seen.lowest, Number(getComputedStyle(shown).opacity));
			requestAnimationFrame(sample);
		};
		requestAnimationFrame(sample);
	});

	// omp saves the message and the stream ends.
	released = 2;
	frame({ type: "message_end", messageId: "m-handoff", message: answer });
	const saved = page.locator('[data-testid="msg-assistant"][data-entry-id="handoff-asst"]');
	await expect(saved).toHaveCount(1);
	await page.waitForTimeout(500);

	// The same element now shows the saved entry: it never left the page, never faded, and what the reader opened is open.
	expect(await saved.evaluate((el) => Reflect.get(el, "__streamed"))).toBe(true);
	expect(await page.evaluate(() => Reflect.get(window, "__handoff"))).toEqual({ lowest: 1, gone: 0 });
	await expect(saved.getByTestId("thinking").getByRole("button")).toHaveAttribute("aria-expanded", "true");
	await expect(saved.getByText("Weighing the question.")).toBeVisible();
	await expect(page.locator('[data-testid="msg-assistant"]', { hasText: ANSWER })).toHaveCount(1);
});
