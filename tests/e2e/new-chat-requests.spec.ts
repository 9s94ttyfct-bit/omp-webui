import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeChatSession } from "../support/chat-session.ts";
import { writeLongFakeOmp } from "../support/long-fake-omp-bin.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { expect, test } from "./fixtures.ts";

/**
 * omp names a new conversation's file as soon as its process starts and writes it with the first assistant message.
 * Until then the server answers 404 ("Unknown session file") for `/api/family` and `/api/subagents`, and the browser
 * logs a red error for each: a console full of them in every healthy new chat hides the real failures (#298). The page
 * waits for the session list to hold the file. The omp is a stand-in that writes the file the way omp does
 * (tests/support/long-fake-omp.ts): no model is called.
 */

let s: TestServer;
let binDir: string;

test.beforeAll(async () => {
	binDir = mkdtempSync(join(tmpdir(), "ompw-fake-omp-"));
	s = await startTestServer(0, { OMP_BIN: writeLongFakeOmp(binDir) });
	mkdirSync(s.work, { recursive: true });
	writeChatSession(s.agentDir, { n: 1, title: "Earlier chat", cwd: s.work, turns: [{ prompt: "hello", reply: "hi" }] });
});
test.afterAll(async () => {
	await s?.stop();
	rmSync(binDir, { recursive: true, force: true });
});

test("a new chat asks for no file omp has not written: no 404, no console error, and the family loads once it is written", async ({
	page,
}) => {
	const answers: { path: string; status: number; file: string | null }[] = [];
	page.on("response", (r) => {
		const url = new URL(r.url());
		if (url.pathname === "/api/family" || url.pathname === "/api/subagents")
			answers.push({ path: url.pathname, status: r.status(), file: url.searchParams.get("file") });
	});
	// A failed request logs `Failed to load resource: …` against its own URL. The stand-in omp cannot answer the
	// server's `omp usage` and `omp config` commands (500s on `/api/usage` and `/api/model-config`): not this spec's.
	const errors: string[] = [];
	page.on("console", (m) => {
		const { url } = m.location();
		if (m.type() === "error" && /\/api\/(family|subagents)\?/.test(url)) errors.push(`${m.text()} (${url})`);
	});
	await page.addInitScript((cwd) => {
		localStorage.setItem("ompw.cwd", cwd);
		localStorage.setItem("ompw.autoTitle", "off");
	}, s.work);
	await page.goto(`${s.url}/?token=${s.accessToken}`);
	const composer = page.getByTestId("composer");
	await expect(composer).toBeVisible();
	// The page starts omp for the folder a moment after it opens; a prompt sent before that is kept as a draft.
	await expect(async () => {
		await composer.fill("hello");
		await composer.press("Enter");
		await expect(page).toHaveURL(/#\/(chat|s\/)/, { timeout: 2000 });
	}).toPass({ timeout: 30_000, intervals: [500] });
	// The turn takes about a second; the file is written with its first assistant message, after the page switched to the
	// conversation, and the answer's stats line (`took …`) says it is over.
	await expect(page.getByText(/took \d/).first()).toBeVisible({ timeout: 60_000 });

	// Once the file is written the session list gets it and the page asks for the family and the subagents: both
	// answered, for a file that exists.
	await expect
		.poll(() => answers.filter((a) => a.path === "/api/family" && a.status === 200).length)
		.toBeGreaterThan(0);
	await expect
		.poll(() => answers.filter((a) => a.path === "/api/subagents" && a.status === 200).length)
		.toBeGreaterThan(0);
	expect(answers.filter((a) => a.status !== 200)).toEqual([]);
	expect(errors).toEqual([]);
});
