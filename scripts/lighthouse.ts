/**
 * Lighthouse audit (`npm run lighthouse`): home and a chat page, desktop and
 * mobile, against an isolated fixture server. Writes reports and final
 * screenshots to .tmp/lighthouse/ and fails if Accessibility or Best
 * Practices scores fall below 90.
 */
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as chromeLauncher from "chrome-launcher";
import lighthouse from "lighthouse";
import desktopConfig from "lighthouse/core/config/desktop-config.js";
import { startTestServer, type TestServer } from "../tests/support/server.ts";
import { onShutdown } from "./lib/shutdown.ts";

const MIN = 90;
const out = join(process.cwd(), ".tmp", "lighthouse");
mkdirSync(out, { recursive: true });

// What a signal must stop too (a `finally` does not run on one). Both may still be starting when it arrives.
const starting: Promise<TestServer> = startTestServer(7880);
const launching = chromeLauncher.launch({ chromeFlags: ["--headless=new", "--no-sandbox"], handleSIGINT: false });
const cleanup = onShutdown(async () => {
	(await launching.catch(() => null))?.kill();
	await (await starting.catch(() => null))?.stop();
});
let failed = false;
try {
	const server = await starting;
	const chrome = await launching;
	const pages = [
		{ name: "home", url: `${server.url}/` },
		{ name: "chat", url: `${server.url}/#/s/${encodeURIComponent(realpathSync(server.fixtures.alpha))}` },
	];
	for (const page of pages) {
		for (const form of ["desktop", "mobile"] as const) {
			const result = await lighthouse(
				page.url,
				{
					port: chrome.port,
					output: "html",
					onlyCategories: ["accessibility", "best-practices", "performance", "seo"],
					logLevel: "error",
					extraHeaders: { "x-omp-webui-token": server.accessToken },
				},
				form === "desktop" ? desktopConfig : undefined,
			);
			if (!result) throw new Error(`no result for ${page.name}/${form}`);
			const { lhr } = result;
			const score = (k: string) => Math.round((lhr.categories[k]?.score ?? 0) * 100);
			const tag = `${page.name}-${form}`;
			writeFileSync(join(out, `${tag}.html`), String(result.report));
			const shot = lhr.audits["final-screenshot"]?.details as { data?: string } | undefined;
			if (shot?.data) writeFileSync(join(out, `${tag}.jpg`), Buffer.from(shot.data.split(",")[1] ?? "", "base64"));
			const a11y = score("accessibility");
			const bp = score("best-practices");
			const ok = a11y >= MIN && bp >= MIN;
			failed ||= !ok;
			console.log(
				`${ok ? "✓" : "✗"} ${tag.padEnd(14)} a11y ${a11y}  best-practices ${bp}  perf ${score("performance")}  seo ${score("seo")}`,
			);
			for (const cat of ["accessibility", "best-practices"]) {
				for (const ref of lhr.categories[cat]?.auditRefs ?? []) {
					const audit = lhr.audits[ref.id];
					if (ref.weight > 0 && audit && audit.score !== null && audit.score < 1) {
						console.log(`    - ${cat}: ${audit.id} — ${audit.title}`);
					}
				}
			}
		}
	}
} finally {
	await cleanup();
}
process.exit(failed ? 1 : 0);
