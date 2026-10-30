import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LiveInfo, LiveListing } from "../../shared/protocol.ts";
import { type AccessKey, type Jwks, makeKey, startJwks } from "../support/access-jwt.ts";
import { watchFrames } from "../support/frames.ts";
import { remoteClient, remoteSettings } from "../support/remote-client.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { type StubOmlx, startStubOmlx } from "../support/stub-omlx.ts";
import { connect, request } from "../support/ws.ts";

/**
 * A remote page changes nothing about a conversation's permission mode, and that holds across a restart of the server: the
 * app is quit and opened again, or the server crashes, and the conversation that was waiting out a usage limit is taken
 * over by the next server in the mode the user chose, with no mark that a remote page ever touched it (#589).
 */

const root = mkdtempSync(join(tmpdir(), "ompw-remote-restart-"));
const settingsFile = join(root, "remote.json");
const dist = join(root, "dist");
let key: AccessKey;
let jwks: Jwks;
let s: TestServer;
let backend: StubOmlx;
let remote: ReturnType<typeof remoteClient>;

beforeAll(async () => {
	key = await makeKey("kid-1");
	jwks = await startJwks([key]);
	mkdirSync(join(dist, "assets"), { recursive: true });
	writeFileSync(
		join(dist, "index.html"),
		'<!doctype html>\n<html><head></head><body><div="root"></div></body></html>\n',
	);
	writeFileSync(settingsFile, JSON.stringify(remoteSettings()));
	backend = await startStubOmlx({ limit: { status: 402 } });
	s = await startTestServer(
		0,
		{
			OMP_WEBUI_REMOTE_CONFIG: settingsFile,
			OMP_WEBUI_ACCESS_CERTS_URL: jwks.url,
			OMP_WEBUI_DIST: dist,
		},
		{ login: false },
	);
	remote = remoteClient(s, key);
	// A local model server that refuses with 402 (a billing cap), so a turn that hits the limit waits for the reset.
	writeFileSync(
		join(s.agentDir, "models.yml"),
		`providers:\n  omlx:\n    baseUrl: ${backend.url}\n    api: openai-completions\n    apiKey: ${backend.apiKey}\n    discovery:\n      type: openai-models-list\n`,
	);
	writeFileSync(
		join(s.agentDir, "config.yml"),
		[
			"modelRoles:",
			...["default", "smol", "slow", "tiny", "commit"].map((r) => `  ${r}: omlx/stub-model`),
			"spelling:",
			"  autocomplete: ngram",
			"retry:",
			"  maxDelayMs: 2000",
			"  waitForUsageReset: false",
			"",
		].join("\n"),
	);
}, 120_000);

afterAll(async () => {
	await s?.stop();
	await backend?.stop();
	jwks?.stop();
	rmSync(root, { recursive: true, force: true });
});

/** What the overlay of this process says: the mode omp is told to run in. */
function overlayMode(liveId: string): string | null {
	for (const dir of readdirSync(s.tmpDir).filter((n) => n.startsWith("ompw-live-"))) {
		const file = join(s.tmpDir, dir, `${liveId}.yml`);
		if (existsSync(file)) return /approvalMode: (\S+)/.exec(readFileSync(file, "utf8"))?.[1] ?? null;
	}
	return null;
}

test("a remote page that attached and sent a turn leaves the mode as it is, also after a restart (#589)", async () => {
	// The server's own switch: a turn that hits the provider's limit waits for the reset instead of failing.
	await fetch(`${s.url}/api/usage-reset-wait`, {
		method: "POST",
		headers: { "x-omp-webui-token": s.accessToken, "x-omp-webui": "1", "content-type": "application/json" },
		body: JSON.stringify({ enabled: true }),
	});
	const page = await connect(s);
	const live = await request<LiveInfo>(page, { t: "open", target: { kind: "new", cwd: s.work, approvalMode: "yolo" } });
	const frames = watchFrames(page, live.liveId);

	// The phone attaches: nothing about the conversation changes.
	const phone = (await remote.socket()) as WebSocket;
	const attached = await request<LiveInfo>(phone, { t: "attach", liveId: live.liveId });
	expect(attached.approvalMode).toBe("yolo");
	expect(attached).not.toHaveProperty("approvalForcedByRemote");
	expect(overlayMode(live.liveId)).toBe("yolo");

	// Its turn hits the provider's limit and waits for the reset.
	backend.limitUntil = Date.now() + 25_000;
	const started = frames.next((f) => f.type === "auto_retry_start");
	await request(phone, { t: "rpc", liveId: live.liveId, command: { type: "prompt", message: "from the phone" } });
	await started;
	expect(overlayMode(live.liveId)).toBe("yolo");
	phone.close();
	page.close();

	// The server ends and comes back: the conversation is taken over, waiting for the reset, in the mode the user chose.
	await s.restart();
	const again = await connect(s);
	const listed = (await request<LiveListing[]>(again, { t: "list_lives" })).find((l) => l.liveId === live.liveId);
	expect(listed?.retry).toBeDefined();
	expect(listed?.busy).toBe(true);
	expect(listed?.approvalMode).toBe("yolo");
	expect(listed).not.toHaveProperty("approvalForcedByRemote");
	expect(overlayMode(live.liveId)).toBe("yolo");
	await request(again, { t: "close", liveId: live.liveId }).catch(() => {});
	again.close();
}, 180_000);
