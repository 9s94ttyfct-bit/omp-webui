import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	envFor,
	findIsolatedRoot,
	IsolationError,
	isolationRefusal,
	isolationState,
	setIsolated,
} from "../../server/isolated-env.ts";
import { dependencyCandidate } from "../../server/sessions/cleanup-rules.ts";

let dir: string;
let home: string;
let ctx: Parameters<typeof setIsolated>[2];

beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "ompw-iso-")));
	home = join(dir, "home");
	mkdirSync(join(home, ".cargo"), { recursive: true });
	mkdirSync(join(dir, "omp"));
	ctx = { protect: { home, data: [join(home, ".omp")] }, projectsFolder: join(dir, "omp"), others: [] };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("a folder switched on is found from inside it; a .ompw-env without the marker means nothing", () => {
	const p = join(dir, "omp", "proj");
	mkdirSync(join(p, "src", "deep"), { recursive: true });
	mkdirSync(join(dir, "other", ".ompw-env"), { recursive: true });
	expect(findIsolatedRoot(join(dir, "other"))).toBeNull();
	expect(setIsolated(p, true, ctx, home)).toBe(p);
	expect(findIsolatedRoot(join(p, "src", "deep"))).toBe(p);
	expect(readFileSync(join(p, ".ompw-env", ".gitignore"), "utf8")).toBe("*\n");
	// Off removes the marker only: what was installed stays until the folder goes to the Trash.
	writeFileSync(join(p, ".ompw-env", "keep"), "x");
	expect(setIsolated(join(p, "src"), false, ctx, home)).toBeNull();
	expect(findIsolatedRoot(p)).toBeNull();
	expect(existsSync(join(p, ".ompw-env", "keep"))).toBe(true);
});

test("the person's cargo settings and Hugging Face token are linked in, kept, put right, or left alone, and a missing one is not invented", () => {
	const p = join(dir, "omp", "proj");
	mkdirSync(p);
	writeFileSync(join(home, ".cargo", "config.toml"), "[net]\n");
	mkdirSync(join(home, ".cache", "huggingface"), { recursive: true });
	writeFileSync(join(home, ".cache", "huggingface", "token"), "hf_x");
	setIsolated(p, true, ctx, home);
	const link = join(p, ".ompw-env", "cargo", "config.toml");
	expect(readlinkSync(link)).toBe(join(home, ".cargo", "config.toml"));
	expect(readlinkSync(join(p, ".ompw-env", "huggingface", "token"))).toBe(join(home, ".cache", "huggingface", "token"));
	expect(existsSync(join(p, ".ompw-env", "cargo", "credentials.toml"))).toBe(false);
	expect(existsSync(join(p, ".ompw-env", "huggingface", "stored_tokens"))).toBe(false);
	// A broken or wrong link is put right when a process starts there.
	rmSync(link);
	symlinkSync(join(dir, "gone"), link);
	envFor(p, "/usr/bin", { home, env: {} });
	expect(readlinkSync(link)).toBe(join(home, ".cargo", "config.toml"));
	// A file the person put there is theirs.
	rmSync(link);
	writeFileSync(link, "mine");
	envFor(p, "/usr/bin", { home, env: {} });
	expect(lstatSync(link).isSymbolicLink()).toBe(false);
	expect(readFileSync(link, "utf8")).toBe("mine");
});

test("a process started inside gets the variables and the agent's note; outside none", () => {
	const p = join(dir, "omp", "proj");
	mkdirSync(join(p, "sub"), { recursive: true });
	expect(envFor(p, "/usr/bin", { home, env: {} })).toBeNull();
	setIsolated(p, true, ctx, home);
	const got = envFor(join(p, "sub"), "/usr/bin", { home, env: {} });
	expect(got?.root).toBe(p);
	expect(got?.env.CARGO_HOME).toBe(join(p, ".ompw-env", "cargo"));
	expect(got?.env.npm_config_prefix).toBe(join(p, ".ompw-env", "npm"));
	expect(got?.env.OMPW_ISOLATED_NOTE).toContain(p);
	// nvm installed: npm's global folder stays where it is.
	expect(envFor(p, "/usr/bin", { home, env: { NVM_DIR: "/x" } })?.env.npm_config_prefix).toBeUndefined();
});

test("home, system folders, the projects folder and a folder holding another conversation's are refused", () => {
	expect(isolationRefusal(home, ctx)).toBe("protected");
	expect(isolationRefusal("/usr/local", ctx)).toBe("protected");
	expect(isolationRefusal(join(dir, "omp"), ctx)).toBe("projectsFolder");
	const holder = join(dir, "work");
	expect(isolationRefusal(holder, { ...ctx, others: [join(holder, "a")] })).toBe("containsOther");
	expect(isolationRefusal(holder, { ...ctx, others: [holder] })).toBeNull();
	mkdirSync(join(dir, "omp", "x"));
	expect(() => setIsolated(join(dir, "omp"), true, ctx, home)).toThrow(IsolationError);
});

test("a git worktree of an isolated project gets an isolated environment of its own", () => {
	const repo = join(dir, "omp", "repo");
	mkdirSync(repo);
	const git = (...args: string[]) => {
		const r = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
		if (r.exitCode !== 0) throw new Error(r.stderr.toString());
	};
	git("init", "-q");
	git("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-q", "--allow-empty", "-m", "x");
	const wt = join(dir, "wt");
	git("worktree", "add", "-q", wt);
	expect(envFor(wt, "", { home, env: {} })).toBeNull();
	setIsolated(repo, true, ctx, home);
	const got = envFor(wt, "", { home, env: {} });
	expect(got?.root).toBe(wt);
	expect(findIsolatedRoot(wt)).toBe(wt);
	expect(got?.env.GOPATH).toBe(join(wt, ".ompw-env", "go"));

	// New chat shows a worktree that would be adopted as isolated, and switching it off keeps it off.
	const wt2 = join(dir, "wt2");
	git("worktree", "add", "-q", wt2);
	expect(isolationState(wt2, ctx).root).toBe(wt2);
	setIsolated(wt2, false, ctx, home);
	expect(isolationState(wt2, ctx).root).toBeNull();
	expect(envFor(wt2, "", { home, env: {} })).toBeNull();
	// And on again at its top level.
	expect(setIsolated(join(wt2), true, ctx, home)).toBe(wt2);
	expect(envFor(wt2, "", { home, env: {} })?.root).toBe(wt2);
	// A main folder switched off is still offered in the delete dialog (what was installed is still there).
	setIsolated(repo, false, ctx, home);
	expect(existsSync(join(repo, ".ompw-env", "ompw-env.off"))).toBe(true);
});

test("a .ompw-env that is a link is refused: what is installed would land outside, and the Trash would take only the link", () => {
	const p = join(dir, "omp", "linked");
	const outside = join(dir, "outside");
	mkdirSync(p);
	mkdirSync(join(outside, "cargo"), { recursive: true });
	writeFileSync(join(outside, "ompw-env.json"), "{}");
	symlinkSync(outside, join(p, ".ompw-env"));
	expect(findIsolatedRoot(p)).toBeNull();
	expect(envFor(p, "", { home, env: {} })).toBeNull();
	expect(() => setIsolated(p, true, ctx, home)).toThrow(IsolationError);
});

test("the delete dialog offers an isolated environment as a folder of its own", () => {
	expect(
		dependencyCandidate(
			".ompw-env",
			() => false,
			(n) => n === "ompw-env.json",
		),
	).toEqual({
		kind: ".ompw-env",
		needsIgnored: false,
	});
	expect(
		dependencyCandidate(
			".ompw-env",
			() => false,
			() => false,
		),
	).toBeNull();
});
