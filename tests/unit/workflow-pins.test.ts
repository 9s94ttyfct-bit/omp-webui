import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * What CI builds is published as it is: the Windows launcher and the Linux tarball are the artifacts of its jobs, attached
 * to the release by `scripts/release-local.ts`. A tag of an action can be moved to other code, which would then run in the
 * job that builds them, so every action is named by its commit (as `.github/workflows/release.yml` always did).
 */
const github = join(import.meta.dir, "..", "..", ".github");

test("every action a workflow or a composite action uses is pinned to a commit", () => {
	const unpinned: string[] = [];
	for (const name of readdirSync(github, { recursive: true, encoding: "utf8" })) {
		if (!/\.ya?ml$/.test(name)) continue;
		for (const [i, line] of readFileSync(join(github, name), "utf8").split("\n").entries()) {
			const uses = /^\s*(?:-\s*)?uses:\s*(\S+)/.exec(line)?.[1];
			if (uses && !uses.startsWith("./") && !/@[0-9a-f]{40}$/.test(uses)) unpinned.push(`${name}:${i + 1} ${uses}`);
		}
	}
	expect(unpinned).toEqual([]);
});
