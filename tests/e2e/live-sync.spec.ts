import { endAllLives } from "../support/lives.ts";
import * as omp from "../support/omp-frames.ts";
import { other, SIDES, type Side, show, startWorld, type World } from "../support/two-pages.ts";
import { expect, test } from "./fixtures.ts";

/**
 * The Mac app's own window and a page through Cloudflare Access are one app: what one shows of a conversation the
 * other shows. Two real pages on one real server (a stand-in for the tunnel carries one of them,
 * `tests/support/access-tunnel.ts`), the omp a stand-in the test conducts (`tests/support/sync-omp.ts`); each item is
 * driven from each side. This part: a page that shows a conversation by its file is attached to the process that runs
 * it (#591) — what streams, what is asked, what is queued reaches it, whichever page started the turn, and also when it
 * opened the conversation after the turn began or after the server was restarted around it.
 */

let world: World;
test.beforeAll(async () => {
	world = await startWorld();
});
test.afterAll(async () => {
	await world?.stop();
});

for (const acting of SIDES) {
	const watching: Side = other(acting);

	test(`a turn the ${acting} page starts streams text and thinking on the ${watching} page that shows the conversation`, async ({
		browser,
	}) => {
		const title = `Streams from ${acting}`;
		const file = world.seed(acting === "local" ? 11 : 12, title);
		const pages = await world.open(browser);
		try {
			await show(pages.local, title);
			await show(pages.remote, title);
			await pages[acting].getByTestId("composer").fill(`Go from ${acting}`);
			await pages[acting].getByTestId("composer").press("Enter");
			const liveId = await world.turnOf(file);
			for (const side of SIDES) await expect(pages[side].getByText(`Go from ${acting}`)).toBeVisible();
			await world.emit(liveId, omp.messageStart("m1"), ...omp.block("m1", "thinking", 0, ["Considering ", "options"]));
			for (const side of SIDES) await expect(pages[side].getByTestId("stop")).toBeVisible();
			await world.emit(liveId, ...omp.block("m1", "text", 1, ["First half, ", "second half"]));
			for (const side of SIDES) await expect(pages[side].getByText("First half, second half")).toBeVisible();
			await world.emit(
				liveId,
				omp.messageEnd("m1", [
					{ type: "thinking", thinking: "Considering options" },
					{ type: "text", text: "First half, second half" },
				]),
			);
			await world.finish(liveId);
			for (const side of SIDES) {
				await expect(pages[side].getByTestId("stop")).toHaveCount(0);
				await expect(pages[side].getByText("First half, second half")).toBeVisible();
			}
		} finally {
			await pages.close();
		}
	});

	test(`the ${watching} page that opens the conversation while the ${acting} page's turn runs shows what is streaming, and goes on showing it`, async ({
		browser,
	}) => {
		const title = `Opened mid-turn from ${watching}`;
		const file = world.seed(acting === "local" ? 13 : 14, title);
		const pages = await world.open(browser);
		try {
			await show(pages[acting], title);
			await pages[acting].getByTestId("composer").fill(`Begin ${title}`);
			await pages[acting].getByTestId("composer").press("Enter");
			const liveId = await world.turnOf(file);
			await world.emit(liveId, omp.messageStart("m1"), ...omp.block("m1", "text", 0, ["Already half written"]));
			await expect(pages[acting].getByText("Already half written")).toBeVisible();
			// This page was on New chat all along: it opens the conversation from the list.
			await show(pages[watching], title);
			await expect(pages[watching].getByText("Already half written")).toBeVisible();
			await expect(pages[watching].getByTestId("stop")).toBeVisible();
			await world.emit(liveId, ...omp.block("m1", "text", 1, ["and then the rest"]));
			await expect(pages[watching].getByText("and then the rest")).toBeVisible();
		} finally {
			await pages.close();
		}
	});

	test(`a turn the ${acting} page starts after the ${watching} page shows the conversation, with no process yet, reaches it`, async ({
		browser,
	}) => {
		const title = `Started later from ${acting}`;
		const file = world.seed(acting === "local" ? 15 : 16, title);
		const pages = await world.open(browser);
		try {
			// Both show the conversation as saved: nothing runs it, and the page that does not send must find the process when it starts.
			await show(pages[watching], title);
			await show(pages[acting], title);
			await expect(pages[watching].getByTestId("stop")).toHaveCount(0);
			await pages[acting].getByTestId("composer").fill(`Start ${title}`);
			await pages[acting].getByTestId("composer").press("Enter");
			const liveId = await world.turnOf(file);
			await world.emit(liveId, omp.messageStart("m1"), ...omp.block("m1", "text", 0, ["Streaming for both"]));
			for (const side of SIDES) await expect(pages[side].getByText("Streaming for both")).toBeVisible();
		} finally {
			await pages.close();
		}
	});
}

test("a conversation the server took over after a restart (it was waiting out a usage limit) is live on pages opened afterwards, on both sides", async ({
	browser,
}) => {
	const title = "Taken over after a restart";
	const file = world.seed(17, title);
	const first = await world.open(browser);
	let liveId: string;
	try {
		await show(first.local, title);
		await first.local.getByTestId("composer").fill("Hold on for the reset");
		await first.local.getByTestId("composer").press("Enter");
		liveId = await world.turnOf(file);
		// omp fails on a usage limit and waits out the reset (ten minutes): it is what outlives the server.
		await world.emit(
			liveId,
			omp.messageStart("m1"),
			...omp.block("m1", "text", 0, ["Half way"]),
			omp.retryStart(1, 3, 600_000, "Usage limit reached", 0x80000),
		);
		await expect(first.local.getByText("Half way")).toBeVisible();
	} finally {
		await first.close({ keepProcesses: true });
	}

	await world.restart();
	expect(await world.liveOf(file)).toBe(liveId);

	const pages = await world.open(browser);
	try {
		for (const side of SIDES) await show(pages[side], title);
		// The retried turn runs: what omp prints reaches every page that shows the conversation.
		await world.emit(
			liveId,
			omp.agentStart(),
			omp.messageStart("m2"),
			...omp.block("m2", "text", 0, ["Back after the reset"]),
		);
		for (const side of SIDES) await expect(pages[side].getByText("Back after the reset")).toBeVisible();
	} finally {
		await pages.close();
	}
});

test("a page that lost its connection while the other page started a turn shows the turn once it is connected again", async ({
	browser,
}) => {
	const title = "Away while a turn started";
	const file = world.seed(18, title);
	const pages = await world.open(browser);
	try {
		await show(pages.local, title);
		await show(pages.remote, title);
		// The way to the tunnel is out for the remote page, which misses the start of the turn the local page makes.
		world.tunnel.holdUpgrades = true;
		world.tunnel.drop();
		await pages.local.getByTestId("composer").fill(`Start ${title}`);
		await pages.local.getByTestId("composer").press("Enter");
		const liveId = await world.turnOf(file);
		await world.emit(liveId, omp.messageStart("m1"), ...omp.block("m1", "text", 0, ["Written while away"]));
		world.tunnel.holdUpgrades = false;
		await expect(pages.local.getByText("Written while away")).toBeVisible();
		await expect(pages.remote.getByText("Written while away")).toBeVisible({ timeout: 40_000 });
		await world.emit(liveId, ...omp.block("m1", "text", 1, ["and after"]));
		for (const side of SIDES) await expect(pages[side].getByText("and after")).toBeVisible();
	} finally {
		world.tunnel.holdUpgrades = false;
		await pages.close();
	}
});

for (const acting of SIDES) {
	const watching: Side = other(acting);

	test(`the ${watching} page that only looks at the turn the ${acting} page runs changes nothing about it`, async ({
		browser,
	}) => {
		const title = `Only looked at from ${watching}`;
		const file = world.seed(acting === "local" ? 20 : 21, title);
		const pages = await world.open(browser);
		try {
			await show(pages[acting], title);
			await pages[acting].getByTestId("composer").fill(`Begin ${title}`);
			await pages[acting].getByTestId("composer").press("Enter");
			const liveId = await world.turnOf(file);
			const before = (await world.lives()).find((l) => l.liveId === liveId);
			const mode = await pages[acting].getByTestId("approval-picker").getAttribute("data-mode");
			await show(pages[watching], title);
			await world.emit(liveId, omp.messageStart("m1"), ...omp.block("m1", "text", 0, ["Seen from both"]));
			for (const side of SIDES) await expect(pages[side].getByText("Seen from both")).toBeVisible();
			// Looking is not acting: the permission mode is the one the conversation had, as the process and both pages say.
			const after = (await world.lives()).find((l) => l.liveId === liveId);
			expect(after?.approvalMode).toBe(before?.approvalMode);
			expect(after).not.toHaveProperty("approvalForcedByRemote");
			for (const side of SIDES)
				await expect(pages[side].getByTestId("approval-picker")).toHaveAttribute("data-mode", mode ?? "");
		} finally {
			await pages.close();
		}
	});
}

for (const starter of SIDES) {
	const resumer: Side = other(starter);

	test(`the ${starter} page that shows the process that ended shows the one the ${resumer} page resumed the conversation with`, async ({
		browser,
	}) => {
		const title = `Ended on ${starter}`;
		const file = world.seed(starter === "local" ? 22 : 23, title);
		const pages = await world.open(browser);
		try {
			// The page that starts the turn shows the conversation through that process, by its id.
			await show(pages[starter], title);
			await pages[starter].getByTestId("composer").fill(`Run ${title}`);
			await pages[starter].getByTestId("composer").press("Enter");
			await world.turnOf(file);
			await show(pages[resumer], title);
			await endAllLives(world.server);
			await expect(pages[starter].getByText("ended this conversation's omp process")).toBeVisible();
			// The other page sends the next message: its process is another one, and the page shows that.
			await pages[resumer].getByTestId("composer").fill(`Resume ${title}`);
			await pages[resumer].getByTestId("composer").press("Enter");
			const liveId = await world.turnOf(file);
			await world.emit(liveId, omp.messageStart("m1"), ...omp.block("m1", "text", 0, ["Written after the resume"]));
			for (const side of SIDES) await expect(pages[side].getByText("Written after the resume")).toBeVisible();
			await expect(pages[starter].getByText("ended this conversation's omp process")).toHaveCount(0);
			await expect(pages[starter].getByTestId("stop")).toBeVisible();
		} finally {
			await pages.close();
		}
	});
}
