import { type SocketTap, tapSocket } from "../support/socket-tap.ts";
import { expect, test } from "./fixtures.ts";

/**
 * A new chat in a browser that has never chosen a folder starts in the most recent project. The sessions
 * arrive after the home folder, so a default taken too early would have started omp in `~` (no model call).
 */

/** The folders of the `open` requests the page sent: each one starts an omp process. */
const startedIn = (tap: SocketTap) => tap.sent.filter((m) => m.t === "open").map((m) => m.target?.cwd);

test("a fresh browser starts the new chat in the most recent project, not in ~", async ({ page }) => {
	const meta = await page.request.get("/api/meta").then((r) => r.json());
	const sessions: { cwd: string }[] = await page.request.get("/api/sessions").then((r) => r.json());
	const recent = sessions.find((s) => s.cwd)?.cwd as string;
	expect(recent).toBeTruthy();
	expect(recent).not.toBe(meta.home);
	const shown = recent.startsWith(meta.home) ? `~${recent.slice(meta.home.length)}` : recent;

	// Hold the session list back until the start-up debounce (250 ms) has long passed, with the home folder known.
	const { promise: requested, resolve: sessionsAsked } = Promise.withResolvers<void>();
	const { promise: gate, resolve: release } = Promise.withResolvers<void>();
	await page.route("**/api/sessions", async (route) => {
		sessionsAsked();
		await gate;
		await route.continue();
	});
	const tap = await tapSocket(page);
	await page.goto("/");
	await requested;
	await page.waitForTimeout(800);
	expect(startedIn(tap)).toEqual([]);

	release();
	await expect(page.getByTestId("cwd-picker")).toContainText(shown);
	await expect.poll(() => startedIn(tap).length).toBe(1);
	expect(startedIn(tap)).toEqual([recent]);
});
