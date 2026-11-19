import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { envFor, findIsolatedRoot, ISOLATION_SUPPORTED, worktreeToAdopt } from "../../server/isolated-env.ts";
import {
	ISOLATED_DIR,
	ISOLATED_MARKER,
	ISOLATED_MARKER_BODY,
	isolatedEnv,
	isolatedNote,
} from "../../shared/isolated-env.ts";
import { has } from "../support/needs.ts";
import { tempDir } from "../support/temp-dirs.ts";

test("an isolated folder sends every covered tool's installs and caches into its .ompw-env, and nothing of the person's login", () => {
	const { env, covered } = isolatedEnv("/p", { nvm: false }, "/usr/bin:/bin");
	expect(env.OMPW_ISOLATED_ENV).toBe("/p/.ompw-env");
	expect(env.npm_config_prefix).toBe("/p/.ompw-env/npm");
	expect(env.npm_config_cache).toBe("/p/.ompw-env/cache/npm");
	expect(env.CARGO_HOME).toBe("/p/.ompw-env/cargo");
	expect(env.GOPATH).toBe("/p/.ompw-env/go");
	expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe("/p/.ompw-env/ms-playwright");
	expect(env.HF_HUB_CACHE).toBe("/p/.ompw-env/huggingface/hub");
	// Hugging Face's home moves too (its token is linked in, `ensureIsolated`); Rust's toolchains stay where they are.
	expect(env.HF_HOME).toBe("/p/.ompw-env/huggingface");
	expect(env.RUSTUP_HOME).toBeUndefined();
	expect(env.PATH.startsWith("/p/.ompw-env/npm/bin:")).toBe(true);
	expect(env.PATH.endsWith(":/usr/bin:/bin")).toBe(true);
	expect(covered).toContain("npm-global");
});

test("deno, corepack, pnpm, yarn, RubyGems and pipx install inside the folder too, with their programs on PATH", () => {
	const { env, covered } = isolatedEnv("/p", { nvm: false }, "/usr/bin");
	const e = "/p/.ompw-env";
	expect(covered).toEqual(expect.arrayContaining(["deno", "corepack", "pnpm", "yarn", "gem", "pipx"]));
	expect(env.DENO_DIR).toBe(`${e}/cache/deno`);
	expect(env.DENO_INSTALL_ROOT).toBe(`${e}/deno`);
	expect(env.COREPACK_HOME).toBe(`${e}/corepack`);
	// pnpm's store is under its home, and its global programs are in it.
	expect(env.PNPM_HOME).toBe(`${e}/pnpm`);
	expect(env.YARN_CACHE_FOLDER).toBe(`${e}/cache/yarn`);
	expect(env.YARN_GLOBAL_FOLDER).toBe(`${e}/yarn/global`);
	expect(env.YARN_PREFIX).toBe(`${e}/yarn`);
	expect(env.GEM_HOME).toBe(`${e}/gem`);
	expect(env.GEM_SPEC_CACHE).toBe(`${e}/cache/gem-specs`);
	expect(env.PIPX_HOME).toBe(`${e}/pipx`);
	expect(env.PIPX_BIN_DIR).toBe(`${e}/pipx/bin`);
	for (const bin of ["deno/bin", "pnpm", "yarn/bin", "gem/bin", "pipx/bin"]) expect(env.PATH).toContain(`${e}/${bin}:`);
	// Every value is inside the folder, and no `npm_config_` variable npm does not know (it warns about each one).
	for (const [k, v] of Object.entries(env)) {
		if (k === "PATH" || k === "OMPW_ISOLATED_ENV") continue;
		expect(v.startsWith(`${e}/`), k).toBe(true);
		if (k.startsWith("npm_config_")) expect(["npm_config_cache", "npm_config_prefix"], k).toContain(k);
	}
	const note = isolatedNote("/p", covered);
	for (const named of ["deno", "corepack", "pnpm", "yarn", "RubyGems", "pipx"]) expect(note).toContain(named);
	expect(note).toContain("`corepack enable` (its shims go next to node)");
});

test("with nvm installed npm's global installs are left outside, and the agent is told so", () => {
	const { env, covered } = isolatedEnv("/p", { nvm: true }, "/usr/bin");
	expect(env.npm_config_prefix).toBeUndefined();
	expect(env.npm_config_cache).toBe("/p/.ompw-env/cache/npm");
	expect(covered).not.toContain("npm-global");
	const note = isolatedNote("/p", covered);
	expect(note).toContain("ask the person before using them: `npm install -g`");
	expect(isolatedNote("/p", isolatedEnv("/p", { nvm: false }, "").covered)).toContain("npm (`npm install -g`)");
});

test.skipIf(has.isolatedEnvironment)(
	"where it is not offered (Windows), a folder with the marker is not isolated, and nothing started there gets its variables",
	() => {
		const dir = tempDir("ompw-iso-win-");
		mkdirSync(join(dir, ISOLATED_DIR));
		writeFileSync(join(dir, ISOLATED_DIR, ISOLATED_MARKER), ISOLATED_MARKER_BODY);
		expect(ISOLATION_SUPPORTED).toBe(false);
		expect(findIsolatedRoot(dir)).toBeNull();
		expect(worktreeToAdopt(dir)).toBeNull();
		expect(envFor(dir, "C:\\Windows")).toBeNull();
	},
);
