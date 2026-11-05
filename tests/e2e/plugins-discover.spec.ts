import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type StubRegistry, startStubRegistry, writeFakePluginsOmp } from "../support/plugins-stubs.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The Plugins page's tabs against a server whose omp `plugin` and `skill` commands are a stand-in and whose MCP Registry is
 * one served by the spec (no network, nothing installed): a recommended marketplace is added with one click; the MCP tab
 * finds a server, asks for its required secret and writes it into the user's mcp.json; the Skills tab lists the skills omp
 * has and installs one from omp's registry, one that ships scripts only after the person agreed.
 */

let s: TestServer;
let registry: StubRegistry;
let bin: string;

test.beforeAll(async () => {
	bin = mkdtempSync(join(tmpdir(), "ompw-plugins-discover-e2e-"));
	registry = await startStubRegistry();
	s = await startTestServer(
		0,
		{ OMP_BIN: writeFakePluginsOmp(bin), OMPW_MCP_REGISTRY: registry.url },
		{ login: false },
	);
});
test.afterAll(async () => {
	await s?.stop();
	await registry?.stop();
	rmSync(bin, { recursive: true, force: true });
});

async function openTab(page: Page, tab: string): Promise<void> {
	await page.goto(`${s.url}/?token=${s.accessToken}#/plugins`);
	await expect(page.getByTestId("plugins-page")).toBeVisible();
	await page.getByTestId(`plugins-tab-${tab}`).click();
	await expect(page.getByTestId(`plugins-tab-${tab}`)).toHaveAttribute("aria-selected", "true");
}

test("the Recommended card adds a marketplace with one click, and shows it as added", async ({ page }) => {
	await openTab(page, "discover");
	const card = page.getByTestId("plugins-recommended");
	await expect(card).toContainText("Plugin marketplaces");
	await expect(card).toContainText("Skill libraries");
	await expect(card.getByTestId("recommended-marketplace")).toHaveCount(11);
	await expect(page.getByTestId("plugins-web-catalogs").getByRole("link")).toHaveAttribute(
		"href",
		"https://claude.com/marketplace/plugins",
	);

	const skills = card.locator('[data-testid="recommended-marketplace"][data-marketplace="anthropic-agent-skills"]');
	await expect(skills).toHaveAttribute("data-added", "false");
	await skills.getByTestId("recommended-add").click();
	await expect(page.getByTestId("plugins-outcome")).toHaveAttribute("data-state", "done");
	await expect(page.getByTestId("plugins-outcome")).toContainText("omp plugin marketplace add anthropics/skills");
	await expect(skills).toHaveAttribute("data-added", "true");
	await expect(skills).toContainText("added as anthropic-agent-skills");
	// Its catalog is listed in Discover, and the marketplace in its own tab.
	await expect(
		page.locator('[data-testid="catalog-plugin"][data-plugin="example-plugin@anthropic-agent-skills"]'),
	).toBeVisible();
	await page.getByTestId("plugins-tab-marketplaces").click();
	await expect(page.locator('[data-testid="marketplace"][data-marketplace="anthropic-agent-skills"]')).toContainText(
		"anthropics/skills",
	);
});

test("the MCP tab finds a server in the registry and adds it to omp after its required value is filled in", async ({
	page,
}) => {
	await openTab(page, "mcp");
	await expect(page.getByTestId("mcp-web-catalogs").getByRole("link")).toHaveCount(3);
	await page.getByTestId("mcp-search").fill("weather");
	await page.getByTestId("mcp-search-run").click();
	const server = page.locator('[data-testid="mcp-server"][data-server="io.github.example/weather-mcp"]');
	await expect(server).toContainText("Forecasts and alerts for any place.");
	await expect(server.getByTestId("mcp-option")).toHaveCount(2);
	await expect(server.locator('[data-option="package:0"]')).toContainText("npx -y @example/weather-mcp@1.4.0");

	await server.locator('[data-option="package:0"]').getByTestId("mcp-option-add").click();
	const dialog = page.getByTestId("mcp-add-dialog");
	await expect(page.getByTestId("mcp-add-name")).toHaveValue("weather-mcp");
	const key = dialog.locator('[data-input="env:WEATHER_API_KEY"]').getByTestId("mcp-add-input");
	await expect(key).toHaveAttribute("type", "password");
	await expect(dialog.locator('[data-input="env:WEATHER_UNITS"]').getByTestId("mcp-add-input")).toHaveAttribute(
		"placeholder",
		"metric",
	);
	// Required and empty: Add waits for it.
	await expect(page.getByTestId("mcp-add-save")).toBeDisabled();
	await key.fill("e2e-secret");
	await page.getByTestId("mcp-add-save").click();

	await expect(dialog).toHaveCount(0);
	await expect(page.getByTestId("plugins-outcome-mcp")).toContainText("Added weather-mcp to");
	await expect(server).toHaveAttribute("data-added", "true");
	await expect(server.getByTestId("mcp-added")).toHaveText("added as weather-mcp");
	const written = JSON.parse(readFileSync(join(realpathSync(s.agentDir), "mcp.json"), "utf8"));
	expect(written.mcpServers["weather-mcp"]).toEqual({
		type: "stdio",
		command: "npx",
		args: ["-y", "@example/weather-mcp@1.4.0"],
		env: { WEATHER_API_KEY: "e2e-secret", WEATHER_UNITS: "metric" },
	});

	// A server that cannot be added says why and offers no Add.
	await page.getByTestId("mcp-search").fill("dotnet");
	await page.getByTestId("mcp-search-run").click();
	const dotnet = page.locator('[data-testid="mcp-server"][data-server="io.github.example/dotnet-mcp"]');
	await expect(dotnet.getByTestId("mcp-option-problem")).toContainText("cannot run nuget packages");
	await expect(dotnet.getByTestId("mcp-option-add")).toHaveCount(0);
});

test("the Skills tab lists the skills omp has, and installs a registry skill; one with scripts after a confirmation", async ({
	page,
}) => {
	await openTab(page, "skills");
	await expect(page.locator('[data-testid="skill-row"][data-skill="house-style"]')).toContainText(
		"Write in the house style.",
	);

	await page.getByTestId("skills-search").fill("nothing-like-it");
	await page.getByTestId("skills-search-run").click();
	await expect(page.getByTestId("skills-search-empty")).toContainText("No skill in omp's registry matches");

	await page.getByTestId("skills-search").fill("acme");
	await page.getByTestId("skills-search-run").click();
	const pdf = page.locator('[data-testid="skill-hit"][data-skill="@acme/pdf-tools"]');
	await pdf.getByTestId("skill-install").click();
	await expect(page.getByTestId("plugins-outcome")).toHaveAttribute("data-state", "done");
	await expect(page.getByTestId("plugins-outcome")).toContainText("omp skill install @acme/pdf-tools -g");
	const installed = page.locator('[data-testid="skill-row"][data-skill="pdf-tools"]');
	await expect(installed).toContainText("registry");
	await expect(pdf).toContainText("installed");

	// Scripts: omp refuses without a confirmation; the page shows what it would install and asks.
	await page
		.locator('[data-testid="skill-hit"][data-skill="@acme/shell-helpers"]')
		.getByTestId("skill-install")
		.click();
	await expect(page.getByTestId("plugins-outcome")).toHaveAttribute("data-state", "failed");
	await page.getByTestId("skill-scripts-review").click();
	await expect(page.getByRole("dialog")).toContainText("scripts/run.sh");
	await page.getByTestId("skill-scripts-confirm").click();
	await expect(page.getByTestId("plugins-outcome")).toHaveAttribute("data-state", "done");
	await expect(page.getByTestId("plugins-outcome")).toContainText("omp skill install @acme/shell-helpers -g -y");
	await expect(page.locator('[data-testid="skill-row"][data-skill="shell-helpers"]')).toBeVisible();

	// Uninstall asks first.
	await installed.getByTestId("skill-uninstall").click();
	await page.getByTestId("skill-uninstall-confirm").click();
	await expect(page.getByTestId("plugins-outcome")).toContainText("omp skill uninstall @acme/pdf-tools -g");
	await expect(installed).toHaveCount(0);
});

test("the Overview lists the updates a check finds; some are installed, then the rest, and the marketplaces in bulk", async ({
	page,
}) => {
	// What omp has: an older registry skill for the user, and a marketplace plugin with a newer version in its catalog.
	const file = join(s.home, ".fake-plugins-omp.json");
	const held = JSON.parse(readFileSync(file, "utf8"));
	held.skills = [{ id: "@acme/pdf-tools", version: "1.1.0", global: true }];
	held.plugins = [{ id: "hello@market", scope: "user", version: "1.0.0", latest: "1.1.0" }];
	held.marketplaces = [
		{ name: "market", source: "someone/market" },
		{ name: "other", source: "someone/other" },
	];
	writeFileSync(file, JSON.stringify(held));

	await page.goto(`${s.url}/?token=${s.accessToken}#/plugins`);
	await expect(page.getByTestId("plugins-tab-overview")).toHaveAttribute("aria-selected", "true");
	await expect(page.getByTestId("plugins-stat-installed")).toContainText("1");
	await page.getByTestId("updates-check").click();
	const rows = page.getByTestId("update-row");
	await expect(rows).toHaveCount(2);
	await expect(page.getByTestId("plugins-stat-updates")).toContainText("2");
	// A tile's name is what it shows, its count among it: a screen reader reads the figures the tiles are for.
	await expect(page.getByTestId("plugins-stat-updates")).toHaveAccessibleName(/^Updates\s*2\s*2 available$/);
	await expect(page.getByTestId("plugins-stat-installed")).toHaveAccessibleName(/^Plugins\s*1\s*\d+ on · \d+ off$/);
	const skill = rows.filter({ hasText: "@acme/pdf-tools" });
	await expect(skill.getByTestId("update-versions")).toHaveText("1.1.0 → 1.2.0");
	await expect(rows.filter({ hasText: "hello@market" }).getByTestId("update-versions")).toHaveText("1.0.0 → 1.1.0");
	// A check refreshed the marketplaces' catalogs first.
	expect(readFileSync(join(s.home, ".fake-plugins-omp.calls"), "utf8")).toContain('["plugin","marketplace","update"]');

	await skill.getByTestId("update-select").check();
	await page.getByTestId("updates-selected").click();
	await expect(page.getByTestId("updates-confirm")).toBeVisible();
	await page.getByTestId("updates-confirm").click();
	await expect(page.getByTestId("plugins-outcome")).toHaveAttribute("data-state", "done");
	await expect(page.getByTestId("plugins-outcome")).toContainText("omp skill update @acme/pdf-tools -g");
	await expect(rows).toHaveCount(1);

	await page.getByTestId("updates-all").click();
	await page.getByTestId("updates-confirm").click();
	await expect(page.getByTestId("plugins-outcome")).toContainText("omp plugin upgrade hello@market --scope user");
	await expect(page.getByTestId("updates-none")).toBeVisible();
	const now = JSON.parse(readFileSync(file, "utf8"));
	expect(now.plugins[0].version).toBe("1.1.0");
	expect(now.skills[0].version).toBe("1.2.0");

	// Two marketplaces of several, refreshed together: each in turn.
	await page.getByTestId("plugins-tab-marketplaces").click();
	for (const name of ["market", "other"])
		await page
			.locator(`[data-testid="marketplace"][data-marketplace="${name}"]`)
			.getByTestId("marketplace-select")
			.check();
	await page.getByTestId("markets-update-selected").click();
	await expect(page.getByTestId("plugins-outcome")).toHaveAttribute("data-state", "done");
	await expect(page.getByTestId("plugins-outcome")).toContainText(
		"omp plugin marketplace update market\nomp plugin marketplace update other",
	);
});

test("Update all installs the updates its dialog listed, not one a check from elsewhere found since", async ({
	page,
}) => {
	const file = join(s.home, ".fake-plugins-omp.json");
	// What omp has: one marketplace plugin with a newer version in its catalog, and nothing else.
	const held = {
		marketplaces: [{ name: "market", source: "someone/market" }],
		skills: [],
		plugins: [{ id: "seen@market", scope: "user", version: "1.0.0", latest: "1.1.0" }],
	};
	writeFileSync(file, JSON.stringify(held));

	await page.goto(`${s.url}/?token=${s.accessToken}#/plugins`);
	await page.getByTestId("updates-check").click();
	const rows = page.getByTestId("update-row");
	await expect(rows).toHaveCount(1);
	await expect(page.getByTestId("updates-check")).toBeEnabled();

	// Another window checks again and finds one more; this page still lists the one it found.
	held.plugins.push({ id: "unseen@market", scope: "user", version: "1.0.0", latest: "2.0.0" });
	writeFileSync(file, JSON.stringify(held));
	const other = await page.context().newPage();
	await other.goto(`${s.url}/#/plugins`);
	await other.getByTestId("updates-check").click();
	await expect(other.getByTestId("update-row")).toHaveCount(2);
	await other.close();
	await expect(rows).toHaveCount(1);

	await page.getByTestId("updates-all").click();
	await expect(page.getByRole("dialog")).toContainText("seen@market");
	await expect(page.getByRole("dialog")).not.toContainText("unseen@market");
	await page.getByTestId("updates-confirm").click();
	await expect(page.getByTestId("plugins-outcome")).toHaveAttribute("data-state", "done");
	await expect(page.getByTestId("plugins-outcome")).toContainText("omp plugin upgrade seen@market --scope user");
	await expect(page.getByTestId("plugins-outcome")).not.toContainText("unseen@market");
	const now = JSON.parse(readFileSync(file, "utf8"));
	expect(now.plugins.map((p: { id: string; version: string }) => `${p.id} ${p.version}`)).toEqual([
		"seen@market 1.1.0",
		"unseen@market 1.0.0",
	]);
});

test.describe("in Chinese", () => {
	test.use({ locale: "zh-CN" });

	test("the tabs and the recommended card speak Chinese", async ({ page }) => {
		await openTab(page, "discover");
		await expect(page.getByTestId("plugins-tab-mcp")).toHaveText("MCP 服务器");
		await expect(page.getByTestId("plugins-recommended")).toContainText("推荐的插件市场");
		await expect(page.locator('[data-testid="recommended-marketplace"][data-marketplace="trailofbits"]')).toContainText(
			"Trail of Bits 的安全技能",
		);
	});
});
