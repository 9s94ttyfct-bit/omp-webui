import { afterAll, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forkArgs, routeOf, sameModel, snapshotSession, sweepForkDir, withTopic } from "../../server/omp/btw-fork.ts";
import { isValidPref, PREF } from "../../shared/prefs.ts";

/** The decisions of a side question on another model that need no omp: who answers, how it is started, what it is given. */

describe("who answers a side question", () => {
	const own = { local: false };

	test("omp does, when nothing is chosen or the choice is the model the conversation runs on (a thinking level aside)", () => {
		expect(routeOf({ ...own, choice: null, current: "a/x" })).toEqual({ by: "omp" });
		expect(routeOf({ ...own, choice: "a/x", current: "a/x" })).toEqual({ by: "omp" });
		expect(routeOf({ ...own, choice: "a/x:high", current: "a/x" })).toEqual({ by: "omp" });
		expect(routeOf({ ...own, choice: "a/x", current: null })).toEqual({ by: "fork", model: "a/x" });
	});

	test("a process of the server's does, on the chosen model, for any other", () => {
		expect(routeOf({ ...own, choice: "b/y", current: "a/x" })).toEqual({ by: "fork", model: "b/y" });
		expect(routeOf({ ...own, choice: "a/z", current: "a/x" })).toEqual({ by: "fork", model: "a/z" });
	});

	test("on a local server, only the server the conversation runs on can be asked: any other provider is omp's own answer", () => {
		const local = { local: true };
		expect(routeOf({ ...local, choice: "ollama/small", current: "ollama/big" })).toEqual({
			by: "fork",
			model: "ollama/small",
		});
		expect(routeOf({ ...local, choice: "anthropic/claude", current: "ollama/big" })).toEqual({ by: "omp" });
		expect(routeOf({ ...local, choice: "ollama/small", current: null })).toEqual({ by: "omp" });
	});

	test("two selectors name one model when provider and id agree", () => {
		expect(sameModel("a/x", "a/x:low")).toBe(true);
		expect(sameModel("a/x", "a/y")).toBe(false);
		expect(sameModel("a/x", null)).toBe(false);
		expect(sameModel("not a selector", "not a selector")).toBe(false);
	});
});

describe("the command line of the process that answers", () => {
	const conversation = [
		"--config",
		"/data/omp-overlay.yml",
		"--extension",
		"/data/gate/extension.ts",
		"--profile",
		"work",
		"--resume",
		"/sessions/a.jsonl",
		"--model",
		"anthropic/old",
		"--thinking=high",
		"--session-dir=/elsewhere",
		"--allow-home",
		"--goal",
		"ship it",
		"-c",
		"--no-session",
	];

	test("keeps what the conversation was started with, binds it to the copy and the chosen model, and its overlay is the copy, last", () => {
		expect(
			forkArgs(conversation, { model: "omlx/new", session: "/run/session.jsonl", overlay: "/run/overlay.yml" }),
		).toEqual([
			"--config",
			"/data/omp-overlay.yml",
			"--extension",
			"/data/gate/extension.ts",
			"--profile",
			"work",
			"--thinking=high",
			"--allow-home",
			"--model",
			"omlx/new",
			"--resume",
			"/run/session.jsonl",
			"--config",
			"/run/overlay.yml",
		]);
	});

	test("a conversation with no file is asked on no session; no overlay adds no --config", () => {
		const args = forkArgs(["--resume", "--model=a/b", "--tools", "read"], {
			model: "c/d",
			session: null,
			overlay: null,
		});
		expect(args).toEqual(["--tools", "read", "--model", "c/d", "--no-session"]);
	});

	test("a flag with no value is not given the flag after it", () => {
		expect(forkArgs(["--resume", "--allow-home"], { model: "c/d", session: "/s", overlay: null })).toEqual([
			"--allow-home",
			"--model",
			"c/d",
			"--resume",
			"/s",
		]);
	});

	test("every other way to bind a process to a session or to import one is left out: --session, --fork, --from-claude, --from-codex", () => {
		const args = forkArgs(
			["--session", "abc", "--fork=def", "--from-claude", "--from-codex", "--thinking=low", "--fork", "ghi"],
			{ model: "c/d", session: "/run/s.jsonl", overlay: null },
		);
		expect(args).toEqual(["--thinking=low", "--model", "c/d", "--resume", "/run/s.jsonl"]);
	});
});

describe("the copy of the conversation", () => {
	const dir = mkdtempSync(join(tmpdir(), "ompw-btw-fork-unit-"));
	const line = (n: number) => `${JSON.stringify({ type: "message", n })}\n`;
	afterAll(() => rmSync(dir, { recursive: true, force: true }));

	test("ends at the last whole line, and is this user's alone", async () => {
		const from = join(dir, "torn.jsonl");
		writeFileSync(from, `${line(1)}${line(2)}{"type":"message","n":3,"te`);
		const to = join(dir, "torn-copy.jsonl");
		await snapshotSession(from, to);
		expect(readFileSync(to, "utf8")).toBe(`${line(1)}${line(2)}`);
		expect(statSync(to).mode & 0o777).toBe(0o600);
		// The conversation's own file is not the copy's to change.
		expect(readFileSync(from, "utf8")).toBe(`${line(1)}${line(2)}{"type":"message","n":3,"te`);
	});

	test("a whole file is copied as it is; a last line longer than a read is cut back to the one before it", async () => {
		const whole = join(dir, "whole.jsonl");
		writeFileSync(whole, `${line(1)}${line(2)}`);
		await snapshotSession(whole, join(dir, "whole-copy.jsonl"));
		expect(readFileSync(join(dir, "whole-copy.jsonl"), "utf8")).toBe(`${line(1)}${line(2)}`);

		const long = join(dir, "long.jsonl");
		writeFileSync(long, `${line(1)}{"type":"message","pad":"${"x".repeat(200_000)}`);
		await snapshotSession(long, join(dir, "long-copy.jsonl"));
		expect(readFileSync(join(dir, "long-copy.jsonl"), "utf8")).toBe(line(1));
	});

	test("with no whole line at all there is nothing to give, and an empty file stays empty", async () => {
		const partial = join(dir, "partial.jsonl");
		writeFileSync(partial, '{"type":"sess');
		await snapshotSession(partial, join(dir, "partial-copy.jsonl"));
		expect(readFileSync(join(dir, "partial-copy.jsonl"), "utf8")).toBe("");
		const empty = join(dir, "empty.jsonl");
		writeFileSync(empty, "");
		await snapshotSession(empty, join(dir, "empty-copy.jsonl"));
		expect(readFileSync(join(dir, "empty-copy.jsonl"), "utf8")).toBe("");
	});
});

describe("a follow-up", () => {
	const turn = (question: string, answer: string) => ({
		question,
		answer,
		status: "complete" as const,
		createdAt: 1,
		updatedAt: 1,
	});

	test("is the question alone when the topic has no answer yet, else the topic's turns come first, in order", () => {
		expect(withTopic("and then?", [{ ...turn("q1", ""), status: "running" }])).toBe("and then?");
		const text = withTopic("and then?", [turn("q1", "a1"), turn("q2", "a2")]);
		expect(text.indexOf("q1")).toBeLessThan(text.indexOf("a1"));
		expect(text.indexOf("a1")).toBeLessThan(text.indexOf("q2"));
		expect(text.endsWith("Follow-up question: and then?")).toBe(true);
	});

	test("keeps the newest turns when the topic is longer than a model is shown", () => {
		const turns = Array.from({ length: 10 }, (_, i) => turn(`question ${i}`, `answer ${i} ${"x".repeat(6000)}`));
		const text = withTopic("last?", turns);
		expect(text).toContain("question 9");
		expect(text).not.toContain("question 0");
		expect(text.length).toBeLessThan(30_000);
	});
});

describe("the preference", () => {
	test("holds one model as provider/id, and nothing an alias, a list or a pattern could be", () => {
		for (const good of [
			"omlx/m-side",
			"anthropic/claude-haiku-5-5",
			"openrouter/meta/llama-3.3-70b:free",
			"a/b:high",
		]) {
			expect(isValidPref(PREF.btwModel, good), good).toBe(true);
		}
		for (const bad of ["opus", "pi/slow", "a/b,c/d", "a/*", "a/ b", "/b", "a/", ""]) {
			expect(isValidPref(PREF.btwModel, bad), bad).toBe(false);
		}
	});
});

describe("what a server that was killed left behind", () => {
	const base = mkdtempSync(join(tmpdir(), "ompw-btw-sweep-"));
	afterAll(() => rmSync(base, { recursive: true, force: true }));

	test("only the run-* folders are removed: a link, a file, another name and a btw-fork that is a link stay", () => {
		const data = join(base, "data");
		const forks = join(data, "btw-fork");
		mkdirSync(join(forks, "run-abc123"), { recursive: true });
		writeFileSync(join(forks, "run-abc123", "session.jsonl"), "x");
		mkdirSync(join(forks, "run-def456"));
		const elsewhere = join(base, "elsewhere");
		mkdirSync(elsewhere);
		writeFileSync(join(elsewhere, "keep.txt"), "mine");
		symlinkSync(elsewhere, join(forks, "run-lnk789"));
		writeFileSync(join(forks, "run-fil012"), "a file");
		mkdirSync(join(forks, "other"));
		mkdirSync(join(forks, "run-toolongname"));

		sweepForkDir(data);
		expect(readdirSync(forks).sort()).toEqual(["other", "run-fil012", "run-lnk789", "run-toolongname"]);
		expect(readFileSync(join(elsewhere, "keep.txt"), "utf8")).toBe("mine");

		// A btw-fork that is itself a link to a folder holding a run-* folder: nothing under it is touched.
		const data2 = join(base, "data2");
		const target = join(base, "target");
		mkdirSync(join(target, "run-abc123"), { recursive: true });
		mkdirSync(data2);
		symlinkSync(target, join(data2, "btw-fork"));
		sweepForkDir(data2);
		expect(readdirSync(target)).toEqual(["run-abc123"]);

		// No folder at all is no work.
		expect(() => sweepForkDir(join(base, "none"))).not.toThrow();
	});
});
