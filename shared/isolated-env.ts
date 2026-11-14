/**
 * A project folder's isolated environment (docs/superpowers/specs/2026-11-14-isolated-project-env-design.md): a folder
 * holding `.ompw-env/ompw-env.json` has every process omp-webui starts in it (or in a folder inside it) install and cache
 * what npm, bun, pip, uv, cargo, go, Playwright and Hugging Face download inside `.ompw-env/`, so trashing the folder takes
 * all of it. This is the pure part: the variables for a root folder. Finding the root and writing the marker and the
 * cargo links is `server/isolated-env.ts`'s.
 */

/** The folder inside an isolated project that holds what is installed there. */
export const ISOLATED_DIR = ".ompw-env";
/** The file that makes a folder isolated (a `.ompw-env` without it means nothing). */
export const ISOLATED_MARKER = "ompw-env.json";
/** What the marker holds. */
export const ISOLATED_MARKER_BODY = `${JSON.stringify({ version: 1 })}\n`;

/** The variable that tells a process (and the page) that it runs isolated: the `.ompw-env` folder. */
export const ISOLATED_ENV_VAR = "OMPW_ISOLATED_ENV";
/** The variable the model-guidance extension reads to tell every agent (`isolatedNote`, `server/omp/guidance/extension.ts`). */
export const ISOLATED_NOTE_VAR = "OMPW_ISOLATED_NOTE";

/** What an isolated folder keeps inside itself. `npm-global` is npm's global installs, left out where nvm is installed. */
export type IsolatedTool = "npm" | "npm-global" | "bun" | "pip" | "uv" | "cargo" | "go" | "playwright" | "huggingface";

/** What is read of the computer before the variables are worked out. */
export interface IsolationFacts {
	/** nvm is installed: it refuses to work while `npm_config_prefix` is set, so npm's global installs stay outside. */
	nvm: boolean;
}

/** Why a folder may not be made isolated (`server/isolated-env.ts` `isolationRefusal`). */
export type IsolationRefusal = "protected" | "projectsFolder" | "containsOther" | "linked";

/** `GET /api/isolation?folder=`: the isolated folder it is in (or will be: a worktree), why it could not be made one, and whether this computer offers it. */
export interface IsolationInfo {
	root: string | null;
	refused: IsolationRefusal | null;
	supported: boolean;
}

/**
 * The variables of the isolated folder `root` (no separator at its end), on top of `basePath` (the `PATH` the process
 * would have had), and what they cover. `HF_HOME` (the Hugging Face login) and `RUSTUP_HOME` (Rust's toolchains) are
 * never set.
 */
export function isolatedEnv(
	root: string,
	facts: IsolationFacts,
	basePath: string,
): { env: Record<string, string>; covered: IsolatedTool[] } {
	const e = `${root}/${ISOLATED_DIR}`;
	const env: Record<string, string> = {
		[ISOLATED_ENV_VAR]: e,
		npm_config_cache: `${e}/cache/npm`,
		BUN_INSTALL: `${e}/bun`,
		BUN_INSTALL_CACHE_DIR: `${e}/cache/bun`,
		PYTHONUSERBASE: `${e}/python`,
		PIP_CACHE_DIR: `${e}/cache/pip`,
		UV_CACHE_DIR: `${e}/cache/uv`,
		UV_TOOL_DIR: `${e}/uv/tools`,
		UV_TOOL_BIN_DIR: `${e}/uv/bin`,
		UV_PYTHON_INSTALL_DIR: `${e}/uv/python`,
		CARGO_HOME: `${e}/cargo`,
		GOPATH: `${e}/go`,
		GOCACHE: `${e}/cache/go-build`,
		PLAYWRIGHT_BROWSERS_PATH: `${e}/ms-playwright`,
		// HF_HOME too: the CLI writes its own files there (update checks), and the token is linked in (`ensureIsolated`).
		HF_HOME: `${e}/huggingface`,
		HF_HUB_CACHE: `${e}/huggingface/hub`,
		HF_DATASETS_CACHE: `${e}/huggingface/datasets`,
		HF_XET_CACHE: `${e}/huggingface/xet`,
	};
	const covered: IsolatedTool[] = ["npm", "bun", "pip", "uv", "cargo", "go", "playwright", "huggingface"];
	if (!facts.nvm) {
		env.npm_config_prefix = `${e}/npm`;
		covered.splice(1, 0, "npm-global");
	}
	const bins = isolatedPathPrefix(root);
	env.PATH = basePath ? `${bins.join(":")}:${basePath}` : bins.join(":");
	return { env, covered };
}

/** The folders `isolatedEnv` puts in front of `PATH`, for a shell whose startup files moved them (the Terminal tab). */
export function isolatedPathPrefix(root: string): string[] {
	const e = `${root}/${ISOLATED_DIR}`;
	return ["npm/bin", "bun/bin", "python/bin", "uv/bin", "cargo/bin", "go/bin"].map((b) => `${e}/${b}`);
}

const NAMES: Record<Exclude<IsolatedTool, "npm-global">, string> = {
	npm: "npm's cache",
	bun: "bun (global installs and its cache)",
	pip: "pip (`pip install --user` and its cache)",
	uv: "uv (its cache, `uv tool install`, `uv python install`)",
	cargo: "cargo (`cargo install`, crates and git dependencies)",
	go: "go (`go install`, modules, build cache)",
	playwright: "Playwright's browsers",
	huggingface: "Hugging Face models and datasets (the login stays the person's)",
};

/** The note for the agent's system prompt: what stays in the project, and what would not. */
export function isolatedNote(root: string, covered: readonly IsolatedTool[]): string {
	const inside = covered.flatMap((t) => (t === "npm-global" ? ["npm (`npm install -g`)"] : [NAMES[t]]));
	const outside = ["`brew`", "`sudo`", "system package managers"];
	if (!covered.includes("npm-global"))
		outside.unshift("`npm install -g` (nvm is installed, so npm's global folder is not moved)");
	return [
		"## Isolated project environment",
		`This project folder (${root}) has an isolated environment: what these tools install or download goes into ${root}/${ISOLATED_DIR}, so it goes with the project when the person removes the folder. Install and download with them as usual, globally too: ${inside.join("; ")}.`,
		`These would still install outside the project, so ask the person before using them: ${outside.join(", ")}.`,
	].join("\n");
}
