import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyChange, type ConflictCheckResult } from "../../shared/guidance-conflict.ts";
import { writeSimpleSession } from "../support/fixtures.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { type StubScripted, startScriptedStub } from "../support/stub-scripted.ts";

/**
 * The guidance conflict check (v0.13.0) against the real omp, with a scripted provider in place of the model: what the
 * Guidance tab does after a save — the check (`POST /api/model-guidance/conflicts`) and then, only on the person's word, the
 * changes it proposes through the routes they always go through (the guidance's save, the Files tab's save). The check is
 * asked of omp the way the guard's reviewer is benchmarked (`omp -p`, the `smol` role here), and writes nothing.
 */

const CHECKER = "You check a coding agent's per-conversation guidance";
const AGENTS = "# Project rules\nAlways reply in Chinese.\nRun the tests before you commit.\n";

let server: TestServer;
let backend: StubScripted;
let project: string;
let session: string;

const conflictsFound = JSON.stringify({
	conflicts: [
		{
			guidance: "Reply in English. MARK-FOUND",
			source: "f1",
			other: "Always reply in Chinese.",
			why: "The two ask for different reply languages.",
			change: { target: "guidance", find: "Reply in English. MARK-FOUND", replace: "Reply in Chinese. MARK-FOUND" },
		},
		{
			guidance: "Never run the tests.",
			source: "f1",
			other: "Run the tests before you commit.",
			why: "One forbids what the other asks for.",
			change: { target: "source", find: "Run the tests before you commit.", replace: "Run the tests when asked to." },
		},
	],
});

beforeAll(async () => {
	backend = await startScriptedStub(async (req) => {
		if (!req.text.includes(CHECKER)) return { text: "A title" };
		if (req.text.includes("MARK-GARBAGE")) return { text: "I looked, and I think they mostly agree." };
		if (req.text.includes("MARK-FOUND")) return { text: conflictsFound };
		return { text: '{"conflicts":[]}' };
	});
	server = await startTestServer();
	writeFileSync(
		join(server.agentDir, "models.yml"),
		`providers:\n  omlx:\n    baseUrl: ${backend.url}\n    api: openai-completions\n    apiKey: ${backend.apiKey}\n    discovery:\n      type: openai-models-list\n`,
	);
	writeFileSync(
		join(server.agentDir, "config.yml"),
		[
			"modelRoles:",
			...["default", "smol", "slow", "tiny", "commit"].map((r) => `  ${r}: omlx/stub-model`),
			"spelling:",
			"  autocomplete: ngram",
			"",
		].join("\n"),
	);
	// The conversation's folder: a repository of its own (the walk stops there) with an AGENTS.md.
	project = join(server.work, "gc-project");
	mkdirSync(join(project, ".git"), { recursive: true });
	writeFileSync(join(project, "AGENTS.md"), AGENTS);
	session = writeSimpleSession(server.agentDir, 0xc1, "Guidance conflict check", undefined, project);
}, 120_000);

afterAll(async () => {
	await server?.stop();
	await backend?.stop();
});

const HEADERS = () => ({
	"x-omp-webui-token": server.accessToken,
	"x-omp-webui": "1",
	"content-type": "application/json",
});

async function post(path: string, body: unknown, extra: Record<string, string> = {}): Promise<Response> {
	return fetch(`${server.url}${path}`, {
		method: "POST",
		headers: { ...HEADERS(), ...extra },
		body: JSON.stringify(body),
	});
}

/** Save `text` as the conversation's guidance, as Save for this conversation does. */
async function saveGuidance(text: string): Promise<void> {
	const res = await post("/api/model-guidance/live", { file: session, guidance: { text } });
	expect(res.status).toBe(200);
}

async function check(text: string): Promise<ConflictCheckResult> {
	const res = await post("/api/model-guidance/conflicts", { file: session, text });
	expect(res.status).toBe(200);
	return (await res.json()) as ConflictCheckResult;
}

async function carried(): Promise<string | undefined> {
	const res = await fetch(`${server.url}/api/model-guidance/session?file=${encodeURIComponent(session)}`, {
		headers: HEADERS(),
	});
	return ((await res.json()) as { guidance: { text: string } | null }).guidance?.text;
}

const checks = () => backend.requests.filter((r) => r.text.includes(CHECKER));

const GUIDANCE = "## Model guidance\nReply in English. MARK-FOUND\nNever run the tests.";

test("conflicts found: each with a proposal, the folder's file untouched, and the same check not asked twice", async () => {
	await saveGuidance(GUIDANCE);
	const before = checks().length;
	const result = await check(GUIDANCE);
	if (result.state !== "found") throw new Error(`no conflicts: ${JSON.stringify(result)}`);
	expect(result.model).toBe("omlx/stub-model");
	expect(result.cached).toBe(false);
	expect(result.sources.map((s) => [s.id, s.kind, s.rel])).toEqual([["f1", "file", "AGENTS.md"]]);
	expect(result.conflicts.map((c) => c.change?.target)).toEqual(["guidance", "file"]);
	expect(result.conflicts[0].change).toMatchObject({
		diff: [
			{ kind: "same", text: "## Model guidance" },
			{ kind: "del", text: "Reply in English. MARK-FOUND" },
			{ kind: "add", text: "Reply in Chinese. MARK-FOUND" },
			{ kind: "same", text: "Never run the tests." },
		],
	});
	// The request was the check's, with the folder's file in it as data; and nothing was written.
	expect(checks().length).toBe(before + 1);
	expect(checks().at(-1)?.text).toContain("Always reply in Chinese.");
	expect(readFileSync(join(project, "AGENTS.md"), "utf8")).toBe(AGENTS);
	// The same text against the same files: the answer that was kept.
	expect(await check(GUIDANCE)).toMatchObject({ state: "found", cached: true });
	expect(checks().length).toBe(before + 1);
}, 120_000);

test("applying the guidance's change is a save of the conversation's own text", async () => {
	await saveGuidance(GUIDANCE);
	const result = await check(GUIDANCE);
	if (result.state !== "found") throw new Error("no conflicts");
	const change = result.conflicts[0].change;
	if (change?.target !== "guidance") throw new Error("not a guidance change");
	const next = applyChange((await carried()) ?? "", change.find, change.replace);
	expect(next).toBe("## Model guidance\nReply in Chinese. MARK-FOUND\nNever run the tests.");
	await saveGuidance(next as string);
	expect(await carried()).toBe(next as string);
	expect(readFileSync(join(project, "AGENTS.md"), "utf8")).toBe(AGENTS);
}, 120_000);

test("the AGENTS.md change is written only when applied, through the Files tab's save and its etag", async () => {
	await saveGuidance(GUIDANCE);
	const result = await check(GUIDANCE);
	if (result.state !== "found") throw new Error("no conflicts");
	const change = result.conflicts[1].change;
	if (change?.target !== "file") throw new Error("not a file change");
	expect(readFileSync(join(project, "AGENTS.md"), "utf8")).toBe(AGENTS);
	// Apply: read the file as the Files tab does, change it, save it with the etag it was read with.
	const read = await fetch(
		`${server.url}/api/folder/file?file=${encodeURIComponent(session)}&path=${encodeURIComponent(change.rel)}`,
		{ headers: HEADERS() },
	);
	expect(read.status).toBe(200);
	const shown = (await read.json()) as { kind: string; text: string; etag: string };
	const next = applyChange(shown.text, change.find, change.replace);
	expect(next).not.toBeNull();
	const saved = await post("/api/folder/file", { file: session, path: change.rel, text: next, etag: shown.etag });
	expect(saved.status).toBe(200);
	expect(readFileSync(join(project, "AGENTS.md"), "utf8")).toBe(
		"# Project rules\nAlways reply in Chinese.\nRun the tests when asked to.\n",
	);
	// The proposal no longer fits the file it was made for: applied again, it is refused rather than guessed.
	expect(applyChange(readFileSync(join(project, "AGENTS.md"), "utf8"), change.find, change.replace)).toBeNull();
	writeFileSync(join(project, "AGENTS.md"), AGENTS);
}, 120_000);

test("a model answer that is not the JSON asked for: the save stands, and the check says it could not be made", async () => {
	const text = "## Model guidance\nMARK-GARBAGE: at most 2 subagents.";
	await saveGuidance(text);
	expect(await check(text)).toEqual({ state: "failed", reason: "malformed", detail: "omlx/stub-model" });
	expect(await carried()).toBe(text);
}, 120_000);

test("no conflicts is clear; empty guidance is not checked", async () => {
	const before = checks().length;
	expect(await check("## Model guidance\nPrefer small diffs.")).toMatchObject({ state: "clear" });
	expect(await check("   ")).toEqual({ state: "empty" });
	expect(checks().length).toBe(before + 1);
}, 120_000);

test("a page that is not on this computer is refused, and nothing is asked", async () => {
	const before = checks().length;
	const res = await post(
		"/api/model-guidance/conflicts",
		{ file: session, text: GUIDANCE },
		{ "x-forwarded-for": "203.0.113.9" },
	);
	expect(res.status).toBe(403);
	expect(checks().length).toBe(before);
	// An unknown conversation, and a body that is not a check, are refused too.
	expect((await post("/api/model-guidance/conflicts", { file: "/nowhere.jsonl", text: GUIDANCE })).status).toBe(404);
	expect((await post("/api/model-guidance/conflicts", { file: session })).status).toBe(422);
});
