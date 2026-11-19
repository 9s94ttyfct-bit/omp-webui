import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { capabilities } from "../../server/platform/capabilities.ts";
import type { MacRecord } from "../../shared/macs.ts";
import type { LiveInfo, LiveListing } from "../../shared/protocol.ts";
import { pollUntil } from "../support/poll.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { connect, request } from "../support/ws.ts";

/**
 * A paused conversation given a computer for `remote_run` (#391), against the real omp and the real server (no model call).
 * Its omp is frozen and answers nothing: the tools are given when it is resumed, so neither the picker's request nor the
 * next server's takeover of it (which serves a conversation its computers before the server listens) waits for omp.
 */

let s: TestServer;

beforeAll(async () => {
	s = await startTestServer(0, {}, { login: false });
}, 120_000);

afterAll(async () => {
	await s?.stop();
});

const here = (path: string, method = "GET", body?: unknown) =>
	fetch(`${s.url}${path}`, {
		method,
		headers: {
			"x-omp-webui-token": s.accessToken,
			...(method !== "GET" ? { "x-omp-webui": "1", "content-type": "application/json" } : {}),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(20_000),
	});

const listed = async (liveId: string): Promise<LiveListing | undefined> =>
	((await (await here("/api/lives")).json()) as LiveListing[]).find((l) => l.liveId === liveId);

test.skipIf(!capabilities.pauseResume)(
	"a paused conversation is given a computer at once, the next server takes it over and listens, and resumed it has the tool (#391)",
	async () => {
		const added = await here("/api/macs", "POST", { name: "Studio", address: "mac.example.com" });
		expect(added.status).toBe(200);
		const mac = ((await added.json()) as { mac: MacRecord }).mac;

		const ws = await connect(s);
		const live = await request<LiveInfo>(ws, {
			t: "open",
			target: { kind: "new", cwd: s.work, approvalMode: "yolo" },
		});
		const id = live.liveId;
		await request(ws, { t: "pause", liveId: id });
		await pollUntil(
			() => existsSync(join(s.root, "data", "parked", `${id}.json`)),
			"the record of the paused conversation",
		);

		// Before, this request waited for the frozen omp for ever.
		const given = await here("/api/remote-run/live", "POST", { liveId: id, macIds: [mac.id] });
		expect(given.status).toBe(200);
		expect((await listed(id))?.remoteComputers).toEqual([mac.id]);
		ws.close();

		// Before, the next server's takeover served the frozen omp its computers and never listened.
		await s.restart();
		expect(await listed(id)).toMatchObject({ liveId: id, exited: false, remoteComputers: [mac.id] });

		const again = await connect(s);
		await request(again, { t: "attach", liveId: id });
		await request(again, { t: "resume", liveId: id });
		// What omp holds now, as its own `get_state` says (`dumpTools`).
		await pollUntil(async () => {
			const state = await request<{ dumpTools?: { name: string }[] }>(again, {
				t: "rpc",
				liveId: id,
				command: { type: "get_state" },
			});
			return (state.dumpTools ?? []).some((t) => t.name === "remote_run");
		}, "omp to hold remote_run");
		await request(again, { t: "close", liveId: id });
		again.close();
	},
	180_000,
);
