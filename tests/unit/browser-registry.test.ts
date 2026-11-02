import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PageRegistry } from "../../server/browser/registry.ts";

/** A tab's page link follows the page: a tab whose page is replaced, or that was empty and now holds one, is found again. */

const work = mkdtempSync(join(tmpdir(), "ompw-browser-registry-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** A registry whose engine links each tab to whatever `holds` says it holds when asked. */
function setup(name: string) {
	const registry = new PageRegistry(join(work, `${name}.json`));
	registry.load("g");
	const holds = new Map<string, string>();
	const asked: string[] = [];
	registry.setEngine({
		close: async () => {},
		link: async (tabId) => {
			asked.push(tabId);
			const page = holds.get(tabId);
			if (page) registry.linkTab(tabId, { targetId: page, type: "page" });
		},
	});
	const settle = () => new Promise((r) => setTimeout(r, 0));
	return { registry, holds, asked, settle };
}

test("a tab whose page is replaced belongs to the owner of its new page, not the dead one", async () => {
	const { registry, holds, settle } = setup("replaced");
	registry.adopt("P1", "A");
	registry.adopt("P2", "B");
	holds.set("T", "P1");
	registry.track({ targetId: "P1", type: "page" });
	registry.track({ targetId: "T", type: "tab" });
	await settle();
	expect(registry.ownerOfTarget("T")).toBe("A");

	registry.untrack("P1");
	holds.set("T", "P2");
	registry.track({ targetId: "P2", type: "page" });
	registry.track({ targetId: "T", type: "tab" });
	await settle();
	expect(registry.ownerOfTarget("T")).toBe("B");
});

test("a tab found empty is asked about again once its address changes, not on every repeat", async () => {
	const { registry, holds, asked, settle } = setup("empty");
	registry.adopt("P", "A");
	registry.track({ targetId: "T", type: "tab", url: "" });
	await settle();
	expect(registry.ownerOfTarget("T")).toBeNull();
	registry.track({ targetId: "T", type: "tab", url: "" });
	await settle();
	expect(asked).toEqual(["T"]);

	holds.set("T", "P");
	registry.track({ targetId: "P", type: "page", url: "https://example.test/" });
	registry.track({ targetId: "T", type: "tab", url: "https://example.test/" });
	await settle();
	expect(asked).toEqual(["T", "T"]);
	expect(registry.ownerOfTarget("T")).toBe("A");
});
