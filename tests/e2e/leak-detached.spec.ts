import type { CDPSession, Page } from "@playwright/test";
import { ownSession, startLive } from "../support/live.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, test } from "./fixtures.ts";

/**
 * The page must not keep what it has shown: opening and closing conversations, the agents panel, the search and the
 * usage page again and again must not leave detached DOM nodes or event listeners behind. A removed view that is still
 * referenced is a view that is never collected, so the page's memory grows with what the user has merely looked at.
 *
 * The conversation is a real one (a live omp process), because a view that is torn down with its process behind it is
 * the case that leaks; a file read from disk is only ever drawn.
 *
 * Everything is done inside the page (no locator round trip), so the measurement is the page's own and not the test
 * driver's: Playwright's accessibility snapshots cache the nodes they look at, which would count as a leak that is
 * not the app's. The counts come from the browser alone: the nodes it still holds after a collection, and the event
 * listeners it still has.
 */

/** What the page holds: the nodes it counts minus the ones the document has, and the listeners it has. */
interface Counts {
	/** Nodes the browser still counts although the document no longer holds them. */
	detached: number;
	/** The event listeners the page has. */
	listeners: number;
}

/** Collect what the browser has not collected yet, and count what is left. */
async function counts(page: Page, cdp: CDPSession): Promise<Counts> {
	// The same view every time: what the user happened to be looking at would move the figures.
	await page.evaluate(() => {
		location.hash = "#/settings";
	});
	await page.getByTestId("settings-page").waitFor();
	await page.waitForTimeout(200);
	// Garbage the browser has not collected yet is not a leak: collect until the count stops moving.
	let detached = -1;
	let listeners = -1;
	let settled = 0;
	for (let i = 0; i < 10 && settled < 2; i++) {
		await cdp.send("HeapProfiler.collectGarbage");
		await page.waitForTimeout(150);
		const counters = (await cdp.send("Memory.getDOMCounters")) as {
			nodes: number;
			jsEventListeners: number;
		};
		const inDocument = await page.evaluate(() => {
			let all = 1; // the document itself
			const walker = document.createTreeWalker(document, NodeFilter.SHOW_ALL);
			while (walker.nextNode()) all++;
			return all;
		});
		const nextDetached = Math.max(0, counters.nodes - inDocument);
		if (nextDetached === detached && counters.jsEventListeners === listeners) settled++;
		else settled = 0;
		detached = nextDetached;
		listeners = counters.jsEventListeners;
	}
	return { detached, listeners };
}

test("the page keeps no detached DOM nodes or listeners as conversations and views are opened and closed", async ({
	page,
}) => {
	const cdp = await page.context().newCDPSession(page);
	const tap = await tapSocket(page);
	const title = "Leak probe conversation";
	ownSession(0xee, title);

	await page.goto("/");
	await expect(page.getByTestId("session-list")).toBeVisible();
	// A real conversation: a live omp process behind it, which is what the page tears down and rebuilds.
	await startLive(page, tap, title, "leak-probe");
	// The conversation's file, to open it again by name.
	const file = await page.evaluate(async () => {
		const res = await fetch("/api/sessions");
		const answer = (await res.json()) as { file: string; title: string }[];
		return answer.find((s) => s.title === "Leak probe conversation")?.file ?? "";
	});
	expect(file).not.toBe("");

	/** One round: the conversation, the panel, the search and the usage page, opened and closed again. */
	const round = async () => {
		await page.evaluate(async () => {
			// The panel, opened and closed.
			const toggle = document.querySelector<HTMLElement>('[data-testid="toggle-panel"]');
			if (toggle) {
				toggle.click();
				await new Promise((r) => setTimeout(r, 250));
				const close = document.querySelector<HTMLElement>('[data-testid="right-panel-close"]');
				if (close) close.click();
				await new Promise((r) => setTimeout(r, 250));
			}
			// The search, opened and closed.
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, ctrlKey: true, bubbles: true }));
			await new Promise((r) => setTimeout(r, 250));
			const input = document.querySelector<HTMLElement>("[cmdk-input]");
			if (input) {
				input.focus();
				input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
			}
			await new Promise((r) => setTimeout(r, 250));
			// The usage page.
			location.hash = "#/usage";
			await new Promise((r) => setTimeout(r, 400));
		});
		// Back to the conversation: it is what the round is about.
		await page.evaluate((file) => {
			location.hash = `#/s/${encodeURIComponent(file)}`;
		}, file);
		await expect(page.getByTestId("chat-title")).toBeVisible();
		await page.waitForTimeout(300);
	};

	// The first rounds warm the page up (the chunks are loaded, the conversation is read); what is measured is what
	// happens after that: the same actions must not leave more behind.
	await round();
	await round();
	const warm = await counts(page, cdp);

	await round();
	await round();
	const after = await counts(page, cdp);

	expect(
		after.detached,
		`detached nodes grew from ${warm.detached} to ${after.detached} after two more rounds`,
	).toBeLessThanOrEqual(warm.detached + 50);
	expect(
		after.listeners,
		`event listeners grew from ${warm.listeners} to ${after.listeners} after two more rounds`,
	).toBeLessThanOrEqual(warm.listeners + 10);
});

test("a conversation the user has left is let go of, even when the page remembered what had focus", async ({
	page,
}) => {
	const cdp = await page.context().newCDPSession(page);
	const title = "Leak probe conversation";
	ownSession(0xef, title);

	await page.goto("/");
	await expect(page.getByTestId("session-list")).toBeVisible();
	// A conversation of the spec's own, read from disk: what is measured is the page's own bookkeeping.
	await page.evaluate(async (t) => {
		const res = await fetch("/api/sessions");
		const answer = (await res.json()) as { file: string; title: string }[];
		const found = answer.find((s) => s.title === t);
		if (found) location.hash = `#/s/${encodeURIComponent(found.file)}`;
	}, title);
	await expect(page.getByTestId("chat-title")).toBeVisible();
	await page.waitForTimeout(500);

	// The conversation, with the composer focused: the page remembers what had focus, to give it back to a dialog
	// that opens with a field of its own. Remembering it must not keep the whole conversation alive.
	await page.getByTestId("composer").focus();
	await page.waitForTimeout(200);
	await page.evaluate(() => {
		const w = window as unknown as { __ref?: WeakRef<Element> };
		const composer = document.querySelector('[data-testid="composer"]');
		if (composer) w.__ref = new WeakRef(composer);
	});

	// Another page: the conversation is gone from the screen.
	await page.evaluate(() => {
		location.hash = "#/settings";
	});
	await page.getByTestId("settings-page").waitFor();
	await page.waitForTimeout(300);
	for (let i = 0; i < 8; i++) {
		await cdp.send("HeapProfiler.collectGarbage");
		await page.waitForTimeout(120);
	}

	const alive = await page.evaluate(() => {
		const w = window as unknown as { __ref?: WeakRef<Element> };
		return w.__ref?.deref() !== undefined;
	});
	expect(alive, "the conversation's composer is still alive after the page moved on").toBe(false);
});
