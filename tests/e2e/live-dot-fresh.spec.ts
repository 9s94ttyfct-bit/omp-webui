import { sessionRow } from "../support/live.ts";
import * as omp from "../support/omp-frames.ts";
import { other, SIDES, type Side, show, startWorld, type World } from "../support/two-pages.ts";
import { connect, request } from "../support/ws.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * A conversation that runs on the host has its pulsing "Running" dot in the sidebar of every page from the page's first
 * load, with no click on it (#618). The page loaded anew holds no process: what it shows of one is what the server lists
 * (`list_lives` on connect), whoever started the conversation — the app's own window, a page through remote access, a
 * client with no page at all — and however the page was loaded: on another conversation, on the running one itself, after
 * the server took the conversation over from a former one.
 */

let world: World;
test.beforeAll(async () => {
	world = await startWorld();
});
test.afterAll(async () => {
	await world?.stop();
});

const dot = (page: Page, title: string, name: string) =>
	sessionRow(page, title).getByRole("img", { name, exact: true });

/** The conversation `file` as the page names it in its address (`#/s/<file>`): the server's own spelling of it. */
async function addressOf(file: string): Promise<string> {
	const live = await world.liveOf(file);
	const listed = (await world.lives()).find((l) => l.liveId === live);
	if (!listed?.sessionFile) throw new Error("the process has no file yet");
	return `#/s/${encodeURIComponent(listed.sessionFile)}`;
}

/** A page of the same browser context as `page`, loaded anew on `hash`: it holds nothing of what the other pages did. */
async function loadedAnew(page: Page, hash: string): Promise<Page> {
	const fresh = await page.context().newPage();
	await fresh.goto(`${new URL(page.url()).origin}/${hash}`);
	return fresh;
}

for (const acting of SIDES) {
	const watching: Side = other(acting);

	test(`a ${watching} page loaded anew on another conversation lists the conversation the ${acting} page runs as Running, with no click`, async ({
		browser,
	}) => {
		const title = `Running for a fresh ${watching}`;
		const elsewhere = `Looked at by a fresh ${watching}`;
		const file = world.seed(acting === "local" ? 1 : 2, title);
		world.seed(acting === "local" ? 3 : 4, elsewhere);
		const pages = await world.open(browser);
		try {
			await show(pages[acting], title);
			await pages[acting].getByTestId("composer").fill(`Run ${title}`);
			await pages[acting].getByTestId("composer").press("Enter");
			await world.turnOf(file);
			// Neither a reload of the watching page nor a page opened beside it knows the process.
			await pages[watching].reload();
			await show(pages[watching], elsewhere);
			await expect(dot(pages[watching], title, "Running")).toBeVisible();
			const fresh = await loadedAnew(pages[watching], "");
			await expect(dot(fresh, title, "Running")).toBeVisible();
			await expect(dot(fresh, elsewhere, "Open")).toHaveCount(0);
			await world.finish(await world.liveOf(file));
			await expect(dot(fresh, title, "Open")).toBeVisible();
		} finally {
			await pages.close();
		}
	});

	test(`a ${watching} page loaded anew on the conversation the ${acting} page runs shows its Running dot, and its stream, with no click`, async ({
		browser,
	}) => {
		const title = `Running and opened by a fresh ${watching}`;
		const file = world.seed(acting === "local" ? 5 : 6, title);
		const pages = await world.open(browser);
		try {
			await show(pages[acting], title);
			await pages[acting].getByTestId("composer").fill(`Run ${title}`);
			await pages[acting].getByTestId("composer").press("Enter");
			const liveId = await world.turnOf(file);
			const fresh = await loadedAnew(pages[watching], await addressOf(file));
			await expect(dot(fresh, title, "Running")).toBeVisible();
			await world.emit(liveId, omp.messageStart("m1"), ...omp.block("m1", "text", 0, ["Streaming to a fresh page"]));
			await expect(fresh.getByText("Streaming to a fresh page")).toBeVisible();
			await expect(dot(fresh, title, "Running")).toBeVisible();
			await world.finish(liveId);
			await expect(dot(fresh, title, "Open")).toBeVisible();
		} finally {
			await pages.close();
		}
	});
}

for (const side of SIDES) {
	test(`a ${side} page loaded anew lists the conversation a client with no page runs as Running, with no click`, async ({
		browser,
	}) => {
		const title = `Run by no page for ${side}`;
		const file = world.seed(side === "local" ? 7 : 8, title);
		const pages = await world.open(browser);
		const ws = await connect(world.server);
		try {
			// Nobody opens the conversation in a page: a client of the server starts it and gives it a turn.
			const live = await request<{ liveId: string }>(ws, {
				t: "open",
				target: { kind: "resume", sessionFile: await fileOf(file) },
			});
			await request(ws, { t: "rpc", liveId: live.liveId, command: { type: "prompt", message: `Run ${title}` } });
			await world.turnOf(file);
			const fresh = await loadedAnew(pages[side], "");
			await expect(dot(fresh, title, "Running")).toBeVisible();
			await pages[side].reload();
			await expect(dot(pages[side], title, "Running")).toBeVisible();
			await world.finish(live.liveId);
			await expect(dot(fresh, title, "Open")).toBeVisible();
		} finally {
			ws.close();
			await pages.close();
		}
	});
}

/** The conversation's file as the server spells it (what an `open` takes): its own listing of the sessions. */
async function fileOf(file: string): Promise<string> {
	const base = file.split("/").pop() as string;
	const found = await fetch(`${world.server.url}/api/sessions`, {
		headers: { "x-omp-webui-token": world.server.accessToken },
	}).then((r) => r.json() as Promise<{ file: string }[]>);
	const match = found.find((s) => s.file.endsWith(base));
	if (!match) throw new Error(`the server does not list ${base}`);
	return match.file;
}

test("pages loaded anew after the server took a conversation over (it was waiting out a usage limit) list it as Running, on both sides and on the conversation itself", async ({
	browser,
}) => {
	const title = "Running over a restart";
	const file = world.seed(9, title);
	const first = await world.open(browser);
	let liveId: string;
	try {
		await show(first.local, title);
		await first.local.getByTestId("composer").fill("Hold on for the reset");
		await first.local.getByTestId("composer").press("Enter");
		liveId = await world.turnOf(file);
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
	const address = await addressOf(file);
	const pages = await world.open(browser);
	try {
		for (const side of SIDES) {
			await expect(dot(pages[side], title, "Running")).toBeVisible();
			const fresh = await loadedAnew(pages[side], address);
			await expect(dot(fresh, title, "Running")).toBeVisible();
		}
	} finally {
		await pages.close();
	}
});
