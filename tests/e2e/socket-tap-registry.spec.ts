import { openSidebar, startLive } from "../support/live.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { sessionWithSubagents } from "../support/subagent-fixtures.ts";
import { expect, test } from "./fixtures.ts";

/**
 * The spec helper itself (#772): omp's registry (`get_subagents`) as the tapped page reads it agrees with the subagent
 * frames a spec pushed, so a pushed subagent is not taken to have ended the next time the page reads the registry (the
 * #748 kind of drift). An answer the spec sets itself still wins. No model call.
 */

const listedIds = (data: unknown): string[] => {
	const list = (data as { subagents?: { id: string }[] } | undefined)?.subagents ?? [];
	return list.map((s) => s.id).sort();
};

test("a re-read registry lists the subagents pushed as running and not those pushed as over, and a spec's own answer wins", async ({
	page,
}) => {
	const title = "Tap registry probe";
	sessionWithSubagents(0x5e, title, {});
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	await openSidebar(page);
	const liveId = await startLive(page, tap, title, "tap-registry-probe");
	const frame = (f: Record<string, unknown>) => tap.push({ t: "frame", liveId, frame: f });
	const lifecycle = (id: string, status: string) =>
		frame({ type: "subagent_lifecycle", payload: { id, agent: "explore", index: 0, status } });
	lifecycle("Scout", "started");
	lifecycle("Mapper", "started");
	lifecycle("Mapper", "completed");

	// The page reads the registry again when it attaches after a reload: the real omp knows of neither subagent.
	const before = tap.replies("get_subagents").length;
	await page.reload();
	await expect.poll(() => tap.replies("get_subagents").length).toBeGreaterThan(before);
	expect(listedIds(tap.replies("get_subagents").at(-1))).toEqual(["Scout"]);

	// A spec that says what the registry lists is answered with that, not with what it pushed: the real server is not asked.
	tap.answer("get_subagents", () => ({ ok: true, data: { subagents: [] } }));
	const fromServer = tap.replies("get_subagents").length;
	const asked = tap.commands("get_subagents").length;
	await page.reload();
	await expect.poll(() => tap.commands("get_subagents").length).toBeGreaterThan(asked);
	expect(tap.replies("get_subagents").length).toBe(fromServer);
});
