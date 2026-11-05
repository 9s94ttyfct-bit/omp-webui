/**
 * Fails when a commit about to be published was authored or committed with a name or an e-mail address that is not the
 * maintainer's (`ALLOWED_NAMES`, `ALLOWED`), or when a pushed annotated tag names another tagger
 * (`bun scripts/check-authors.ts [--pre-push <remote> | <rev-list args>]`, part of `bun run lint`, so of CI, and of the
 * pre-push hook `bun run hooks` installs): this repository is public, and a commit's or a tag's identity is published
 * with it, so only the maintainer's GitHub handle and noreply address may author, commit or tag here. Which commits and
 * tags it reads: scripts/lib/push-range.ts.
 */
import { git, publishRange } from "./lib/push-range.ts";

/** The addresses commits and tags here may be authored, committed and tagged with. */
export const ALLOWED = ["273716724+9s94ttyfct-bit@users.noreply.github.com"];
/** The names they may carry: the maintainer's GitHub handle. */
export const ALLOWED_NAMES = ["9s94ttyfct-bit"];

export interface Offender {
	sha: string;
	/** `Name <address>`. */
	author: string;
	committer: string;
}

const allowedIdentity = (name: string, email: string, names: string[], allowed: string[]) =>
	names.some((n) => n.toLowerCase() === name.toLowerCase()) &&
	allowed.some((a) => a.toLowerCase() === email.toLowerCase());

/** Every commit `revArgs` lists whose author or committer name or address is not allowed. */
export function offenders(
	cwd: string,
	revArgs: string[],
	allowed: string[] = ALLOWED,
	names: string[] = ALLOWED_NAMES,
): Offender[] {
	if (revArgs.length === 0) return [];
	const listed = git(cwd, ["log", "--format=%H%x09%an%x09%ae%x09%cn%x09%ce", ...revArgs, "--"]);
	if (listed.code !== 0) throw new Error(`git log ${revArgs.join(" ")} failed: ${listed.err}`);
	return listed.out
		.split("\n")
		.filter(Boolean)
		.map((line) => line.split("\t"))
		.filter(
			([, an, ae, cn, ce]) => !allowedIdentity(an, ae, names, allowed) || !allowedIdentity(cn, ce, names, allowed),
		)
		.map(([sha, an, ae, cn, ce]) => ({ sha, author: `${an} <${ae}>`, committer: `${cn} <${ce}>` }));
}

/** Every annotated tag object of `tags` whose tagger is not allowed (or that names none), as `<sha> tagger <who>`. */
export function tagOffenders(
	cwd: string,
	tags: string[],
	allowed: string[] = ALLOWED,
	names: string[] = ALLOWED_NAMES,
): string[] {
	const bad: string[] = [];
	for (const sha of tags) {
		const tag = git(cwd, ["cat-file", "tag", sha]);
		if (tag.code !== 0) throw new Error(`git cat-file tag ${sha} failed: ${tag.err}`);
		const name = /^tag (.*)$/m.exec(tag.out)?.[1] ?? sha;
		const tagger = /^tagger (.*) <([^>]*)> \d+ [+-]\d{4}$/m.exec(tag.out);
		if (!tagger) bad.push(`${name} (${sha.slice(0, 12)}) has no tagger`);
		else if (!allowedIdentity(tagger[1], tagger[2], names, allowed))
			bad.push(`${name} (${sha.slice(0, 12)}) tagger ${tagger[1]} <${tagger[2]}>`);
	}
	return bad;
}

if (import.meta.main) {
	try {
		const cwd = process.cwd();
		const { range, tags, what } = publishRange(cwd, process.argv.slice(2));
		const bad = offenders(cwd, range);
		const badTags = tagOffenders(cwd, tags);
		const identity = `${ALLOWED_NAMES[0]} <${ALLOWED[0]}>`;
		if (bad.length > 0) {
			console.error(
				`Commits in ${what} with a name or e-mail other than ${identity}:\n${bad
					.map((c) => `${c.sha.slice(0, 12)} author ${c.author}, committer ${c.committer}`)
					.join(
						"\n",
					)}\nSet it (git config user.name ${ALLOWED_NAMES[0]}; git config user.email ${ALLOWED[0]}) and rewrite them (git rebase -r <base> --exec 'git commit --amend --no-edit --reset-author') before pushing.`,
			);
		}
		if (badTags.length > 0) {
			console.error(
				`Tags in ${what} with a tagger other than ${identity}:\n${badTags.join("\n")}\nDelete each here (git tag -d <tag>) and make it again with that identity set.`,
			);
		}
		if (bad.length > 0 || badTags.length > 0) process.exit(1);
		console.log(`Commit authors and committers allowed in ${what}.`);
	} catch (e) {
		console.error(e instanceof Error ? e.message : String(e));
		process.exit(1);
	}
}
