/**
 * Install this clone's git hooks. `bun install` runs it (the `prepare` script), and `bun run hooks` runs it again by hand;
 * CI runs the same checks on every push and pull request, so a clone without the hooks is caught there, after the push.
 *
 * - pre-commit: `scripts/check-personal.ts --staged`, what is about to be committed.
 * - pre-push: `scripts/check-authors.ts` and `scripts/check-personal.ts`, over the commits the push adds to the remote.
 *
 * It never fails, so it never fails `bun install`:
 * - outside a git checkout of this package (a source tarball, a copy inside some other repository, no git) it does nothing;
 * - in a linked worktree it writes the hooks of the repository's common git dir, which every worktree shares;
 * - with `core.hooksPath` set (a hook manager, or global hooks) it writes nothing and says so in one line;
 * - a hook it did not write is left as it is, with a one-line notice; hooks it wrote are replaced, so running it again
 *   after a change here updates them. It prints only what it wrote.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { git } from "./lib/push-range.ts";

const MARK = "# omp-webui hook, written by `bun run hooks` (scripts/install-hooks.ts)";

export const HOOKS: Record<string, string> = {
	"pre-commit": `#!/bin/sh
${MARK}: what is about to be committed holds no personal data.
exec bun scripts/check-personal.ts --staged
`,
	"pre-push": `#!/bin/sh
${MARK}: every pushed commit is authored and committed with the noreply address, and holds no personal data.
refs=$(cat)
printf '%s\\n' "$refs" | bun scripts/check-authors.ts --pre-push "$1" || exit 1
printf '%s\\n' "$refs" | bun scripts/check-personal.ts --pre-push "$1"
`,
};

/** Install the hooks for the checkout at `cwd`; returns the lines to print (`notice` ones go to stderr). */
export function installHooks(cwd: string): { info: string[]; notice: string[] } {
	const info: string[] = [];
	const notice: string[] = [];
	const top = git(cwd, ["rev-parse", "--show-toplevel"]);
	if (top.code !== 0 || !top.out || realpathSync(top.out) !== realpathSync(cwd)) return { info, notice };
	const hooksPath = git(cwd, ["config", "--get", "core.hooksPath"]);
	if (hooksPath.code === 0 && hooksPath.out) {
		notice.push(
			`git hooks not installed: core.hooksPath is set (${hooksPath.out}); add those of scripts/install-hooks.ts there`,
		);
		return { info, notice };
	}
	const common = git(cwd, ["rev-parse", "--git-common-dir"]);
	if (common.code !== 0 || !common.out) return { info, notice };
	const dir = join(resolve(cwd, common.out), "hooks");
	mkdirSync(dir, { recursive: true });
	for (const [name, body] of Object.entries(HOOKS)) {
		const path = join(dir, name);
		const old = existsSync(path) ? readFileSync(path, "utf8") : null;
		if (old !== null && !old.includes(MARK)) {
			notice.push(
				`${path} was not written by scripts/install-hooks.ts: left as it is; add the lines of its ${name} hook to it`,
			);
			continue;
		}
		if (old === body && statSync(path).mode & 0o100) continue;
		writeFileSync(path, body);
		chmodSync(path, 0o755);
		info.push(`Installed ${path}`);
	}
	return { info, notice };
}

if (import.meta.main) {
	try {
		const { info, notice } = installHooks(process.cwd());
		for (const line of info) console.log(line);
		for (const line of notice) console.error(line);
	} catch (e) {
		console.error(`git hooks not installed: ${e instanceof Error ? e.message : String(e)}`);
	}
	process.exit(0);
}
