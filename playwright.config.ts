import os from "node:os";
import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "tests/e2e",
	globalSetup: "./tests/e2e/global-setup.ts",
	timeout: 120_000,
	expect: { timeout: 15_000 },
	// Files share no server across workers; tests inside a file keep their existing sequential hooks.
	fullyParallel: false,
	// Keep small CI runners at one worker. On the 24GB M4 Pro, four gave near-six throughput with 2GiB less memory.
	workers: Number(process.env.OMPW_E2E_WORKERS ?? Math.max(1, Math.min(4, Math.floor(os.cpus().length / 3)))),
	retries: 0,
	// `bun run test:e2e` gives each run folders of its own (`.tmp/e2e/<run>/`, set by `scripts/e2e.ts`, #769): a second run
	// in this checkout never removes the first one's traces or report. Unset (a run started by hand), the usual ones.
	outputDir: process.env.OMPW_E2E_OUTPUT ?? "test-results",
	reporter: [
		["list"],
		["html", { open: "never", outputFolder: process.env.OMPW_E2E_REPORT ?? "playwright-report" }],
		// What each test took (CI keeps it: `scripts/e2e-timings.ts` makes the timings CI's runners are split by from it).
		...(process.env.OMPW_E2E_JSON ? [["json", { outputFile: process.env.OMPW_E2E_JSON }] as const] : []),
	],
	use: {
		channel: process.env.PLAYWRIGHT_CHANNEL ?? "chrome",
		viewport: { width: 1400, height: 900 },
		locale: "en-US",
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
	},
});
