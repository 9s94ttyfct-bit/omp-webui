import {
	chmodSync,
	copyFileSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { platform } from "../../platform/index.ts";
import { RpcClient } from "../rpc-client.ts";
import { withTimeout } from "../run.ts";

/**
 * The context files omp loads for a folder, asked of omp itself (#308). omp's rules for which of `AGENTS.md`, `CLAUDE.md`,
 * `.omp/AGENTS.md`, the foreign tools' files in the home folder and the extra names it loads (opt-in providers, one user file,
 * the highest-priority provider's file at each depth, the nearest `.omp/`, `disabledExtensions`) change from release to
 * release, and so does what it does with an `@` import in one (it puts the imported text in): a copy of them here said
 * 5 of 8 files the agent never sees and missed the text of an import. omp says what it gives the agent in its system prompt,
 * as `<file path="…">` blocks in `<repo-rules>`, and a process started in the folder (no session, no tools, no extensions,
 * no memory, no MCP servers) tells it over `get_state`.
 */

const START_MS = 30_000;
const CALL_MS = 30_000;

/** What the probe process is told, on top of the person's own settings: nothing it does needs memory or a project's MCP servers. */
const PROBE_OVERLAY = [
	"memory:",
	'  backend: "off"',
	"autolearn:",
	"  enabled: false",
	"mcp:",
	"  enableProjectConfig: false",
	"",
].join("\n");

let overlayFile: string | null = null;
let overlayDir: string | null = null;

function probeOverlay(): string {
	if (overlayFile) return overlayFile;
	const dir = mkdtempSync(join(tmpdir(), "ompw-ctx-"));
	chmodSync(dir, 0o700);
	process.once("exit", removeProbeOverlay);
	const file = join(dir, "probe.yml");
	writeFileSync(file, PROBE_OVERLAY, { mode: 0o600 });
	overlayDir = dir;
	overlayFile = file;
	return file;
}

/** Remove the overlay's folder: when the process exits. */
export function removeProbeOverlay(): void {
	if (overlayDir) rmSync(overlayDir, { recursive: true, force: true });
	overlayDir = null;
	overlayFile = null;
}

/** A context file as omp gave it to the agent: where it is, and its text (an `@` import already replaced by what it names). */
export interface LoadedFile {
	/** Absolute. */
	path: string;
	text: string;
}

const RULES_BLOCK = /<repo-rules>([\s\S]*?)<\/repo-rules>/;
const FILE_BLOCK = /<file path="([^"]*)">\n?([\s\S]*?)\n?<\/file>/g;

/** The files of the `<repo-rules>` block of omp's system prompt (a string, or the blocks it is made of), in the order omp lists them. */
export function repoRuleFiles(systemPrompt: unknown, home = homedir()): LoadedFile[] {
	const prompt = Array.isArray(systemPrompt)
		? systemPrompt.filter((b): b is string => typeof b === "string").join("\n\n")
		: typeof systemPrompt === "string"
			? systemPrompt
			: "";
	const block = RULES_BLOCK.exec(prompt);
	if (!block) return [];
	const out: LoadedFile[] = [];
	for (const m of block[1].matchAll(FILE_BLOCK)) {
		const path = m[1] === "~" || m[1].startsWith("~/") ? join(home, m[1].slice(1)) : m[1];
		out.push({ path, text: m[2] });
	}
	return out;
}

/**
 * A copy of omp's agent folder for the probe, made of links to everything in it but its `mcp.json` (omp starts the servers it
 * names whatever the flags and settings say; `--no-tools`, `--tools` and disabling the `mcp-json` provider were tried and do
 * not stop it, disabling `native` does but takes the agent folder's `AGENTS.md` with it). The files the probe reads are the
 * real ones; the folder is removed when it is done. Null when the agent folder cannot be listed (it has no `mcp.json` to
 * start servers from either).
 */
function sanitizedAgentDir(agentDir: string): string | null {
	let names: string[];
	try {
		names = readdirSync(agentDir);
	} catch (e) {
		// No agent folder, no `mcp.json` in it. One that is there and cannot be listed is not asked about: the probe would run on it.
		if ((e as { code?: string }).code === "ENOENT") return null;
		throw new Error(`omp's agent folder cannot be read: ${(e as Error).message}`);
	}
	const dir = mkdtempSync(join(tmpdir(), "ompw-agent-"));
	chmodSync(dir, 0o700);
	for (const name of names) {
		if (name === "mcp.json") continue;
		const target = join(agentDir, name);
		try {
			if (platform.id === "win32") {
				// No privilege is needed for a junction (a folder) or a copy (a file).
				if (statSync(target).isDirectory()) symlinkSync(target, join(dir, name), "junction");
				else copyFileSync(target, join(dir, name));
			} else symlinkSync(target, join(dir, name));
		} catch {
			// A file that cannot be linked is one the probe goes without.
		}
	}
	return dir;
}

/**
 * Some omp versions refuse to start with no credential at all ("Set an API key environment variable"), and the probe only
 * asks for a prompt: it calls no model. A placeholder key stands in when neither the environment nor the caller has one.
 */
function probeCredential(env?: Record<string, string | undefined>): Record<string, string> {
	return env?.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY ? {} : { ANTHROPIC_API_KEY: "ompw-context-probe" };
}

/**
 * The context files omp loads for `cwd`, nearest first as omp lists them. `agentDir` is omp's agent folder, which the probe
 * is given a copy of without its `mcp.json`, so that no MCP server of the person's is started for a question about files.
 * Throws when omp does not start or answer in time (the process is killed): there is then no list, and a guess at one is
 * what this replaces. `env` is for tests.
 */
export async function loadedContextFiles(
	bin: string,
	cwd: string,
	agentDir: string,
	env?: Record<string, string | undefined>,
	startMs = START_MS,
	callMs = CALL_MS,
): Promise<LoadedFile[]> {
	const shadow = sanitizedAgentDir(agentDir);
	const client = new RpcClient({
		bin,
		args: [
			"--no-session",
			"--no-tools",
			"--no-lsp",
			"--no-extensions",
			"--no-skills",
			"--no-title",
			"--config",
			probeOverlay(),
		],
		cwd,
		env: { ...probeCredential(env), ...env, ...(shadow ? { PI_CODING_AGENT_DIR: shadow } : {}) },
		mode: "rpc",
		onFrame: () => {},
		onExit: () => {},
	});
	try {
		await withTimeout(client.ready, startMs, "omp did not start in time");
		const state = await client.call<{ systemPrompt?: unknown }>({ type: "get_state" }, callMs);
		// The copy's files are the agent folder's own (omp may name the copy by its real path: `/private/var` for `/var`).
		const copies = shadow ? [shadow, realpathSync(shadow)] : [];
		return repoRuleFiles(state.systemPrompt).map((f) => {
			const copy = copies.find((c) => f.path.startsWith(c + sep));
			return copy ? { ...f, path: join(agentDir, f.path.slice(copy.length + 1)) } : f;
		});
	} catch (e) {
		client.kill("SIGKILL");
		throw e;
	} finally {
		client.close();
		client.kill("SIGTERM");
		if (shadow) rmSync(shadow, { recursive: true, force: true });
	}
}
