#!/usr/bin/env bun
/**
 * Real installs in an isolated folder (`server/isolated-env.ts`): each tool the isolated environment covers installs or
 * downloads something with the variables omp-webui gives a process there, and the script says whether it landed inside
 * the folder and whether anything new appeared in that tool's usual places outside it. Needs the network and the tools;
 * a tool that is not installed is skipped. Run by hand: `bun scripts/check-isolated-env.ts [tool…]`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ensureIsolated, envFor } from "../server/isolated-env.ts";
import { ISOLATED_DIR } from "../shared/isolated-env.ts";

const home = homedir();
const h = (p: string) => join(home, p);

interface Check {
	tool: string;
	/** The program that must be on PATH for the check to run. */
	needs: string;
	cmd: string[];
	/** Paths in `.ompw-env` that must exist afterwards (a trailing `*` matches a name prefix). */
	inside: string[];
	/** The tool's usual places outside, looked at for anything new. */
	outside: string[];
}

const checks: Check[] = [
	{
		tool: "npm",
		needs: "npm",
		cmd: ["npm", "install", "-g", "cowsay"],
		inside: ["npm/lib/node_modules/cowsay", "cache/npm"],
		outside: [h(".npm"), "/opt/homebrew/lib/node_modules", "/usr/local/lib/node_modules", "/opt/homebrew/bin"],
	},
	{
		tool: "bun",
		needs: "bun",
		cmd: ["bun", "add", "-g", "cowsay"],
		inside: ["bun/install/global/node_modules/cowsay", "bun/bin/cowsay"],
		outside: [h(".bun"), h("Library/Caches/bun")],
	},
	{
		tool: "pip",
		needs: "python3",
		// `--ignore-installed`: a package the system Python already has would otherwise install nothing anywhere.
		cmd: ["python3", "-m", "pip", "install", "--user", "--ignore-installed", "six"],
		inside: ["python/lib", "cache/pip"],
		outside: [h(".local"), h("Library/Python"), h("Library/Caches/pip"), h(".cache/pip")],
	},
	{
		tool: "uv",
		needs: "uv",
		cmd: ["uv", "tool", "install", "ruff"],
		inside: ["uv/tools/ruff", "uv/bin/ruff", "cache/uv"],
		outside: [h(".local/share/uv"), h(".local/bin"), h(".cache/uv"), h("Library/Caches/uv")],
	},
	{
		tool: "cargo",
		needs: "cargo",
		cmd: ["cargo", "install", "--locked", "ripgrep"],
		inside: ["cargo/bin/rg", "cargo/registry"],
		outside: [h(".cargo/bin"), h(".cargo/registry"), h(".cargo/git")],
	},
	{
		tool: "go",
		needs: "go",
		cmd: ["go", "install", "golang.org/x/example/hello@latest"],
		inside: ["go/bin/hello", "go/pkg/mod", "cache/go-build"],
		outside: [h("go"), h("Library/Caches/go-build")],
	},
	{
		tool: "playwright",
		needs: "npx",
		cmd: ["npx", "-y", "playwright@1.64.1", "install", "chromium-headless-shell"],
		inside: ["ms-playwright/chromium_headless_shell-*"],
		outside: [h("Library/Caches/ms-playwright"), h(".cache/ms-playwright"), h(".npm")],
	},
	{
		tool: "huggingface",
		needs: "uvx",
		cmd: ["uvx", "--from", "huggingface_hub", "hf", "download", "hf-internal-testing/tiny-random-bert"],
		inside: ["huggingface/hub/models--hf-internal-testing--tiny-random-bert"],
		outside: [h(".cache/huggingface"), h(".cache/uv"), h("Library/Caches/uv")],
	},
];

const wanted = process.argv.slice(2);
const root = realpathSync(mkdtempSync(join(tmpdir(), "ompw-iso-check-")));
const e = join(root, ISOLATED_DIR);
// The folder as New chat's switch makes it, then the variables a process started in it gets.
ensureIsolated(root);
const isolated = envFor(root, process.env.PATH ?? "");
if (!isolated) throw new Error("the folder did not become isolated");
const env = { ...process.env, ...isolated.env };

const which = (bin: string) => spawnSync("sh", ["-c", `command -v ${bin}`], { env }).status === 0;

/** What is newer than `stamp` in `dirs` (a few levels down: a new entry changes its folder's time). */
function newer(dirs: string[], stamp: string): string[] {
	const found: string[] = [];
	for (const d of dirs.filter((d) => existsSync(d))) {
		const r = spawnSync("find", [d, "-maxdepth", "3", "-newer", stamp], { encoding: "utf8" });
		found.push(...r.stdout.split("\n").filter(Boolean).slice(0, 5));
	}
	return found;
}

function present(rel: string): boolean {
	if (!rel.endsWith("*")) return existsSync(join(e, rel));
	const dir = join(e, rel, "..");
	const prefix = rel.slice(rel.lastIndexOf("/") + 1, -1);
	return existsSync(dir) && readdirSync(dir).some((n) => n.startsWith(prefix));
}

let failed = false;
for (const c of checks) {
	if (wanted.length && !wanted.includes(c.tool)) continue;
	if (!which(c.needs)) {
		console.log(`${c.tool}: skipped (${c.needs} not installed)`);
		continue;
	}
	const stamp = join(tmpdir(), `ompw-iso-stamp-${c.tool}`);
	writeFileSync(stamp, "");
	// File times have a coarse grain on some file systems: what a tool writes must be after the stamp.
	await Bun.sleep(1100);
	const started = Date.now();
	const r = spawnSync(c.cmd[0] as string, c.cmd.slice(1), { cwd: root, env, encoding: "utf8", timeout: 900_000 });
	const secs = ((Date.now() - started) / 1000).toFixed(0);
	const missing = c.inside.filter((p) => !present(p));
	const leaked = newer(c.outside, stamp);
	rmSync(stamp, { force: true });
	const ok = r.status === 0 && missing.length === 0 && leaked.length === 0;
	failed ||= !ok;
	console.log(
		`${c.tool}: ${ok ? "ok" : "FAILED"} (${secs}s) exit ${r.status}; inside: ${missing.length ? `missing ${missing.join(", ")}` : "yes"}; outside: ${leaked.length ? leaked.join(", ") : "none"}`,
	);
	if (r.status !== 0) console.log(`${(r.stderr || r.stdout).trim().split("\n").slice(-8).join("\n")}`);
}

// Go's module cache is read-only.
spawnSync("chmod", ["-R", "u+w", root]);
rmSync(root, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
