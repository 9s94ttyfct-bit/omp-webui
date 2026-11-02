// needs: posixShell
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { startCft } from "../../server/browser/cft.ts";
import { CdpClient } from "../../server/browser/transport.ts";

/**
 * The CfT engine over `--remote-debugging-pipe`: a real Chrome for Testing (`OMPW_BROWSER_EXECUTABLE`, else the one
 * Playwright installed) answers browser-level CDP through the pipe, opens a page, and is gone once its transport closes,
 * without ever listening on a TCP port.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-browser-cft-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

test("CfT over a pipe answers Browser.getVersion, opens a page, and closes when its transport closes", async () => {
	const executable = process.env.OMPW_BROWSER_EXECUTABLE || chromium.executablePath();
	const transport = await startCft({ executable, profileDir: join(root, "profile") });
	const client = new CdpClient(transport);

	const version = await client.call<{ product: string }>("Browser.getVersion");
	expect(version.product).toMatch(/^(HeadlessChrome|Chrome)\//);
	const created = await client.call<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
	expect(created.targetId).toMatch(/^[0-9A-F]{32}$/);

	const pid = transport.pid;
	expect(alive(pid)).toBe(true);
	const listening = Bun.spawnSync(["lsof", "-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-p", String(pid)]);
	expect(listening.stdout.toString().trim()).toBe("");

	// Asked and closed in the same tick: its answer cannot have come, so it is refused, not left hanging.
	const pending = client.call("Browser.getVersion");
	transport.close();
	await expect(pending).rejects.toThrow(/closed/);
	const deadline = Date.now() + 5000;
	while (alive(pid) && Date.now() < deadline) await Bun.sleep(50);
	expect(alive(pid)).toBe(false);
}, 30_000);
