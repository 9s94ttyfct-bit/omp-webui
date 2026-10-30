import { expect, test } from "bun:test";
import { stopTurn } from "../../web/src/lib/stop.ts";

function fakeRpc(handler: (type: string) => unknown) {
	const calls: string[] = [];
	const rpc = async (command: Record<string, unknown>) => {
		const type = String(command.type);
		calls.push(type);
		return handler(type);
	};
	return { rpc, calls };
}

test("returns the withdrawn queue from abort_and_restore_queue", async () => {
	const { rpc, calls } = fakeRpc(() => ({ followUp: [{ text: "later" }] }));
	expect(await stopTurn(rpc)).toEqual({ followUp: [{ text: "later" }] });
	expect(calls).toEqual(["abort_and_restore_queue"]);
});

test("falls back to abort on runtimes that do not know abort_and_restore_queue", async () => {
	const { rpc, calls } = fakeRpc((type) => {
		if (type === "abort_and_restore_queue") throw new Error("Unknown command: abort_and_restore_queue");
		return undefined;
	});
	expect(await stopTurn(rpc)).toBeNull();
	expect(calls).toEqual(["abort_and_restore_queue", "abort"]);
});

test("other failures are reported, not hidden behind a second abort", async () => {
	const { rpc, calls } = fakeRpc(() => {
		throw new Error("Live session not found");
	});
	await expect(stopTurn(rpc)).rejects.toThrow("Live session not found");
	expect(calls).toEqual(["abort_and_restore_queue"]);
});
