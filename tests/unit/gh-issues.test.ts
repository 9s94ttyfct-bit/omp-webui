import { expect, test } from "bun:test";
import { join } from "node:path";
import { GhIssues, type GhRan, type GhRun, problemOf } from "../../server/gh-issues.ts";
import { tempDir } from "../support/temp-dirs.ts";

/**
 * The Issues tab's reader (#653): what it asks the person's `gh`, how it reads the answer, and what it says when there is
 * none. Against a scripted `gh` and git: nothing here reaches GitHub.
 */

const DIR = tempDir("ompw-gh-issues-");

const ISSUE = {
	number: 7,
	title: "Crash on start",
	state: "OPEN",
	labels: [
		{ name: "bug", color: "d73a4a" },
		{ name: "odd", color: "not-hex" },
	],
	author: { login: "ana" },
	assignees: [{ login: "bo" }],
	createdAt: "2026-10-01T10:00:00Z",
	updatedAt: "2026-10-02T10:00:00Z",
	url: "https://github.com/o/r/issues/7",
};

/** A world where git answers as a clean repository does, and `gh` as scripted; every command is noted. */
function world(gh: (argv: string[]) => GhRan, git: { config?: string; repo?: boolean } = {}) {
	const ran: string[][] = [];
	let clock = 1000;
	const run: GhRun = async (argv) => {
		ran.push(argv);
		if (argv[0] === "git" && argv[1] === "rev-parse") {
			return git.repo === false
				? { code: 128, stdout: "", stderr: "fatal: not a git repository" }
				: { code: 0, stdout: `${join(DIR, ".git", "info", "attributes")}\n`, stderr: "" };
		}
		if (argv[0] === "git" && argv[1] === "config") return { code: 0, stdout: git.config ?? "", stderr: "" };
		return gh(argv);
	};
	const reader = new GhIssues({ run, env: {}, now: () => clock });
	return {
		reader,
		ghCalls: () => ran.filter((a) => a[0] === "gh"),
		advance: (ms: number) => {
			clock += ms;
		},
	};
}

const ok = (value: unknown): GhRan => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });

test("a list is read from gh's JSON: state and search are passed on, labels and logins kept, an issue without a web address dropped", async () => {
	const w = world(() => ok([ISSUE, { ...ISSUE, number: 8, url: "javascript:alert(1)" }, { title: "no number" }]));
	const answer = await w.reader.list(DIR, { state: "all", search: "  label:bug crash  " });
	expect(answer).toEqual({
		ok: true,
		value: [
			{
				number: 7,
				title: "Crash on start",
				state: "open",
				labels: [{ name: "bug", color: "d73a4a" }, { name: "odd" }],
				author: "ana",
				assignees: ["bo"],
				createdAt: "2026-10-01T10:00:00Z",
				updatedAt: "2026-10-02T10:00:00Z",
				url: "https://github.com/o/r/issues/7",
			},
		],
	});
	const [argv] = w.ghCalls();
	expect(argv?.slice(0, 3)).toEqual(["gh", "issue", "list"]);
	expect(argv?.[argv.indexOf("--state") + 1]).toBe("all");
	expect(argv?.[argv.indexOf("--search") + 1]).toBe("label:bug crash");
});

test("one issue comes with its body and comments; a number that is not one is refused without asking gh", async () => {
	const w = world(() =>
		ok({
			...ISSUE,
			state: "CLOSED",
			body: "It **crashes**.",
			comments: [{ author: { login: "bo" }, body: "Same here", createdAt: "2026-10-03T00:00:00Z" }, { body: 5 }],
		}),
	);
	const answer = await w.reader.view(DIR, 7);
	expect(answer.ok && answer.value.state).toBe("closed");
	expect(answer.ok && answer.value.body).toBe("It **crashes**.");
	expect(answer.ok && answer.value.comments).toEqual([
		{ author: "bo", body: "Same here", createdAt: "2026-10-03T00:00:00Z" },
	]);
	expect(w.ghCalls()[0]?.slice(0, 4)).toEqual(["gh", "issue", "view", "7"]);

	expect(await w.reader.view(DIR, 0)).toEqual({ ok: false, problem: "failed", message: "Not an issue number" });
	expect(await w.reader.view(DIR, 1.5)).toMatchObject({ ok: false });
	expect(w.ghCalls()).toHaveLength(1);
});

test("what gh cannot do is said as the page's problems", async () => {
	expect(await world(() => "missing").reader.list(DIR, { state: "open" })).toEqual({ ok: false, problem: "no-gh" });
	expect(await world(() => "slow").reader.list(DIR, { state: "open" })).toEqual({ ok: false, problem: "slow" });
	const failing = (stderr: string) =>
		world(() => ({ code: 1, stdout: "", stderr })).reader.list(DIR, { state: "open" });
	expect(await failing("To get started with GitHub CLI, please run:  gh auth login")).toEqual({
		ok: false,
		problem: "signed-out",
	});
	expect(await failing("none of the git remotes configured for this repository point to a known GitHub host")).toEqual({
		ok: false,
		problem: "no-repo",
	});
	expect(await failing("\nHTTP 502: Bad gateway\nmore")).toEqual({
		ok: false,
		problem: "failed",
		message: "HTTP 502: Bad gateway",
	});
	expect(
		await world(() => ({ code: 0, stdout: "not json", stderr: "" })).reader.list(DIR, { state: "open" }),
	).toMatchObject({
		ok: false,
		problem: "failed",
	});
	expect(problemOf("")).toEqual({ problem: "failed" });
});

test("a folder that is not a repository, or whose repository names a command, is not handed to gh", async () => {
	const notRepo = world(() => ok([]), { repo: false });
	expect(await notRepo.reader.list(DIR, { state: "open" })).toEqual({ ok: false, problem: "no-repo" });
	expect(notRepo.ghCalls()).toHaveLength(0);

	const unsafe = world(() => ok([]), { config: "local\0core.fsmonitor\n./watch\0" });
	const answer = await unsafe.reader.list(DIR, { state: "open" });
	expect(answer).toMatchObject({ ok: false, problem: "unsafe" });
	expect(unsafe.ghCalls()).toHaveLength(0);
});

test("an answer is kept for a moment, Refresh asks again, and a failure is not kept", async () => {
	let fail = false;
	const w = world(() => (fail ? { code: 1, stdout: "", stderr: "gh auth login" } : ok([ISSUE])));
	await w.reader.list(DIR, { state: "open" });
	await w.reader.list(DIR, { state: "open" });
	expect(w.ghCalls()).toHaveLength(1);
	// Another filter is another question.
	await w.reader.list(DIR, { state: "closed" });
	expect(w.ghCalls()).toHaveLength(2);
	await w.reader.list(DIR, { state: "open", fresh: true });
	expect(w.ghCalls()).toHaveLength(3);
	w.advance(31_000);
	fail = true;
	expect(await w.reader.list(DIR, { state: "open" })).toEqual({ ok: false, problem: "signed-out" });
	// Signing in is the fix: the next look asks again.
	fail = false;
	expect((await w.reader.list(DIR, { state: "open" })).ok).toBe(true);
	expect(w.ghCalls()).toHaveLength(5);
});
