import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "./fixtures.ts";

/**
 * omp's config.yml with a syntax error: omp moves it aside on the first read that fails and starts from its defaults
 * on the next. Settings then shows those defaults with a notice saying where the person's file went, not as if
 * nothing had happened (#443). The first read is made here, by hand, so that the page's own read (and the other omp
 * commands it starts) cannot be the one that moves the file. No model is called.
 */

test("Settings says where omp put an unreadable config.yml while it shows omp's defaults", async ({ page }) => {
	const agentDir = process.env.OMPW_E2E_AGENT_DIR as string;
	const config = join(agentDir, "config.yml");
	const original = readFileSync(config, "utf8");
	const backups = () => readdirSync(agentDir).filter((f) => f.startsWith("config.yml.broken-"));
	try {
		writeFileSync(config, "modelRoles:\n  default: a/b\n bad: [\n  x: y: z\n");
		// The server's own reads of omp's settings (an update check, a conversation's roles) run on timers, and the first
		// of them to read the file is the one omp refuses and moves it aside for: this read, or one just before it. Either
		// way the server knows where the file went.
		const read = await page.request.get("/api/model-config");
		if (read.status() === 200) {
			const told: { movedAside?: string } = await read.json();
			expect(told.movedAside).toContain("config.yml.broken-");
		} else {
			expect(read.status()).toBe(500);
			const refusal: { error: string } = await read.json();
			expect(refusal.error).toContain("YAML Parse error");
		}
		expect(backups()).toHaveLength(1);

		await page.goto("/#/settings/models");
		const notice = page.getByTestId("config-moved-aside");
		await expect(notice).toContainText(backups()[0]);
		await expect(page.getByTestId("role-row")).toHaveCount(0);

		// Put back, the notice is gone.
		for (const f of backups()) rmSync(join(agentDir, f));
		writeFileSync(config, original);
		await page.reload();
		await expect(page.getByTestId("model-roles")).toBeVisible();
		await expect(page.getByTestId("role-row").first()).toBeVisible();
		await expect(notice).toHaveCount(0);
	} finally {
		for (const f of backups()) rmSync(join(agentDir, f));
		writeFileSync(config, original);
	}
});
