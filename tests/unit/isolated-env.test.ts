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
