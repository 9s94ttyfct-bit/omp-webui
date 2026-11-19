// needs: posixShell
import { afterAll, beforeAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { BROWSER_NOTE } from "../../server/omp/docs-tool/extension.ts";
import type { LiveInfo } from "../../shared/protocol.ts";
import { watchFrames } from "../support/frames.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { type ScriptedTurn, type StubScripted, startScriptedStub } from "../support/stub-scripted.ts";
import { connect, request } from "../support/ws.ts";

/**
 * The browser note (`BROWSER_NOTE`) tells every agent how to reach a second page of its conversation: open it, then attach
 * with `browser.open({ name, target })`. Against the real omp, the real server and its built-in browser (the Chromium
 * Playwright installed stands in for Chrome for Testing), the model a scripted provider that runs exactly that in eval: the
 * spelling the note gives must attach to the page, so the next change of omp's browser API is caught here (#302).
 */

const TITLE = "ompw-second-page";
const ASK = "Open a second page and attach to it";
/** omp 18.19 moved `app.target` to a top-level `target`; the note gives both, and the omp under test gets its own. */
const topLevelTarget = (() => {
	const out = Bun.spawnSync([process.env.OMP_BIN ?? "omp", "--version"]).stdout.toString();
	const [major = 0, minor = 0] = (/(\d+)\.(\d+)\.\d+/.exec(out)?.slice(1) ?? []).map(Number);
	return major > 18 || (major === 18 && minor >= 19);
})();
const TARGET = topLevelTarget ? `target: "${TITLE}"` : `app: { target: "${TITLE}" }`;
const CODE = [
	'const first = await browser.open({ name: "first" });',
	`await first.run(async ({ browser }) => { const page = await browser.newPage(); await page.goto("data:text/html,<title>${TITLE}</title>"); });`,
	`const second = await browser.open({ name: "second", ${TARGET} });`,
	"const title = await second.run(({ page }) => page.title());",
	'return "attached to: " + title;',
].join("\n");

let server: TestServer;
let backend: StubScripted;

const script = (req: { text: string; tools: string[]; toolResults: number }): ScriptedTurn => {
	if (!req.tools.includes("eval")) return { text: "A title" };
	if (req.toolResults > 0) return { text: "Done." };
	if (req.text.includes(ASK)) return { call: { name: "eval", args: { language: "js", code: CODE } } };
	return { text: "Ok." };
};

beforeAll(async () => {
	backend = await startScriptedStub(script);
	server = await startTestServer(0, { OMPW_BROWSER_EXECUTABLE: chromium.executablePath() });
	writeFileSync(
		join(server.agentDir, "models.yml"),
		`providers:\n  omlx:\n    baseUrl: ${backend.url}\n    api: openai-completions\n    apiKey: ${backend.apiKey}\n    discovery:\n      type: openai-models-list\n`,
	);
	writeFileSync(
		join(server.agentDir, "config.yml"),
		[
			"modelRoles:",
			...["default", "smol", "slow", "tiny", "commit"].map((r) => `  ${r}: omlx/stub-model`),
			"spelling:",
			"  autocomplete: ngram",
			"",
		].join("\n"),
	);
}, 120_000);

afterAll(async () => {
	await server?.stop();
	await backend?.stop();
});

test("the note's spelling attaches an agent to a second page of its conversation", async () => {
	// What the eval below runs is what the note tells the agent.
	expect(BROWSER_NOTE).toContain('browser.open({ name, target: "<URL or title substring>" })');
	expect(BROWSER_NOTE).toContain('(omp before 18.19: `app: { target: "…" }`)');
	const ws = await connect(server);
	const live = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: server.work } });
	const frames = watchFrames(ws, live.liveId);
	await request(ws, { t: "rpc", liveId: live.liveId, command: { type: "prompt", message: ASK } });
	const end = await frames.next((f) => f.type === "tool_execution_end");
	const result = JSON.stringify(end.result);
	expect(end.isError, result).toBeFalsy();
	expect(result).toContain(`attached to: ${TITLE}`);
	await frames.next((f) => f.type === "agent_end");
	ws.close();
}, 180_000);
