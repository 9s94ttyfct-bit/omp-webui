import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BenchInfo, BenchRun } from "../../shared/guard-bench.ts";
import { DEFAULT_POLICY, DEFAULT_POLICY_VERSION, type GuardRules } from "../../shared/guard-policy.ts";
import { type AccessKey, type Jwks, makeKey, startJwks } from "../support/access-jwt.ts";
import { writeFakeOmp } from "../support/fake-omp.ts";
import { messageWhere } from "../support/frames.ts";
import { pollUntil } from "../support/poll.ts";
import { remoteClient, remoteSettings } from "../support/remote-client.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { connect } from "../support/ws.ts";

/**
 * What the person tunes of the guard (#638), over HTTP against the real server: the reviewer's rules, a threshold per kind of
 * call and their own benchmark cases, kept in `guard.json` at 0600, for the page on this computer alone; and the benchmark,
 * which judges commands and runs none. The reviewer is the fake omp's print mode (`tests/support/fake-omp.ts`): it records
 * every command line it is given and answers deny to a message that names `rm -rf`. No model is called. A page that came
 * through the tunnel is refused; a page on the network is refused in `lan-local.test.ts`, which lists these routes too.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-guard-policy-"));
const bin = join(root, "bin");
const reviewLog = join(root, "review.jsonl");
const settingsFile = join(root, "remote.json");
const dist = join(root, "dist");
let s: TestServer;
let key: AccessKey;
let jwks: Jwks;
/** How many requests a whole run with the reviewer makes (known after the test that runs one). */
let wholeRun = 0;

const authed = (extra: Record<string, string> = {}) => ({
	"x-omp-webui-token": s.accessToken,
	"x-omp-webui": "1",
	...extra,
});
const post = (path: string, body: unknown) =>
	fetch(`${s.url}${path}`, {
		method: "POST",
		headers: authed({ "content-type": "application/json" }),
		body: JSON.stringify(body),
	});
const rulesNow = async (): Promise<GuardRules> =>
	((await (await fetch(`${s.url}/api/guard/rules`, { headers: authed() })).json()) as { rules: GuardRules }).rules;
const guardFile = () => join(s.root, "guard.json");
const mode = (path: string) => statSync(path).mode & 0o777;
/** The command lines the fake reviewer was given, in order. */
const reviewed = (): { argv: string[]; cwd: string }[] =>
	existsSync(reviewLog)
		? readFileSync(reviewLog, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l))
		: [];

beforeAll(async () => {
	key = await makeKey("kid-1");
	jwks = await startJwks([key]);
	mkdirSync(bin, { recursive: true });
	mkdirSync(join(dist, "assets"), { recursive: true });
	writeFileSync(
		join(dist, "index.html"),
		'<!doctype html>\n<html><head></head><body><div id="root"></div></body></html>\n',
	);
	writeFileSync(settingsFile, JSON.stringify(remoteSettings()));
	const fake = writeFakeOmp(bin, {
		models: [
			{ provider: "fake", id: "reviewer-a", cost: { output: 1 } },
			{ provider: "fake", id: "reviewer-b", cost: { output: 2 } },
		],
		// Slow enough that a run is still under way when the test cancels it.
		review: { log: reviewLog, delayMs: 250, deny: ["rm -rf", "rmtree", "rmSync", "-delete", "xargs rm"] },
	});
	s = await startTestServer(
		0,
		{
			OMP_BIN: fake,
			OMP_WEBUI_REMOTE_CONFIG: settingsFile,
			OMP_WEBUI_ACCESS_CERTS_URL: jwks.url,
			OMP_WEBUI_DIST: dist,
		},
		{ login: false },
	);
}, 120_000);

afterAll(async () => {
	await s?.stop();
	jwks?.stop();
	rmSync(root, { recursive: true, force: true });
});

describe("what the person tuned", () => {
	test("is kept in guard.json at 0600, said to every page on this computer, checked, and restored by null", async () => {
		const first = (await (await fetch(`${s.url}/api/guard/rules`, { headers: authed() })).json()) as {
			rules: GuardRules;
			defaults: { policy: string; policyVersion: number; floors: Record<string, string> };
		};
		// Nothing tuned yet, and the page is told the shipped default and what cannot be loosened.
		expect(first.rules).toEqual({});
		expect(first.defaults.policy).toBe(DEFAULT_POLICY);
		expect(first.defaults.policyVersion).toBe(DEFAULT_POLICY_VERSION);
		expect(first.defaults.floors).toMatchObject({ protected: "ask", unreadable: "ask" });

		const ws = await connect(s);
		const told = messageWhere(ws, (m) => m.t === "guard_config" && m.rules !== undefined);
		const res = await post("/api/guard/rules", {
			policy: { text: "Reading: allow.\nDeleting outside the project: block." },
			thresholds: { delete_outside: "block", write_outside: "allow" },
			cases: [{ id: "u-contract", label: "mine", command: "rm -rf ~/x", expect: "harmful" }],
		});
		expect(res.status).toBe(200);
		const kept = ((await res.json()) as { rules: GuardRules }).rules;
		expect(kept.thresholds).toEqual({ delete_outside: "block", write_outside: "allow" });
		expect(kept.policy?.basedOn).toBe(DEFAULT_POLICY_VERSION);
		expect(((await told) as unknown as { rules: GuardRules }).rules).toEqual(kept);
		ws.close();

		// On disk: the rules beside the mode, private to the user, and the same ones read back.
		expect(mode(guardFile())).toBe(0o600);
		const onDisk = JSON.parse(readFileSync(guardFile(), "utf8"));
		expect(onDisk.thresholds).toEqual({ delete_outside: "block", write_outside: "allow" });
		expect(onDisk.policy.text).toBe("Reading: allow.\nDeleting outside the project: block.");
		expect(onDisk.cases).toHaveLength(1);
		expect(await rulesNow()).toEqual(kept);
		// The mode is changed by the other route and leaves the rules alone.
		expect((await post("/api/guard", { mode: "ask" })).status).toBe(200);
		expect(await rulesNow()).toEqual(kept);
		expect(mode(guardFile())).toBe(0o600);

		// What cannot be loosened, an empty rule set, a text that is not text, an unknown kind: refused, nothing changes.
		for (const bad of [
			{ thresholds: { protected: "allow" } },
			{ thresholds: { unreadable: "allow" } },
			{ thresholds: { remote_tool: "block" } },
			{ thresholds: { mass_delete: "allow" } },
			{ thresholds: { nonsense: "block" } },
			{ thresholds: { delete_outside: "maybe" } },
			{ policy: { text: "" } },
			{ policy: { text: "a\u0000b" } },
			{ policy: { text: "x".repeat(6_001) } },
			{ cases: [{ id: "not-u", command: "ls", expect: "harmless" }] },
			{ nope: true },
			"off",
		]) {
			const refused = await post("/api/guard/rules", bad);
			expect(refused.status, JSON.stringify(bad).slice(0, 60)).toBe(400);
		}
		expect(await rulesNow()).toEqual(kept);

		// Restore default: the rules go and the default is not written to the file; the thresholds stay.
		expect((await post("/api/guard/rules", { policy: null })).status).toBe(200);
		expect(JSON.parse(readFileSync(guardFile(), "utf8")).policy).toBeUndefined();
		expect((await rulesNow()).thresholds).toEqual({ delete_outside: "block", write_outside: "allow" });
		expect(mode(guardFile())).toBe(0o600);
	}, 60_000);

	test("changed behind the server's back, the file is written again from what the server holds", async () => {
		const before = await rulesNow();
		writeFileSync(guardFile(), JSON.stringify({ mode: "ask", thresholds: { delete_outside: "allow" } }));
		await pollUntil(
			() => JSON.parse(readFileSync(guardFile(), "utf8")).thresholds?.delete_outside === "block",
			"the server to write its settings again",
		);
		expect(await rulesNow()).toEqual(before);
		expect(mode(guardFile())).toBe(0o600);
	}, 60_000);

	test("a page that came through the tunnel is refused the rules and the benchmark, and nothing is changed or started", async () => {
		const phone = remoteClient(s, key);
		const before = await rulesNow();
		for (const [path, method, body] of [
			["/api/guard/rules", "GET", undefined],
			["/api/guard/rules", "POST", JSON.stringify({ thresholds: { delete_outside: "allow" } })],
			["/api/guard/bench", "GET", undefined],
			["/api/guard/bench", "POST", JSON.stringify({ reviewer: true })],
			["/api/guard/bench/cancel", "POST", "{}"],
			["/api/guard/bench/preview", "POST", JSON.stringify({ thresholds: { delete_outside: "allow" } })],
			["/api/guard/log?q=rm", "GET", undefined],
		] as const) {
			const res = await phone.fetch(
				path,
				{ method, headers: method === "POST" ? { "x-omp-webui": "1", "content-type": "application/json" } : undefined },
				body,
			);
			expect(res.status, `${method} ${path}`).toBe(403);
		}
		expect(await rulesNow()).toEqual(before);
		const info = (await (await fetch(`${s.url}/api/guard/bench`, { headers: authed() })).json()) as BenchInfo;
		expect(info.run).toBeNull();
		expect(reviewed()).toEqual([]);
	}, 60_000);

	test("what an Allow would let through is tried first: the shipped harmful cases that would then run unasked, from the classifier alone", async () => {
		const none = await post("/api/guard/bench/preview", { thresholds: {} });
		expect(none.status).toBe(200);
		const idle = ((await none.json()) as { preview: { now: number; after: number; total: number } }).preview;
		expect(idle).toMatchObject({ now: 0, after: 0 });
		expect(idle.total).toBeGreaterThan(15);
		const res = await post("/api/guard/bench/preview", { thresholds: { delete_outside: "allow" } });
		expect(res.status).toBe(200);
		const { preview } = (await res.json()) as { preview: { now: number; after: number; ids: string[] } };
		expect(preview.now).toBe(0);
		expect(preview.after).toBeGreaterThan(0);
		// Only what carries nothing broader: the sweeps, the loops, the home folder stay Ask.
		expect(preview.ids).toContain("rm_folder");
		for (const id of ["rm_home_glob", "find_delete", "xargs_rm", "rsync_delete", "truncate_loop"])
			expect(preview.ids, id).not.toContain(id);
		// A trial changes nothing, and runs nothing.
		expect((await rulesNow()).thresholds?.delete_outside).not.toBe("allow");
		const info = (await (await fetch(`${s.url}/api/guard/bench`, { headers: authed() })).json()) as BenchInfo;
		expect(info.run).toBeNull();
		// What cannot be Allow cannot be tried as Allow; a bad body is refused; only POST.
		for (const bad of [
			{ thresholds: { mass_delete: "allow" } },
			{ thresholds: { protected: "allow" } },
			{ thresholds: { nope: "allow" } },
			{ thresholds: 5 },
			{},
		])
			expect((await post("/api/guard/bench/preview", bad)).status, JSON.stringify(bad)).toBe(400);
		expect((await fetch(`${s.url}/api/guard/bench/preview`, { headers: authed() })).status).toBe(405);
	}, 60_000);
});

/** Wait for the benchmark's run to be over, and give it. */
async function finished(): Promise<BenchRun> {
	let run: BenchRun | null = null;
	await pollUntil(
		async () => {
			run = ((await (await fetch(`${s.url}/api/guard/bench`, { headers: authed() })).json()) as BenchInfo).run;
			return run !== null && run.state !== "running";
		},
		"the benchmark to end",
		60_000,
	);
	return run as unknown as BenchRun;
}

/** Places a harmful case, if it were run, would have changed: none may exist after a run. */
function placesRun(): string[] {
	return [
		join(s.home, "Projects", "guard-benchmark"),
		join(s.home, "Documents"),
		join(s.home, "Pictures"),
		join(s.home, "Downloads", "report.pdf"),
		"/tmp/guard-benchmark.txt",
	];
}

describe("the benchmark", () => {
	test("with the classifier alone judges the shipped cases by the settings, asks no model, and creates nothing", async () => {
		await post("/api/guard", { mode: "reviewer", reviewer: "fake/reviewer-a", askWhenUnavailable: true });
		await post("/api/guard/rules", {
			thresholds: { delete_outside: "block", discard: "block", osascript: "block", write_outside: null },
			cases: [],
		});
		const existed = placesRun().map((p) => existsSync(p));
		const started = await post("/api/guard/bench", { reviewer: false });
		expect(started.status).toBe(200);
		const run = await finished();
		expect(run.state).toBe("done");
		expect(run.withReviewer).toBe(false);
		const of = (id: string) => run.results.find((r) => r.id === id);
		expect(of("rm_folder")).toMatchObject({ outcome: "blocked", by: "classifier", ok: true });
		expect(of("git_clean_outside")).toMatchObject({ outcome: "blocked", by: "classifier" });
		expect(of("trash_empty")).toMatchObject({ outcome: "blocked", by: "classifier" });
		// Left to the reviewer, which was not asked.
		expect(of("curl_sh")).toMatchObject({ outcome: "flagged", ok: null });
		expect(of("ls")).toMatchObject({ outcome: "allowed", ok: true, kinds: [] });
		expect(run.summary.harmful.stopped).toBeGreaterThanOrEqual(10);
		expect(run.requests).toBe(0);
		// Nothing was asked of any model, and nothing a case names was created.
		expect(reviewed()).toEqual([]);
		expect(placesRun().map((p) => existsSync(p))).toEqual(existed);
	}, 120_000);

	test("with the reviewer asks the fake omp's print mode for what the settings leave to it, with the person's rules, and runs nothing", async () => {
		await post("/api/guard/rules", {
			policy: { text: "Anything that deletes: block.\nThe rest: allow." },
			thresholds: { delete_outside: null, discard: null, osascript: null, write_outside: null },
		});
		const existed = placesRun().map((p) => existsSync(p));
		const started = await post("/api/guard/bench", { reviewer: true });
		expect(started.status).toBe(200);
		// One run at a time.
		expect((await post("/api/guard/bench", { reviewer: true })).status).toBe(409);
		const run = await finished();
		expect(run.state).toBe("done");
		expect(run.withReviewer).toBe(true);
		expect(run.reviewers).toEqual(["fake/reviewer-a"]);
		const of = (id: string) => run.results.find((r) => r.id === id);
		expect(of("rm_folder")).toMatchObject({ outcome: "blocked", by: "reviewer", model: "fake/reviewer-a", ok: true });
		expect(of("copy_downloads")).toMatchObject({ outcome: "allowed", by: "reviewer", ok: true });
		expect(of("ls")).toMatchObject({ outcome: "allowed", by: "classifier" });

		// What omp was asked, each time: print mode, no tools, no session, no extensions; the person's rules as the system prompt.
		const calls = reviewed();
		expect(calls.length).toBe(run.requests);
		expect(calls.length).toBeGreaterThan(10);
		wholeRun = calls.length;
		for (const call of calls) {
			expect(call.argv).toContain("-p");
			for (const flag of ["--no-tools", "--no-session", "--no-extensions", "--no-skills", "--no-rules"])
				expect(call.argv, flag).toContain(flag);
			expect(call.argv).not.toContain("--mode");
			expect(
				call.argv.some((a) => a.startsWith("--system-prompt=") && a.includes("Anything that deletes: block.")),
			).toBe(true);
			expect(call.argv.some((a) => a === "--model=fake/reviewer-a")).toBe(true);
		}
		// Nothing a case names was created or removed: only read, by the classifier and the model.
		expect(placesRun().map((p) => existsSync(p))).toEqual(existed);
		expect(existsSync(join(s.home, "Projects"))).toBe(false);
	}, 120_000);

	test("a Cancel ends the run: no case is started after it, and the requests under way are ended", async () => {
		const before = reviewed().length;
		expect((await post("/api/guard/bench", { reviewer: true })).status).toBe(200);
		await pollUntil(() => reviewed().length > before, "the first request of the run");
		const cancelled = (await (await post("/api/guard/bench/cancel", {})).json()) as { cancelled: boolean };
		expect(cancelled.cancelled).toBe(true);
		const run = await finished();
		expect(run.state).toBe("cancelled");
		const asked = reviewed().length - before;
		expect(wholeRun).toBeGreaterThan(10);
		expect(asked).toBeGreaterThan(0);
		expect(asked).toBeLessThan(wholeRun);
		// A second Cancel finds nothing to end.
		const again = (await (await post("/api/guard/bench/cancel", {})).json()) as { cancelled: boolean };
		expect(again.cancelled).toBe(false);
	}, 120_000);

	test("without Reviewer mode there is no reviewer to use: the run is the classifier's, whatever is asked", async () => {
		await post("/api/guard", { mode: "ask" });
		const before = reviewed().length;
		expect(
			((await (await fetch(`${s.url}/api/guard/bench`, { headers: authed() })).json()) as BenchInfo).reviewerAvailable,
		).toBe(false);
		expect((await post("/api/guard/bench", { reviewer: true })).status).toBe(200);
		const run = await finished();
		expect(run.withReviewer).toBe(false);
		expect(run.results.find((r) => r.id === "rm_folder")).toMatchObject({ outcome: "asked", by: "person" });
		expect(reviewed().length).toBe(before);
	}, 120_000);
});
