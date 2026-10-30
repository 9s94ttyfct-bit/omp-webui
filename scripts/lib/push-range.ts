/**
 * Which commits are about to be published, as `git rev-list` arguments: what the commit checks (scripts/check-authors.ts,
 * scripts/check-personal.ts --range) read.
 *
 * - `--pre-push <remote>` (the git hooks of scripts/install-hooks.ts): what each pushed ref adds to that remote, read from
 *   the refs git writes to the hook's stdin.
 * - rev-list arguments given (`origin/main..HEAD`): those.
 * - in GitHub Actions (`GITHUB_EVENT_PATH`): a push's commits (`before..after`; a new branch, or a `before` that is not
 *   in the clone after a force push, reads all of `after`'s history), or a pull request's (`base..head`). The checkout
 *   needs the history (`fetch-depth: 0`).
 * - otherwise: the commits of HEAD that no `origin` branch has yet (every commit, in a clone without `origin`).
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const ZERO = /^0+$/;

export function git(cwd: string, args: string[]): { code: number; out: string; err: string } {
	const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 30 });
	return { code: r.status ?? 1, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

/** The `git rev-list` arguments for a GitHub Actions event, or null when the event has no commits to read. */
export function eventRange(cwd: string, eventName: string, event: Record<string, unknown>): string[] | null {
	if (eventName === "pull_request" || eventName === "pull_request_target") {
		const pr = event.pull_request as { base: { sha: string }; head: { sha: string } };
		return [`${pr.base.sha}..${pr.head.sha}`];
	}
	if (eventName === "push") {
		const before = String(event.before ?? "");
		const after = String(event.after ?? "");
		if (!after || ZERO.test(after)) return null; // a deleted branch
		if (!before || ZERO.test(before) || git(cwd, ["cat-file", "-e", `${before}^{commit}`]).code !== 0) return [after];
		return [`${before}..${after}`];
	}
	return null;
}

/** The rev-list arguments for what a push adds to `remote`, from the lines git gives a pre-push hook. */
export function prePushRange(remote: string, stdin: string): string[] {
	const tips = stdin
		.split("\n")
		.map((line) => line.trim().split(/\s+/))
		.filter((f) => f.length === 4 && !ZERO.test(f[1]))
		.map((f) => f[1]);
	return tips.length > 0 ? [...tips, "--not", `--remotes=${remote}`] : [];
}

/** The commits about to be published, chosen by `args` and the environment as the header says, and how to name them. */
export function publishRange(cwd: string, args: string[]): { range: string[]; what: string } {
	if (args[0] === "--pre-push") {
		const remote = args[1] || "origin";
		return { range: prePushRange(remote, readFileSync(0, "utf8")), what: `the push to ${remote}` };
	}
	if (args.length > 0) return { range: args, what: args.join(" ") };
	if (process.env.GITHUB_ACTIONS && process.env.GITHUB_EVENT_PATH) {
		const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
		const range = eventRange(cwd, process.env.GITHUB_EVENT_NAME ?? "", event) ?? [];
		return { range, what: `this ${process.env.GITHUB_EVENT_NAME} (${range.join(" ") || "no commits"})` };
	}
	if (git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]).code !== 0)
		return { range: [], what: "an empty repository" };
	const remotes = git(cwd, ["remote"]).out.split("\n");
	return remotes.includes("origin")
		? { range: ["HEAD", "--not", "--remotes=origin"], what: "the commits not on origin yet" }
		: { range: ["HEAD"], what: "every commit (no origin)" };
}
