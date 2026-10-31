/**
 * Release a version from this Mac (`bun scripts/release-local.ts vX.Y.Z`).
 *
 * CI (.github/workflows/ci.yml) runs every gate that needs no model login on each push to main: type check, lint, the
 * build with its first-load size check, the parity report, unit + contract (`test:release`) and the offline end-to-end
 * suite. This script releases only a commit CI passed on: it asks GitHub for the CI workflow's runs of that exact commit
 * and stops, before anything is built, unless one of them (a push or a by-hand run, not a pull request's, which tests a
 * merge commit) succeeded; a commit CI has not run on, is still running on, or failed on is refused with the run's link.
 * Then it does what only this Mac can: the unit and contract tests that only macOS runs (`test:mac`, scripts/mac-tests.ts:
 * the app's Swift shell, signing, the disk image and the updater's install steps, which CI's Linux skips), the tests that
 * call a real model (`test:live`: they need this machine's Anthropic login, which CI never has, and refuse to run without
 * it), the app signed with the identity in its keychain (scripts/signing-identity.ts) and the dmg. It works from a clean
 * checkout of the commit it releases in a temporary worktree, so nothing uncommitted here goes in. Any failure stops it
 * before anything is tagged or published.
 *
 * The tests that open real windows on this Mac (Run in Background's menu bar icon, pop-outs, the pending-quit question:
 * `OMPW_GUI_TESTS=1`, tests/support/gui-tests.ts) are not part of it: they take the focus of whoever is using the Mac, and
 * what they find depends on which app is in front. A release that changes macos/background.swift, macos/popout.swift or
 * macos/quit.swift wants `bun run test:gui` run by hand first, on an awake Mac with nothing else in front.
 *
 * The tag is made by this script, after everything else passed, never by hand. With no tag `vX.Y.Z` here or on origin,
 * the release is of the commit `main` is at on origin: this checkout must be at that commit with nothing uncommitted
 * (else it stops and says so), CI must have passed on it, the macOS tests, the live tests, the app and the dmg run on it,
 * and only then is the annotated tag made on that exact commit and pushed; the publishing follows. A step that fails
 * leaves no tag to delete: fix, push, wait for CI, run it again (#782). A tag that already exists (re-publishing it) must
 * point at the same commit here and on origin (the build is of the local one, the release is created against the remote
 * one); it is released as it is, wherever this checkout is, once CI passed on its commit. A tag on one side only, or on
 * two different commits, stops it: nothing is moved or deleted.
 *
 * Before anything is built, the script also says whether the repository is public, which the app's own updater needs in
 * order to see the release.
 *
 * Before anything long runs it also checks what this machine must have for the steps ahead (scripts/lib/release-preflight.ts):
 * a logged-in desktop session with Finder automation for the dmg, the signing identity, and for publishing a signed-in
 * `gh` with the `repo` scope. Anything missing is named at once.
 *
 * `--skip-tests` skips the macOS and the live tests (only for re-publishing a tag whose tests already passed; a tag is
 * never made without them). `--dry-run` does everything but the tag and the publishing (the CI check, the macOS and the
 * live tests, the app and the dmg) and then stops, saying the commit a new tag would be made on.
 *
 * A release is the signed dmg on a GitHub Release with the notes and the install steps, nothing else: no package is
 * published anywhere. SIGINT, SIGTERM and SIGHUP stop the running command and everything it started, then
 * remove the temporary worktree and directory too.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Needs, type Probe, preflight } from "./lib/release-preflight.ts";
import { isShuttingDown, killTree, onShutdown } from "./lib/shutdown.ts";

const REPO = "9s94ttyfct-bit/omp-webui";
/** The workflow whose success on the released commit is required (.github/workflows/ci.yml). */
const CI_WORKFLOW = "ci.yml";
const args = process.argv.slice(2);
const FLAGS: Record<string, true> = { "--skip-tests": true, "--dry-run": true };
const words = args.filter((a) => !a.startsWith("--"));
const tag = words[0] ?? "";
const skipTests = args.includes("--skip-tests");
const dryRun = args.includes("--dry-run");
if (!/^v\d+\.\d+\.\d+$/.test(tag) || args.some((a) => a.startsWith("--") && !FLAGS[a]) || words.length !== 1) {
	console.error("usage: bun scripts/release-local.ts vX.Y.Z [--skip-tests] [--dry-run]");
	process.exit(2);
}
// OMPW_RELEASE_ROOT: the checkout to release from, for the test that runs this script against stand-ins.
const root = process.env.OMPW_RELEASE_ROOT ?? new URL("..", import.meta.url).pathname;

/** The commands running now, so that a signal can stop them. */
const running = new Set<Bun.Subprocess>();
let work = "";
let tree = "";

interface Result {
	code: number;
	out: string;
	err: string;
}

async function exec(
	cmd: string[],
	opts: { cwd?: string; env?: Record<string, string>; quiet?: boolean; timeout?: number } = {},
) {
	console.log(`$ ${cmd.join(" ")}`);
	const proc = Bun.spawn(cmd, {
		cwd: opts.cwd ?? root,
		env: { ...process.env, ...opts.env },
		stdout: opts.quiet ? "pipe" : "inherit",
		stderr: opts.quiet ? "pipe" : "inherit",
		timeout: opts.timeout,
	});
	running.add(proc);
	const [out, err, code] = await Promise.all([
		opts.quiet ? new Response(proc.stdout as ReadableStream).text() : "",
		opts.quiet ? new Response(proc.stderr as ReadableStream).text() : "",
		proc.exited,
	]).finally(() => running.delete(proc));
	return { code, out: out.trim(), err: err.trim() } satisfies Result;
}

async function run(cmd: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<void> {
	const r = await exec(cmd, opts);
	if (r.code !== 0) throw new Error(`${cmd[0]} exited with ${r.code}`);
}

async function quiet(cmd: string[], cwd = root): Promise<string> {
	const r = await exec(cmd, { cwd, quiet: true });
	if (r.code !== 0) throw new Error(`${cmd.join(" ")} exited with ${r.code}: ${r.err}`);
	return r.out;
}

/** Stop the running commands and what they started, then remove the worktree and the temporary directory. */
const cleanup = onShutdown(async () => {
	await Promise.all([...running].map((proc) => killTree(proc.pid, 15_000)));
	if (tree)
		Bun.spawnSync(["git", "worktree", "remove", "--force", tree], { cwd: root, stdout: "ignore", stderr: "ignore" });
	if (work) rmSync(work, { recursive: true, force: true });
	Bun.spawnSync(["git", "worktree", "prune"], { cwd: root, stdout: "ignore", stderr: "ignore" });
	work = "";
	tree = "";
});

/** Probes for the preflight: a command that cannot be started is an answer (127), not a crash. */
const probe: Probe = async (cmd, timeoutMs) => {
	try {
		const r = await exec(cmd, { quiet: true, timeout: timeoutMs });
		return { code: r.code, out: r.out, err: r.err };
	} catch (e) {
		return { code: 127, out: "", err: e instanceof Error ? e.message : String(e) };
	}
};

/**
 * Whether the repository is public, said before anything is built. It does not stop a release: the app updates itself from
 * this repository's releases without a login (#571), so a repository that is private is said so, because no installed
 * app can see a release of it. The visibility is only ever read here, never changed: that is the maintainer's decision,
 * made on GitHub.
 */
async function reportVisibility(): Promise<void> {
	const repoVis = await quiet(["gh", "api", `repos/${REPO}`, "-q", ".visibility"]);
	console.log(`repo: ${repoVis}`);
	if (repoVis !== "public") {
		console.warn(
			`WARNING: the repository is ${repoVis}: the app's updater reads releases without a login, so no installed app will see this release until the repository is public.`,
		);
	}
}

interface CiRun {
	head_sha: string;
	event: string;
	status: string;
	conclusion: string | null;
	created_at: string;
	html_url: string;
}

/**
 * Stop unless CI succeeded on exactly `commit`: a run of the CI workflow for it, started by the push or by hand, that
 * completed with success. A pull request's run does not count: it tested the merge of the pull request into its base,
 * not this commit. One success is enough (a run that failed and then passed on a re-run, or a by-hand run after it).
 */
async function requireCi(commit: string): Promise<void> {
	const r = await exec(
		["gh", "api", `repos/${REPO}/actions/workflows/${CI_WORKFLOW}/runs?head_sha=${commit}&per_page=100`],
		{ quiet: true },
	);
	if (r.code !== 0) throw new Error(`could not read CI's runs of ${commit}: ${r.err}; nothing was built or tagged`);
	const runs = (JSON.parse(r.out).workflow_runs as CiRun[])
		.filter((ci) => ci.head_sha === commit && (ci.event === "push" || ci.event === "workflow_dispatch"))
		.sort((a, b) => b.created_at.localeCompare(a.created_at));
	const passed = runs.find((ci) => ci.status === "completed" && ci.conclusion === "success");
	if (passed) {
		console.log(`CI passed on ${commit}: ${passed.html_url}`);
		return;
	}
	const latest = runs[0];
	if (!latest) {
		throw new Error(
			`CI has not run on ${commit}: push it to main and wait for CI to pass (gh run watch), then run this again; nothing was built or tagged`,
		);
	}
	if (latest.status !== "completed") {
		throw new Error(
			`CI has not finished on ${commit} (${latest.status}, ${latest.html_url}): wait for it to pass, then run this again; nothing was built or tagged`,
		);
	}
	throw new Error(
		`CI did not pass on ${commit} (${latest.conclusion}, ${latest.html_url}): fix it, push, and release the commit CI passes on; nothing was built or tagged`,
	);
}

/**
 * The commit to release, and whether the tag is still to be made. An existing tag must be the same commit here and on
 * origin; with no tag on either side the release is of origin's `main`, which this checkout must be at, with nothing
 * uncommitted, so that what is tagged is what the person running it has. Nothing here moves, makes or deletes a tag.
 */
async function releasedCommit(): Promise<{ commit: string; fresh: boolean }> {
	const local = await quiet(["git", "rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`]).catch(() => "");
	const refs = await quiet(["git", "ls-remote", "--tags", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
	if (!local && !refs) return { commit: await mainCommit(), fresh: true };
	if (!local) {
		throw new Error(
			`${tag} does not exist here but is on origin: fetch it (git fetch origin tag ${tag}) to re-publish it; nothing was moved or deleted`,
		);
	}
	if (!refs) {
		throw new Error(
			`${tag} is not pushed: push it to re-publish it as it is; nothing was moved or deleted (this script makes a new tag itself, after everything passed)`,
		);
	}
	const lines = refs.split("\n").map((l) => l.split("\t") as [string, string]);
	// An annotated tag lists the tag object, then (peeled, `^{}`) the commit it points at.
	const remote = (lines.find(([, ref]) => ref.endsWith("^{}")) ?? lines[0])[0];
	if (remote !== local) {
		throw new Error(
			`${tag} is ${local} here but ${remote} on origin: push or move the tag first; nothing was moved or deleted`,
		);
	}
	console.log(`${tag} exists here and on origin at ${local}: it is released as it is`);
	return { commit: local, fresh: false };
}

/** The commit origin's `main` is at, which this checkout must be at too, clean, for a tag to be made on it. */
async function mainCommit(): Promise<string> {
	if (skipTests)
		throw new Error(
			`${tag} does not exist yet, and a tag is only made after the live tests: run it without --skip-tests`,
		);
	const main = (await quiet(["git", "ls-remote", "origin", "refs/heads/main"])).split("\t")[0];
	if (!main) throw new Error("origin has no main branch to release");
	const head = await quiet(["git", "rev-parse", "HEAD"]);
	if (head !== main) {
		throw new Error(
			`${tag} does not exist yet, so it would be made on origin/main (${main}), but this checkout is at ${head}: pull or push until they are the same commit, then run it again`,
		);
	}
	const dirty = await quiet(["git", "status", "--porcelain"]);
	if (dirty) {
		throw new Error(
			`${tag} does not exist yet, so it would be made on origin/main (${main}), but this checkout has changes that are not committed: commit and push them, or put them away, then run it again:\n${dirty}`,
		);
	}
	console.log(`${tag} does not exist yet: it is made on origin/main (${main}) once everything passed`);
	return main;
}

/** Make the annotated tag on the commit everything passed on, and push it: the release is created against it. */
async function makeTag(commit: string): Promise<void> {
	await run(["git", "tag", "-a", tag, "-m", `omp-webui ${tag}`, commit]);
	const pushed = await exec(["git", "push", "origin", `refs/tags/${tag}`]);
	if (pushed.code !== 0) {
		throw new Error(
			`${tag} was made here on ${commit} but could not be pushed: push it (git push origin ${tag}), then run this again to publish it (--skip-tests: its tests passed)`,
		);
	}
}

async function release(): Promise<void> {
	const { commit, fresh } = await releasedCommit();
	await reportVisibility();
	await requireCi(commit);

	// The steps that follow need this machine to have things CI does not check; find out now, not at the dmg.
	const needs: Needs = { gui: true, publish: !dryRun, signing: true };
	const missing = await preflight(needs, probe);
	if (missing.length > 0) {
		throw new Error(`this machine is not ready for the release; nothing was built:\n- ${missing.join("\n- ")}`);
	}

	work = mkdtempSync(join(tmpdir(), "ompw-release-"));
	tree = join(work, "tree");
	await run(["git", "worktree", "add", "--detach", tree, commit]);
	await run(["bun", "install", "--frozen-lockfile"], { cwd: tree });

	const version = JSON.parse(await Bun.file(join(tree, "package.json")).text()).version as string;
	if (`v${version}` !== tag) throw new Error(`tag ${tag} != package.json v${version}`);
	await run(["bun", "scripts/check-release-notes.ts", tag], { cwd: tree });
	// The tests CI cannot run: the cases only macOS has, then the ones that call a real model with this machine's login.
	if (!skipTests) {
		await run(["bun", "run", "test:mac"], { cwd: tree });
		await run(["bun", "run", "test:live"], { cwd: tree });
	}

	await run(["bun", "run", "app"], { cwd: tree });
	await run(["bun", "run", "dmg"], { cwd: tree });
	const dmg = join(tree, "dist", `omp-webui-${tag}.dmg`);
	if (!(await Bun.file(dmg).exists())) throw new Error(`${dmg} was not built`);

	if (dryRun) {
		console.log(
			fresh
				? `Dry run: CI, the macOS tests, the live tests, the app and the dmg passed on ${commit} (origin/main), the commit ${tag} would be made on; no tag was made, and nothing was published.`
				: `Dry run: ${tag} is ready (CI, the macOS tests, the live tests, the app and the dmg passed); nothing was published.`,
		);
		return;
	}
	if (fresh) await makeTag(commit);

	// The release: the notes plus how to open the app (signed with a local certificate, not notarized). When the Release
	// workflow was run by hand for this tag first, the release exists (notes and a line that there is no installer yet):
	// its body is replaced, so that the page has the install steps and no longer says there is no installer. Otherwise
	// it is created here, with the dmg.
	const body = join(work, "body.md");
	const notes = await Bun.file(join(tree, "release-notes", `${tag}.md`)).text();
	const install = await Bun.file(join(tree, "release-notes", "_install.md")).text();
	writeFileSync(body, `${notes}${install}`);
	const exists = await exec(["gh", "release", "view", tag, "-R", REPO], { quiet: true });
	if (exists.code === 0) {
		await run(["gh", "release", "edit", tag, "--notes-file", body, "-R", REPO]);
		await run(["gh", "release", "upload", tag, dmg, "--clobber", "-R", REPO]);
	} else {
		await run([
			"gh",
			"release",
			"create",
			tag,
			dmg,
			"--title",
			`omp-webui ${tag}`,
			"--notes-file",
			body,
			"--verify-tag",
			"-R",
			REPO,
		]);
	}
	console.log(`Released ${tag}`);
}

try {
	await release();
} catch (e) {
	// After a signal the stopped command's failure is only the echo of it.
	if (!isShuttingDown()) console.error(e instanceof Error ? e.message : e);
	process.exitCode = 1;
} finally {
	await cleanup();
}
