// needs: posixShell
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LiveInfo } from "../../shared/protocol.ts";
import { rejectionOf } from "../support/rejection.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { connect, request } from "../support/ws.ts";

/**
 * "Ask and remember" (`tools.approvalMode: always-ask-cached`) came with omp 18.12.3. An omp older than that does not know
 * the mode, so the conversation would run in another one while the page showed it (audit A-001): the server hands it to
 * no such omp, however it is asked (a new conversation's mode, a conversation's switcher, the default for new ones). The
 * omp here is the real one, saying it is 18.12.2 when asked its version.
 */

let s: TestServer;
let scratch = "";

beforeAll(async () => {
	const real = Bun.which("omp");
	if (!real) throw new Error("omp is not installed");
	scratch = mkdtempSync(join(tmpdir(), "ompw-old-omp-"));
	const wrapper = join(scratch, "omp");
	writeFileSync(
		wrapper,
		`#!/bin/sh\nif [ "$1" = "--version" ]; then echo "omp/18.12.2"; exit 0; fi\nexec "${real}" "$@"\n`,
	);
	chmodSync(wrapper, 0o755);
	s = await startTestServer(0, { OMP_BIN: wrapper }, { login: false });
}, 60_000);

afterAll(async () => {
	await s?.stop();
	if (scratch) rmSync(scratch, { recursive: true, force: true });
});

const api = (path: string, init: RequestInit = {}) =>
	fetch(`${s.url}${path}`, {
		...init,
		headers: { "x-omp-webui-token": s.accessToken, "x-omp-webui": "1", "content-type": "application/json" },
	});

const NEEDS = /always-ask-cached needs omp 18\.12\.3 or newer; this omp is 18\.12\.2/;

test("an omp older than 18.12.3 is never handed Ask and remember; the other modes still are", async () => {
	const meta = await (await api("/api/meta")).json();
	expect(meta.ompVersion).toBe("18.12.2");

	// The default for new conversations.
	const refused = await api("/api/approval", { method: "POST", body: JSON.stringify({ mode: "always-ask-cached" }) });
	expect(refused.status).toBe(400);
	expect(await refused.text()).toMatch(NEEDS);
	expect((await (await api("/api/approval")).json()).mode).toBeNull();
	const allowed = await api("/api/approval", { method: "POST", body: JSON.stringify({ mode: "always-ask" }) });
	expect(allowed.status).toBe(200);
	await api("/api/approval", { method: "POST", body: JSON.stringify({ mode: null }) });

	const ws = await connect(s);
	// A new conversation asked to start in it.
	expect(
		await rejectionOf(
			request(ws, { t: "open", target: { kind: "new", cwd: s.work, approvalMode: "always-ask-cached" } }),
		),
	).toThrow(NEEDS);

	// A running conversation's switcher.
	const live = await request<LiveInfo>(ws, {
		t: "open",
		target: { kind: "new", cwd: s.work, approvalMode: "always-ask" },
	});
	expect(live.approvalMode).toBe("always-ask");
	expect(
		await rejectionOf(request(ws, { t: "approval_mode", liveId: live.liveId, mode: "always-ask-cached" })),
	).toThrow(NEEDS);
	const write = await request<LiveInfo>(ws, { t: "approval_mode", liveId: live.liveId, mode: "write" });
	expect(write.approvalMode).toBe("write");

	await request(ws, { t: "close", liveId: live.liveId });
	ws.close();
}, 120_000);
