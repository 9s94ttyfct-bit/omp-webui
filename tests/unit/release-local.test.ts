import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pollUntil, processExists } from "../support/poll.ts";

/**
 * scripts/release-local.ts against stand-ins: a throwaway repository with a bare "origin", and `gh`, `npm` and `bun`
 * scripts first on PATH that only log what they were asked. Nothing real is ever published: the release script sees
 * the stubs, never GitHub or the registry. The `gh` stand-in answers CI's runs of the commit asked for with a run that
 * succeeded, unless the test says otherwise (STUB_CI).
 */

const SCRIPT = join(import.meta.dir, "..", "..", "scripts", "release-local.ts");
const TAG = "v9.9.9";

let base: string;
let repo: string;
let stubs: string;
let scratch: string;
let log: string;

function git(...cmd: string[]): string {
	const r = Bun.spawnSync(["git", ...cmd], { cwd: repo, stdout: "pipe", stderr: "pipe" });
	if (r.exitCode !== 0) throw new Error(`git ${cmd.join(" ")}: ${r.stderr.toString()}`);
	return r.stdout.toString().trim();
}

function stub(name: string, body: string): void {
	const path = join(stubs, name);
	writeFileSync(path, `#!/bin/sh\n${body}\n`);
	chmodSync(path, 0o755);
}

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "ompw-release-test-"));
	repo = join(base, "repo");
	stubs = join(base, "stubs");
	scratch = join(base, "scratch");
	log = join(base, "calls.log");
	for (const d of [repo, stubs, scratch, join(base, "origin.git")]) mkdirSync(d, { recursive: true });
	Bun.spawnSync(["git", "init", "--bare", "-q", join(base, "origin.git")]);
	git("init", "-q", "-b", "main");
	git("config", "user.email", "t@example.test");
	git("config", "user.name", "t");
	git("remote", "add", "origin", join(base, "origin.git"));
	writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "omp-webui", version: "9.9.9" }));
	mkdirSync(join(repo, "release-notes"));
	writeFileSync(join(repo, "release-notes", `${TAG}.md`), "notes\n");
	writeFileSync(join(repo, "release-notes", "_install.md"), "install\n");
	git("add", "-A");
	git("commit", "-q", "-m", "release");
	git("tag", TAG);
	git("push", "-q", "origin", "HEAD", TAG);

	stub(
		"gh",
		`echo "gh $*" >> "${log}"
case "$1 $2" in
"api repos/9s94ttyfct-bit/omp-webui") echo "\${STUB_REPO_VIS:-private}" ;;
"api -i") printf 'HTTP/2.0 200 OK\nX-Oauth-Scopes: %s\n\n{}\n' "\${STUB_SCOPES-repo}" ;;
"release view") [ -n "$STUB_RELEASE_EXISTS" ] || exit 1 ;;
"release create") echo "tag at release: here=$(git tag -l ${TAG}) origin=$(git ls-remote --tags origin refs/tags/${TAG} | cut -f1)" >> "${log}" ;;
"release edit")
  while [ $# -gt 0 ]; do if [ "$1" = --notes-file ]; then cp "$2" "${base}/edited-body"; fi; shift; done ;;
"api repos/9s94ttyfct-bit/omp-webui/actions/workflows/ci.yml/runs?head_sha="*)
  sha=\${2#*head_sha=}; sha=\${sha%%&*}
  run() { printf '{"head_sha":"%s","event":"%s","status":"%s","conclusion":%s,"created_at":"%s","html_url":"https://github.com/runs/%s"}' "$1" "$2" "$3" "$4" "$5" "$6"; }
  case "\${STUB_CI:-success}" in
  none) runs="" ;;
  success) runs=$(run "$sha" push completed '"success"' 2026-01-01T00:00:00Z 1) ;;
  failure) runs=$(run "$sha" push completed '"failure"' 2026-01-01T00:00:00Z 2) ;;
  in_progress) runs=$(run "$sha" push in_progress null 2026-01-01T00:00:00Z 3) ;;
  rerun) runs="$(run "$sha" push completed '"failure"' 2026-01-01T00:00:00Z 4),$(run "$sha" workflow_dispatch completed '"success"' 2026-01-02T00:00:00Z 5)" ;;
  elsewhere) runs="$(run 0000000000000000000000000000000000000001 push completed '"success"' 2026-01-01T00:00:00Z 6),$(run "$sha" pull_request completed '"success"' 2026-01-01T00:00:00Z 7)" ;;
  esac
  printf '{"total_count":1,"workflow_runs":[%s]}\\n' "$runs" ;;
esac`,
	);
	// Nothing is published to npm any more: a call to it is only logged, for the tests that say there is none.
	stub("npm", `echo "npm $*" >> "${log}"`);
	stub(
		"bun",
		`echo "bun $*" >> "${log}"
if [ "$1 $2" = "run dmg" ] && [ -z "$STUB_DMG_FAIL" ]; then mkdir -p dist; : > "dist/omp-webui-${TAG}.dmg"; fi
if [ "$1 $2" = "run test:live" ] && [ -n "$STUB_LIVE_FAIL" ]; then exit 1; fi
if [ "$1 $2" = "run dmg" ] && [ -n "$STUB_DMG_FAIL" ]; then exit 1; fi
if [ "$1 $2" = "run app" ]; then echo "tag at app: here=$(git tag -l ${TAG}) origin=$(git ls-remote --tags origin refs/tags/${TAG} | cut -f1)" >> "${log}"; fi
if [ -n "$STUB_BUN_HANG" ] && [ "$1" = install ]; then exec sleep 60; fi
if [ -n "$STUB_BUN_GRANDCHILD" ] && [ "$1" = install ]; then sleep 60 & echo $! > "${base}/grandchild.pid"; wait; fi`,
	);
	// The signing identity this machine would have (scripts/signing-identity.ts); a test says when it is not there.
	stub(
		"security",
		`if [ -n "$STUB_NO_IDENTITY" ]; then printf 'Policy: Code Signing\\n     0 identities found\\n'
else printf 'Policy: Code Signing\\n  1) 441EEF68726ACE2993CD986CDA7B75C18A1C0E9C "omp-webui local signing" (CSSMERR_TP_NOT_TRUSTED)\\n'; fi`,
	);
	// The desktop session and Finder this machine would have; a test says what is not there.
	stub("launchctl", `echo "\${STUB_SESSION:-Aqua}"`);
	stub(
		"osascript",
		`if [ -n "$STUB_FINDER_FAIL" ]; then echo "execution error: Not authorized to send Apple events to Finder. (-1743)" >&2; exit 1; fi`,
	);
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

type ReleaseProcess = Bun.Subprocess<"ignore", "pipe", "pipe">;

function release(extra: string[] = [], env: Record<string, string> = {}, allTests = false): ReleaseProcess {
	return Bun.spawn([process.execPath, SCRIPT, TAG, ...(!allTests ? ["--skip-tests"] : []), ...extra], {
		cwd: repo,
		env: {
			...process.env,
			PATH: `${stubs}:${process.env.PATH}`,
			OMPW_RELEASE_ROOT: repo,
			TMPDIR: scratch,
			...env,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
}

async function finish(proc: ReleaseProcess) {
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout as ReadableStream).text(),
		new Response(proc.stderr as ReadableStream).text(),
		proc.exited,
	]);
	return { out: out + err, code };
}

const calls = () => (Bun.file(log).size ? readFileSync(log, "utf8") : "");
const leftovers = () => readdirSync(scratch);
const worktrees = () =>
	git("worktree", "list", "--porcelain")
		.split("\n")
		.filter((l) => l.startsWith("worktree "));

/** The commit the tag points at here, or "" without one. */
const localTag = () => git("tag", "-l", TAG) && git("rev-parse", `${TAG}^{commit}`);
/** The commit the tag points at on origin, or "" without one. */
function originTag(): string {
	const refs = git("ls-remote", "--tags", "origin", `refs/tags/${TAG}`, `refs/tags/${TAG}^{}`);
	if (!refs) return "";
	const lines = refs.split("\n").map((l) => l.split("\t"));
	return (lines.find(([, ref]) => ref.endsWith("^{}")) ?? lines[0])[0];
}
/** No tag yet, here or on origin: what a release now starts from. */
function untag(): void {
	git("tag", "-d", TAG);
	git("push", "-q", "origin", `:refs/tags/${TAG}`);
}

test("a public repository does not stop the release: the app's updater needs it public", async () => {
	const r = await finish(release(["--dry-run"], { STUB_REPO_VIS: "public" }));
	expect(r.code).toBe(0);
	expect(r.out).toContain("repo: public");
	expect(r.out).toContain("Dry run");
	expect(r.out).not.toContain("WARNING");
});

test("a repository that is still private releases too, and says that no installed app will see it", async () => {
	const r = await finish(release(["--dry-run"], { STUB_REPO_VIS: "private" }));
	expect(r.code).toBe(0);
	expect(r.out).toContain("WARNING: the repository is private");
	expect(r.out).toContain("until the repository is public");
	expect(r.out).toContain("Dry run");
});

test("the visibility is only read, never changed: no call writes to the repository", async () => {
	const r = await finish(release([], { STUB_REPO_VIS: "private" }));
	expect(r.code).toBe(0);
	const seen = calls();
	expect(seen).toContain("gh api repos/9s94ttyfct-bit/omp-webui");
	expect(seen).not.toMatch(/repo edit|--method|-X |--field|--raw-field|-f visibility|visibility=/);
});

test("a local tag that is not the commit on origin stops it, and neither tag is moved or deleted (#782)", async () => {
	const first = git("rev-parse", "HEAD");
	writeFileSync(join(repo, "later.txt"), "x");
	git("add", "-A");
	git("commit", "-q", "-m", "later");
	git("tag", "-f", TAG);
	const r = await finish(release());
	expect(r.code).toBe(1);
	expect(r.out).toMatch(/v9\.9\.9 is [0-9a-f]{40} here but [0-9a-f]{40} on origin/);
	expect(r.out).toContain("nothing was moved or deleted");
	expect(localTag()).toBe(git("rev-parse", "HEAD"));
	expect(originTag()).toBe(first);
	expect(calls()).toBe("");
	expect(leftovers()).toEqual([]);
});

test("an annotated tag is compared by the commit it points at", async () => {
	git("tag", "-f", "-a", "-m", "annotated", TAG);
	git("push", "-q", "-f", "origin", TAG);
	const r = await finish(release(["--dry-run"]));
	expect(r.out).toContain("Dry run");
	expect(r.code).toBe(0);
});

test("a tag that is not on origin stops it", async () => {
	git("tag", "v9.9.8");
	const proc = Bun.spawn([process.execPath, SCRIPT, "v9.9.8", "--skip-tests"], {
		cwd: repo,
		env: { ...process.env, PATH: `${stubs}:${process.env.PATH}`, OMPW_RELEASE_ROOT: repo, TMPDIR: scratch },
		stdout: "pipe",
		stderr: "pipe",
	});
	const r = await finish(proc);
	expect(r.code).toBe(1);
	expect(r.out).toContain("v9.9.8 is not pushed");
	expect(calls()).toBe("");
});

// ------------------------------------------------------------------ CI must have passed on the commit

test("a commit CI has not run on is refused before anything is built or tagged", async () => {
	untag();
	const r = await finish(release([], { STUB_CI: "none" }, true));
	expect(r.code).toBe(1);
	expect(r.out).toContain(`CI has not run on ${git("rev-parse", "HEAD")}`);
	expect(r.out).toContain("nothing was built or tagged");
	expect(calls()).not.toContain("bun ");
	expect(localTag()).toBe("");
	expect(originTag()).toBe("");
	expect(leftovers()).toEqual([]);
});

test("a commit CI is still running on, or failed on, is refused with the run's link", async () => {
	untag();
	const running = await finish(release([], { STUB_CI: "in_progress" }, true));
	expect(running.code).toBe(1);
	expect(running.out).toContain("CI has not finished on");
	expect(running.out).toContain("(in_progress, https://github.com/runs/3)");
	const failed = await finish(release([], { STUB_CI: "failure" }, true));
	expect(failed.code).toBe(1);
	expect(failed.out).toContain("CI did not pass on");
	expect(failed.out).toContain("(failure, https://github.com/runs/2)");
	expect(calls()).not.toContain("bun ");
	expect(localTag()).toBe("");
	expect(originTag()).toBe("");
});

test("only a success on exactly this commit counts: another commit's, or a pull request's, does not", async () => {
	untag();
	const r = await finish(release([], { STUB_CI: "elsewhere" }, true));
	expect(r.code).toBe(1);
	expect(r.out).toContain("CI has not run on");
	expect(calls()).not.toContain("bun ");
});

test("a run that failed and then passed by hand counts as passed", async () => {
	const r = await finish(release(["--dry-run"], { STUB_CI: "rerun" }));
	expect(r.code).toBe(0);
	expect(r.out).toContain("CI passed on");
	expect(r.out).toContain("https://github.com/runs/5");
});

test("an existing tag is re-published only once CI passed on its commit, --skip-tests included", async () => {
	const tagged = git("rev-parse", "HEAD");
	const r = await finish(release([], { STUB_CI: "failure" }));
	expect(r.code).toBe(1);
	expect(r.out).toContain(`CI did not pass on ${tagged}`);
	expect(calls()).toContain(`head_sha=${tagged}`);
	expect(calls()).not.toContain("bun ");
});

// ------------------------------------------------------------------ the tag is made after everything passed (#782)

test("with no tag, CI's success on origin/main is required, then the live tests, the app and the dmg, then the tag, then publishing", async () => {
	untag();
	const main = git("rev-parse", "HEAD");
	const r = await finish(release([], {}, true));
	expect(r.out).toContain(`Released ${TAG}`);
	expect(r.code).toBe(0);
	expect(r.out).toContain(`it is made on origin/main (${main}) once everything passed`);
	expect(r.out).toContain(`CI passed on ${main}: https://github.com/runs/1`);
	const seen = calls();
	const order = [
		`gh api repos/9s94ttyfct-bit/omp-webui/actions/workflows/ci.yml/runs?head_sha=${main}`,
		"bun install",
		"bun run test:live",
		"bun run app",
		"bun run dmg",
		`gh release create ${TAG}`,
	].map((step) => seen.indexOf(step));
	expect(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]))).toBe(true);
	// The app and the dmg were built with no tag anywhere; the release was created once it was made here and on origin.
	expect(seen).toContain("tag at app: here= origin=\n");
	expect(seen).toContain(`tag at release: here=${TAG} origin=`);
	expect(localTag()).toBe(main);
	expect(originTag()).toBe(main);
	expect(git("cat-file", "-t", TAG)).toBe("tag");
	expect(worktrees()).toHaveLength(1);
});

test("CI's gates are not run again here: no type check, lint, build, parity, unit, contract or end-to-end suite", async () => {
	const r = await finish(release(["--dry-run"], {}, true));
	expect(r.code).toBe(0);
	const seen = calls();
	for (const never of ["typecheck", "run lint", "run build", "run parity", "run test\n", "test:release", "test:e2e"]) {
		expect(seen).not.toContain(never);
	}
	expect(seen).toContain("bun run test:live");
});

test("with no tag, live tests that fail make no tag here or on origin, and build nothing", async () => {
	untag();
	const r = await finish(release([], { STUB_LIVE_FAIL: "1" }, true));
	expect(r.code).toBe(1);
	expect(localTag()).toBe("");
	expect(originTag()).toBe("");
	for (const never of ["bun run app", "npm publish", "gh release"]) expect(calls()).not.toContain(never);
	expect(leftovers()).toEqual([]);
	expect(worktrees()).toHaveLength(1);
});

test("with no tag, a dmg that fails makes no tag either", async () => {
	untag();
	const r = await finish(release([], { STUB_DMG_FAIL: "1" }, true));
	expect(r.code).toBe(1);
	expect(calls()).toContain("bun run dmg");
	expect(localTag()).toBe("");
	expect(originTag()).toBe("");
	for (const never of ["npm publish", "gh release"]) expect(calls()).not.toContain(never);
});

test("with no tag, a checkout that is not at origin/main is refused before anything is built", async () => {
	untag();
	writeFileSync(join(repo, "later.txt"), "x");
	git("add", "-A");
	git("commit", "-q", "-m", "not pushed");
	const r = await finish(release([], {}, true));
	expect(r.code).toBe(1);
	expect(r.out).toMatch(/would be made on origin\/main \([0-9a-f]{40}\), but this checkout is at [0-9a-f]{40}/);
	expect(calls()).toBe("");
	expect(localTag()).toBe("");
	expect(originTag()).toBe("");
	expect(leftovers()).toEqual([]);
});

test("with no tag, a checkout with uncommitted changes is refused before anything is built", async () => {
	untag();
	writeFileSync(join(repo, "release-notes", `${TAG}.md`), "edited, not committed\n");
	const r = await finish(release([], {}, true));
	expect(r.code).toBe(1);
	expect(r.out).toContain("has changes that are not committed");
	expect(r.out).toContain(`release-notes/${TAG}.md`);
	expect(calls()).toBe("");
	expect(localTag()).toBe("");
	expect(originTag()).toBe("");
});

test("with no tag, --skip-tests is refused: a tag is only made after the live tests", async () => {
	untag();
	const r = await finish(release());
	expect(r.code).toBe(1);
	expect(r.out).toContain("a tag is only made after the live tests");
	expect(calls()).toBe("");
	expect(localTag()).toBe("");
});

test("--dry-run with no tag runs the live tests, the app and the dmg on origin/main, says the commit it would tag, and makes no tag", async () => {
	untag();
	const main = git("rev-parse", "HEAD");
	const r = await finish(release(["--dry-run"], {}, true));
	expect(r.code).toBe(0);
	expect(r.out).toContain(
		`Dry run: CI, the live tests, the app and the dmg passed on ${main} (origin/main), the commit ${TAG} would be made on`,
	);
	const seen = calls();
	for (const step of ["bun run test:live", "bun run app", "bun run dmg"]) expect(seen).toContain(step);
	for (const never of ["npm ", "gh auth token", "gh release"]) expect(seen).not.toContain(never);
	expect(localTag()).toBe("");
	expect(originTag()).toBe("");
	expect(leftovers()).toEqual([]);
	expect(worktrees()).toHaveLength(1);
});

test("an existing tag, the same here and on origin, is released as it is, wherever the checkout is", async () => {
	const tagged = git("rev-parse", "HEAD");
	writeFileSync(join(repo, "later.txt"), "x");
	git("add", "-A");
	git("commit", "-q", "-m", "later, not pushed");
	writeFileSync(join(repo, "dirty.txt"), "x");
	const r = await finish(release());
	expect(r.out).toContain(`Released ${TAG}`);
	expect(r.code).toBe(0);
	expect(r.out).toContain(`${TAG} exists here and on origin at ${tagged}: it is released as it is`);
	expect(calls()).toContain(`tag at app: here=${TAG} origin=${tagged}\n`);
	expect(localTag()).toBe(tagged);
	expect(originTag()).toBe(tagged);
	// Still the lightweight tag it was: nothing made it again.
	expect(git("cat-file", "-t", TAG)).toBe("commit");
});

test("a tag on origin only, or here only, stops it, and nothing is moved, made or deleted", async () => {
	const tagged = git("rev-parse", "HEAD");
	git("tag", "-d", TAG);
	let r = await finish(release([], {}, true));
	expect(r.code).toBe(1);
	expect(r.out).toContain(`${TAG} does not exist here but is on origin`);
	expect(r.out).toContain("nothing was moved or deleted");
	expect(localTag()).toBe("");
	expect(originTag()).toBe(tagged);

	git("tag", TAG);
	git("push", "-q", "origin", `:refs/tags/${TAG}`);
	r = await finish(release([], {}, true));
	expect(r.code).toBe(1);
	expect(r.out).toContain(`${TAG} is not pushed`);
	expect(r.out).toContain("nothing was moved or deleted");
	expect(localTag()).toBe(tagged);
	expect(originTag()).toBe("");
	expect(calls()).toBe("");
});

test("--dry-run with an existing tag and --skip-tests builds the app and the dmg, runs no tests, publishes nothing, and takes no token", async () => {
	const r = await finish(release(["--dry-run"]));
	expect(r.out).toContain(`Dry run: ${TAG} is ready`);
	expect(r.out).toContain("nothing was published");
	expect(r.code).toBe(0);
	const seen = calls();
	expect(seen).toContain("bun run dmg");
	expect(seen).not.toContain("bun run test");
	for (const never of ["npm ", "gh auth token", "gh release"]) expect(seen).not.toContain(never);
	expect(leftovers()).toEqual([]);
	expect(worktrees()).toHaveLength(1);
});

test("a release is the signed dmg on a GitHub Release, and nothing is published to npm or GitHub Packages", async () => {
	const r = await finish(release());
	expect(r.out).toContain(`Released ${TAG}`);
	expect(r.code).toBe(0);
	const seen = calls();
	expect(seen).toMatch(
		new RegExp(
			`gh release create ${TAG.replaceAll(".", "\\.")} \\S+/dist/omp-webui-${TAG.replaceAll(".", "\\.")}\\.dmg `,
		),
	);
	for (const never of ["npm ", "gh auth token", "packages", "NODE_AUTH_TOKEN"]) expect(seen).not.toContain(never);
	expect(leftovers()).toEqual([]);
	// Visibility was read before anything was built.
	expect(seen.indexOf("gh api repos")).toBeLessThan(seen.indexOf("bun install"));
});

test("SIGTERM in the middle removes the temporary directory and the worktree", async () => {
	const proc = release([], { STUB_BUN_HANG: "1" });
	const started = Date.now();
	while (!calls().includes("bun install")) {
		if (Date.now() - started > 20_000) throw new Error("never got to the build");
		// A child process's progress shows only in the log it writes: there is no event to await.
		await Bun.sleep(50);
	}
	expect(leftovers()).toHaveLength(1);
	expect(worktrees()).toHaveLength(2);
	proc.kill("SIGTERM");
	const r = await finish(proc);
	expect(r.code).toBe(143);
	expect(leftovers()).toEqual([]);
	expect(worktrees()).toHaveLength(1);
	expect(calls()).not.toContain("npm publish");
});

test("SIGTERM also stops what the command started, and the script ends only after they are gone", async () => {
	const proc = release([], { STUB_BUN_GRANDCHILD: "1" });
	const pidFile = join(base, "grandchild.pid");
	await pollUntil(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "", "the build's own child");
	const grandchild = Number(readFileSync(pidFile, "utf8"));
	expect(processExists(grandchild)).toBe(true);
	proc.kill("SIGTERM");
	const r = await finish(proc);
	expect(r.code).toBe(143);
	// Not merely told to stop: gone by the time the script reports, with the tree it was writing to.
	expect(processExists(grandchild)).toBe(false);
	expect(leftovers()).toEqual([]);
	expect(worktrees()).toHaveLength(1);
});

test("without a desktop session the release stops before anything is built, naming it", async () => {
	const r = await finish(release(["--dry-run"], { STUB_SESSION: "Background" }));
	expect(r.code).toBe(1);
	expect(r.out).toContain("no logged-in desktop session (launchctl managername: Background)");
	expect(r.out).toContain("nothing was built");
	expect(calls()).not.toContain("bun install");
	expect(leftovers()).toEqual([]);
	expect(worktrees()).toHaveLength(1);
});

test("a Finder that cannot be scripted stops it with what to allow", async () => {
	const r = await finish(release(["--dry-run"], { STUB_FINDER_FAIL: "1" }));
	expect(r.code).toBe(1);
	expect(r.out).toContain("Finder cannot be scripted");
	expect(r.out).toContain("Automation");
	expect(calls()).not.toContain("bun install");
	expect(worktrees()).toHaveLength(1);
});

test("a gh token without repo stops a release that would publish, not a dry run", async () => {
	const publishing = await finish(release([], { STUB_SCOPES: "gist" }));
	expect(publishing.code).toBe(1);
	expect(publishing.out).toContain("the gh token lacks repo");
	const seen = calls();
	for (const never of ["bun ", "gh release"]) expect(seen).not.toContain(never);
	expect(leftovers()).toEqual([]);
	const dry = await finish(release(["--dry-run"], { STUB_SCOPES: "gist" }));
	expect(dry.code).toBe(0);
});

test("everything missing is reported together", async () => {
	const r = await finish(release([], { STUB_SESSION: "Background", STUB_SCOPES: "gist" }, true));
	expect(r.code).toBe(1);
	expect(r.out).toContain("no logged-in desktop session");
	expect(r.out).toContain("the gh token lacks repo:");
});

test("without the signing identity the release stops before anything is built, since every update would lose the app's permissions", async () => {
	const r = await finish(release(["--dry-run"], { STUB_NO_IDENTITY: "1" }));
	expect(r.code).toBe(1);
	expect(r.out).toContain('no code-signing identity named "omp-webui local signing"');
	expect(r.out).toContain("bun scripts/signing-identity.ts");
	expect(r.out).toContain("nothing was built");
	expect(calls()).not.toContain("bun install");
	expect(leftovers()).toEqual([]);
	expect(worktrees()).toHaveLength(1);
});

test("a release Actions already made gets its body replaced by the notes and the install steps, and the dmg", async () => {
	// What the workflow leaves: a release with the notes and "no installer yet" (see .github/workflows/release.yml).
	const r = await finish(release([], { STUB_RELEASE_EXISTS: "1" }));
	expect(r.code).toBe(0);
	const seen = calls();
	expect(seen).not.toContain("gh release create");
	expect(seen).toContain(`gh release edit ${TAG}`);
	expect(seen).toContain(`gh release upload ${TAG}`);
	// The install steps (the quarantine step without which macOS refuses to open the app) are in the page again.
	expect(readFileSync(join(base, "edited-body"), "utf8")).toBe("notes\ninstall\n");
});

// ------------------------------------------------------------------ arguments

test("a flag it does not know, the quiet-machine wait's included (CI runs the timing-sensitive suites now), is refused before anything runs", async () => {
	for (const bad of [["--no-wait"], ["--max-load", "2"], ["--max-wait", "5"], ["--frobnicate"], ["v1.2.3"]]) {
		const r = await finish(release(["--dry-run", ...bad]));
		expect([r.code, r.out.includes("usage: bun scripts/release-local.ts vX.Y.Z [--skip-tests] [--dry-run]")]).toEqual([
			2,
			true,
		]);
		expect(calls()).toBe("");
	}
});
