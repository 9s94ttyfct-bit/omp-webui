import { setTimeout as sleep } from "node:timers/promises";
import type { Page } from "@playwright/test";
import type { SocketTap } from "./socket-tap.ts";

/**
 * Main-thread milliseconds per streamed token: a reply of `tokens` words (or whatever `token` makes), one frame each, 16 ms
 * apart, pushed to the page as a live omp would send them. `before` is text the reply already holds when the measuring
 * starts, sent as one frame. What a token costs is read from the page's own main-thread time, so two measurements taken in
 * one page, in one run, compare whatever the machine does.
 */
export async function costPerToken(
	page: Page,
	tap: SocketTap,
	liveId: string,
	tokens: number,
	o: { before?: string; token?: (i: number) => string } = {},
): Promise<number> {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("Performance.enable");
	const busy = async () => {
		const { metrics } = (await cdp.send("Performance.getMetrics")) as { metrics: { name: string; value: number }[] };
		return metrics.find((m) => m.name === "TaskDuration")?.value ?? 0;
	};
	const frame = (f: Record<string, unknown>) => tap.push({ t: "frame", liveId, frame: f });
	const delta = (text: string) =>
		frame({
			type: "message_update",
			messageId: id,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
			message: { role: "assistant" },
		});
	const id = `m-${Math.random()}`;
	frame({ type: "agent_start" });
	frame({ type: "message_start", messageId: id, message: { role: "assistant", content: [] } });
	frame({
		type: "message_update",
		messageId: id,
		assistantMessageEvent: { type: "text_start", contentIndex: 0 },
		message: { role: "assistant" },
	});
	if (o.before) delta(o.before);
	await sleep(o.before ? 1500 : 300);
	const before = await busy();
	for (let i = 0; i < tokens; i++) {
		delta(o.token?.(i) ?? `word${i} `);
		await sleep(16);
	}
	await sleep(300);
	const cost = ((await busy()) - before) * 1000;
	frame({
		type: "message_end",
		messageId: id,
		message: { role: "assistant", content: [{ type: "text", text: "done" }] },
	});
	frame({ type: "agent_end" });
	await cdp.detach();
	return cost / tokens;
}
