import { afterAll, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../server/sessions/store.ts";
import { seedFixtures } from "../support/fixtures.ts";

const root = mkdtempSync(join(tmpdir(), "ompw-store-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("sessions created after start are listed and searchable when the sessions dir did not exist yet", async () => {
	const agentDir = join(root, "agent");
	const store = new SessionStore(join(agentDir, "sessions"), join(root, "index.db"));
	await store.refresh();
	expect(await store.list()).toEqual([]);

	// The store polls for the missing directory; wait for its change notification, not a fixed delay.
	const changed = new Promise<void>((resolve) => store.onChange(resolve));
	seedFixtures(agentDir);
	await changed;
	await store.refresh();
	expect((await store.list()).length).toBeGreaterThan(0);
	expect((await store.search("zebra")).length).toBeGreaterThan(0);
	store.close();
});

test("callers that ask while the first scan runs wait for it instead of reading an empty list", async () => {
	const agentDir = join(root, "concurrent");
	seedFixtures(agentDir);
	const store = new SessionStore(join(agentDir, "sessions"), join(root, "concurrent.db"));
	const [a, b, c] = await Promise.all([store.list(), store.list(), store.list()]);
	expect(a.length).toBeGreaterThan(0);
	expect(b.map((s) => s.file)).toEqual(a.map((s) => s.file));
	expect(c.map((s) => s.file)).toEqual(a.map((s) => s.file));
	store.close();
});

test("conversations written every 300 ms are announced while they are written, not only after", async () => {
	// Real file events and real pacing on purpose: the watcher's wiring has to let a steady stream through, and the OS's
	// file events cannot be driven by fake timers (the timing rule itself is in burst.test.ts).
	const agentDir = join(root, "dense");
	const fixtures = seedFixtures(agentDir);
	const store = new SessionStore(join(agentDir, "sessions"), join(root, "dense.db"));
	await store.list();
	let announced = 0;
	store.onChange(() => announced++);
	// The writing goes on until the store has announced twice: what is asserted is that it did so while it was written,
	// not how soon (every second or so when the machine is idle, later when it is not). A store that announces only once
	// the writing stops never does, and the writing ends at the cap.
	let writes = 0;
	while (announced < 2 && writes < 100) {
		appendFileSync(
			fixtures.alpha,
			`${JSON.stringify({ type: "message", id: `dense${writes}`, parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: `more ${writes}` }] } })}\n`,
		);
		writes++;
		await Bun.sleep(300);
	}
	store.close();
	expect(announced, `announcements in ${writes} writes`).toBeGreaterThanOrEqual(2);
}, 60_000);
