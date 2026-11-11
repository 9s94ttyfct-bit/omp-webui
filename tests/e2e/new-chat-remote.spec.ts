import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SavedMac } from "@shared/macs.ts";
import type { LiveInfo } from "@shared/protocol.ts";
import { newChatIn } from "../support/new-chat.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * New chat's Remote computers (beside the guard in the settings bar): there only once a computer is saved, it gives the
 * warm-up process the computers ticked (the route of Session controls › Remote computers), a new project's conversation
 * gets them as it starts, and a warm-up New chat starts later (another folder or options) starts with none. Nothing is run
 * on a computer, and no model is called (the message is a `!command`).
 */

const mutating = { "x-omp-webui": "1" };

/** Save a computer in the server's list; the id it was given. */
async function addMac(page: Page): Promise<string> {
	const added = await page.request.post("/api/macs", {
		headers: mutating,
		data: { name: "E2E Mac", address: "e2e-remote.example.com" },
	});
	expect(added.ok()).toBe(true);
	const macs = (await (await page.request.get("/api/meta")).json()).macs as SavedMac[];
	return (macs.find((m) => m.name === "E2E Mac") as SavedMac).id;
}

async function removeMacs(page: Page): Promise<void> {
	const meta = await (await page.request.get("/api/meta")).json();
	for (const m of meta.macs as SavedMac[]) await page.request.delete(`/api/macs/${m.id}`, { headers: mutating });
}

test("a new project's conversation starts with the computers ticked on the warm-up process", async ({ page }) => {
	const root = join(process.env.OMPW_E2E_ROOT as string, `projects-remote-${process.pid}-${Date.now()}`);
	mkdirSync(root, { recursive: true });
	expect((await page.request.post("/api/projects", { headers: mutating, data: { folder: root } })).ok()).toBe(true);
	const id = await addMac(page);
	try {
		// The tick's request is slow, and the message is sent while it is on its way: the project's conversation still gets it.
		let slow = true;
		await page.route("**/api/remote-run/live", async (route) => {
			if (slow) await new Promise((r) => setTimeout(r, 1500));
			slow = false;
			await route.continue();
		});
		await page.goto("/");
		const button = page.getByTestId("remote-picker");
		await expect(button).toBeVisible({ timeout: 60_000 });
		await button.click();
		await page
			.getByTestId("remote-picker-panel")
			.locator(`[data-testid="session-remote-computer"][data-mac="${id}"] input`)
			.check();
		await page.keyboard.press("Escape");
		const composer = page.getByTestId("composer");
		await composer.fill("!true");
		await composer.press("Enter");
		// The conversation runs in the project's own folder, made in the projects folder as the message was sent.
		await expect
			.poll(
				async () => {
					const lives = (await (await page.request.get("/api/lives")).json()) as LiveInfo[];
					return lives.find((l) => !l.exited && l.cwd.startsWith(`${root}/`))?.remoteComputers ?? null;
				},
				{ timeout: 30_000 },
			)
			.toEqual([id]);
	} finally {
		await removeMacs(page);
		await page.request.post("/api/projects", { headers: mutating, data: { folder: null } });
	}
});

test("New chat's Remote computers sit beside the guard, act on the warm-up process, a later warm-up starts with none, and are not there without a saved computer", async ({
	page,
}) => {
	const lives = async () => (await (await page.request.get("/api/lives")).json()) as LiveInfo[];
	const before = new Set((await lives()).map((l) => l.liveId));
	const mine = async () => (await lives()).filter((l) => !before.has(l.liveId) && !l.exited);
	const tap = await tapSocket(page);
	const opens = () => tap.sent.filter((m) => m.t === "open");

	// No computer saved: the bar has no such control.
	await page.goto(newChatIn(process.env.OMPW_E2E_WORK as string));
	await expect(page.getByTestId("guard-picker")).toBeVisible({ timeout: 60_000 });
	await expect(page.getByTestId("remote-picker")).toHaveCount(0);

	const id = await addMac(page);
	try {
		const mac = { id, name: "E2E Mac" };
		await page.reload();
		const button = page.getByTestId("remote-picker");
		await expect(button).toBeVisible({ timeout: 60_000 });
		// Right after the guard's control, in the bar's rules.
		const order = await page
			.locator('[data-group="rules"] > *')
			.evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")));
		expect(order.indexOf("remote-picker")).toBe(order.indexOf("guard-picker") + 1);
		await expect(button).toHaveText("Remote: off");
		await expect(button).toHaveAttribute("data-on", "false");

		// A tick gives the warm-up process the computer at once.
		await button.click();
		const panel = page.getByTestId("remote-picker-panel");
		await panel.locator(`[data-testid="session-remote-computer"][data-mac="${mac.id}"] input`).check();
		await expect
			.poll(async () => (await mine()).some((l) => l.remoteComputers?.includes(mac.id)), { timeout: 30_000 })
			.toBe(true);
		await expect(button).toHaveText("Remote: E2E Mac");
		await expect(button).toHaveAttribute("data-on", "true");
		await page.keyboard.press("Escape");

		// Another process (other options): it starts with none, and the control says so.
		const opened = opens().length;
		await page.getByRole("button", { name: /^Options/ }).click();
		const field = page.locator('[data-flag="--append-system-prompt"]');
		await field.fill("other");
		await field.press("Enter");
		await expect.poll(() => opens().length).toBe(opened + 1);
		expect(opens().at(-1)?.target).not.toHaveProperty("remoteComputers");
		await expect(page.getByTestId("remote-picker")).toHaveText("Remote: off", { timeout: 30_000 });
		await expect
			.poll(async () => (await mine()).filter((l) => l.remoteComputers?.includes(mac.id)).length, { timeout: 30_000 })
			.toBe(0);
	} finally {
		await removeMacs(page);
	}
});
