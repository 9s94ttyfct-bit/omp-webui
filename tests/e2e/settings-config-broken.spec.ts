import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * omp's config.yml with a syntax error: the first omp to read it moves it aside (`config.yml.broken-…`), and every read
 * after that starts from omp's defaults. Settings then shows those defaults with a notice saying where the person's file
 * went, not as if nothing had happened (#443), whichever omp moved it: the server's own read, or another omp that read
 * it first, such as a conversation's or a terminal's (#15: an omp a neighbouring spec left running did, and the server,
 * whose read then worked, said nothing). No model is called.
 */

const BROKEN = "modelRoles:\n  default: a/b\n bad: [\n  x: y: z\n";

async function movedAsideIsShown(page: Page, moveFirst: boolean): Promise<void> {
	const agentDir = process.env.OMPW_E2E_AGENT_DIR as string;
	const config = join(agentDir, "config.yml");
	const original = readFileSync(config, "utf8");
	const backups = () => readdirSync(agentDir).filter((f) => f.startsWith("config.yml.broken-"));
	try {
		writeFileSync(config, BROKEN);
		if (moveFirst) {
			// Another omp, with the server's agent directory, reads the file before the server does.
			const other = spawnSync("omp", ["config", "list", "--json"], {
				env: { ...process.env, HOME: process.env.OMPW_E2E_HOME, PI_CODING_AGENT_DIR: agentDir },
				encoding: "utf8",
			});
			expect(other.stderr).toContain("moved to");
			expect(existsSync(config)).toBe(false);
		}
		// The read that finds the file unreadable answers 500 with omp's message (this one, or one of the server's timer
		// reads just before it); the reads after it work, on omp's defaults, and name the copy, whoever made it.
		await expect
			.poll(async () => {
				const read = await page.request.get("/api/model-config");
				if (read.status() !== 200) return read.status();
				const told: { movedAside?: string } = await read.json();
				return told.movedAside;
			})
			.toContain("config.yml.broken-");
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
}

test("Settings says where omp put an unreadable config.yml while it shows omp's defaults", async ({ page }) => {
	await movedAsideIsShown(page, false);
});

test("Settings says where another omp put an unreadable config.yml the server never failed to read", async ({
	page,
}) => {
	await movedAsideIsShown(page, true);
});
