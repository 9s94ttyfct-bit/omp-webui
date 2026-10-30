import "./browser-globals.ts";
import { afterAll, beforeAll, beforeEach, expect, type Mock, spyOn, test } from "bun:test";
import { sessionActions } from "../../web/src/lib/api.ts";
import { socket } from "../../web/src/lib/ws.ts";
import { watchUsageWait } from "../../web/src/store/usage-wait.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

/**
 * What the page asks the server for omp's `retry.waitForUsageReset` and the choices made for conversations: when it
 * reconnects it asks again for what is on screen, not for every conversation whose quota popover was ever opened.
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);

let asked: Mock<typeof sessionActions.usageWait>;
let status: (connected: boolean) => void = () => {};
const socketSpies: Mock<never>[] = [];
beforeAll(() => {
	socketSpies.push(spyOn(socket, "on").mockImplementation(() => () => {}) as Mock<never>);
	socketSpies.push(
		spyOn(socket, "onStatus").mockImplementation((fn) => {
			status = fn;
			return () => {};
		}) as Mock<never>,
	);
});
afterAll(() => {
	for (const spy of socketSpies) spy.mockRestore();
	asked?.mockRestore();
});
beforeEach(() => {
	asked?.mockRestore();
	asked = spyOn(sessionActions, "usageWait").mockImplementation(async () => ({ omp: false, session: null }));
});
/** What the page asks for after a reconnect. */
async function reconnect(): Promise<(string | null)[]> {
	asked.mockClear();
	status(true);
	await Promise.resolve();
	return asked.mock.calls.map(([file]) => file);
}

test("after a reconnect the page asks for omp's own value and for the conversations on screen, not for ones it showed before", async () => {
	const stopA = watchUsageWait("/sessions/a.jsonl");
	const stopB = watchUsageWait("/sessions/b.jsonl");
	const stopC = watchUsageWait("/sessions/c.jsonl");
	expect((await reconnect()).sort()).toEqual(
		[null, "/sessions/a.jsonl", "/sessions/b.jsonl", "/sessions/c.jsonl"].sort(),
	);

	// The popovers of B and C closed (another conversation was opened): they are not asked about again.
	stopB();
	stopC();
	expect((await reconnect()).sort()).toEqual([null, "/sessions/a.jsonl"].sort());

	stopA();
	expect(await reconnect()).toEqual([null]);
});

test("a conversation shown in two places stays asked about until both are gone", async () => {
	const first = watchUsageWait("/sessions/d.jsonl");
	const second = watchUsageWait("/sessions/d.jsonl");
	first();
	expect(await reconnect()).toContain("/sessions/d.jsonl");
	second();
	expect(await reconnect()).not.toContain("/sessions/d.jsonl");
});
