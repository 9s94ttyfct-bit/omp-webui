/**
 * Fails when a commit about to be published was authored or committed with an e-mail address that is not on `ALLOWED`
 * (`bun scripts/check-authors.ts [--pre-push <remote> | <rev-list args>]`, part of `bun run lint`, so of CI, and of the
 * pre-push hook `bun run hooks` installs): this repository is public, and a commit's identity is published with it, so
 * only the maintainer's GitHub noreply address may author or commit here. Which commits it reads: scripts/lib/push-range.ts.
 */
import { git, publishRange } from "./lib/push-range.ts";

/** The addresses commits here may be authored and committed with. */
export const ALLOWED = ["273716724+9s94ttyfct-bit@users.noreply.github.com"];

export interface Offender {
	sha: string;
	author: string;
	committer: string;
}

/** Every commit `revArgs` lists whose author or committer address is not allowed. */
export function offenders(cwd: string, revArgs: string[], allowed: string[] = ALLOWED): Offender[] {
	if (revArgs.length === 0) return [];
	const listed = git(cwd, ["log", "--format=%H%x09%ae%x09%ce", ...revArgs, "--"]);
	if (listed.code !== 0) throw new Error(`git log ${revArgs.join(" ")} failed: ${listed.err}`);
	const ok = new Set(allowed.map((a) => a.toLowerCase()));
	return listed.out
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [sha, author, committer] = line.split("\t");
			return { sha, author, committer };
		})
		.filter((c) => !ok.has(c.author.toLowerCase()) || !ok.has(c.committer.toLowerCase()));
}

if (import.meta.main) {
	try {
		const cwd = process.cwd();
		const { range, what } = publishRange(cwd, process.argv.slice(2));
		const bad = offenders(cwd, range);
		if (bad.length > 0) {
			console.error(
				`Commits in ${what} with an e-mail other than ${ALLOWED.join(" or ")}:\n${bad
					.map((c) => `${c.sha.slice(0, 12)} author ${c.author}, committer ${c.committer}`)
					.join(
						"\n",
					)}\nSet it (git config user.email ${ALLOWED[0]}) and rewrite them (git rebase -r <base> --exec 'git commit --amend --no-edit --reset-author') before pushing.`,
			);
			process.exit(1);
		}
		console.log(`Commit authors and committers allowed in ${what}.`);
	} catch (e) {
		console.error(e instanceof Error ? e.message : String(e));
		process.exit(1);
	}
}
