import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { isRecord } from "../shared/guards.ts";
import { childEnv } from "./env.ts";
import { type Answer, type Ask, labelOf, type ModelLike, type Models, NO_USAGE } from "./omp/gate/review.ts";
import { readKeys } from "./omp/model-config.ts";
import { availableModels } from "./omp/models.ts";

/**
 * The reviewer as the server can reach it, for the benchmark (`guard-bench.ts`). The gate asks a model from inside omp, with
 * omp's own model library; the server has none, so it asks omp: one short-lived `omp -p` per request, with the reviewer's
 * prompt as the system prompt. What the reviewer is chosen among, and in which order, is the gate's own rule
 * (`chooseReviewers` in `server/omp/gate/review.ts`, the same function), given what the gate is given: the models omp can
 * use, omp's roles (`@smol`, `@slow`, `@default`, `@reviewer`), its `retry.fallbackChains.reviewer`, and the model of the agent
 * (here, the one the `default` role names).
 *
 * `omp -p --no-tools` is not a bare model call, so `QUIET_OVERLAY` makes it one. Found by reading what a stub provider was
 * sent (tests/contract/guard-reviewer.test.ts keeps it found): with only `--no-tools --no-skills --no-rules` the request
 * still carried the user's AGENTS.md, memory and auto-learn guidance and two tools (`manage_skill`, `learn`); every MCP
 * server of the user's configuration was started, and the run waited up to 30 s for each. The overlay turns off the memory,
 * the auto-learn, and every discovery source that contributes context files or MCP servers.
 */

/** The settings of the run that make it a plain request: no memory, no context files, no MCP servers, no skills. */
export const QUIET_OVERLAY = [
	"memory:",
	"  backend: off",
	"autolearn:",
	"  enabled: false",
	"skills:",
	"  enabled: false",
	"enabledProviders: []",
	// Discovery sources only (never a model provider's id): native holds ~/.omp/agent/AGENTS.md and mcp.json.
	"disabledProviders: [native, omp-plugins, agent-plugins, agents, mcp-json, agents-md, claude-md, custom-context]",
	"contextFiles:",
	"  extra: []",
	"mcp:",
	"  enableProjectConfig: false",
	"",
].join("\n");

/** What the benchmark asks of omp: who reviews (as the gate chooses), and how one is asked. */
export interface ReviewerSource {
	choice(): Promise<{ models: Models; chain: string[]; agent: ModelLike | undefined }>;
	ask: Ask;
}

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"];

/** The vendor a model comes from, as far as its id says (omp's own `family` is not reachable from here); else its provider. */
const FAMILIES: readonly (readonly [RegExp, string])[] = [
	[/claude/i, "anthropic"],
	[/gpt|^o\d|codex/i, "openai"],
	[/gemini|gemma/i, "google"],
	[/qwen/i, "qwen"],
	[/deepseek/i, "deepseek"],
	[/kimi|moonshot/i, "moonshot"],
	[/glm/i, "zhipu"],
	[/llama/i, "meta"],
	[/mistral|mixtral|ministral/i, "mistral"],
];
export const familyOf = (m: ModelLike): string => FAMILIES.find(([pattern]) => pattern.test(m.id))?.[1] ?? m.provider;

/** `provider/id:level` as a model selector (the level is a setting of the role, not a part of the model). */
const withoutLevel = (spec: string): string => {
	const at = spec.lastIndexOf(":");
	return at > 0 && LEVELS.includes(spec.slice(at + 1)) ? spec.slice(0, at) : spec;
};

/** The models omp can use now, and omp's roles, as `Models` (the gate's `ctx.models`). */
export function modelsOf(raw: readonly unknown[], roles: Record<string, unknown>): Models {
	const list: ModelLike[] = [];
	for (const m of raw) {
		if (!isRecord(m) || typeof m.provider !== "string" || typeof m.id !== "string") continue;
		const cost = isRecord(m.cost) ? m.cost : {};
		list.push({
			id: m.id,
			provider: m.provider,
			...(typeof m.api === "string" ? { api: m.api } : {}),
			cost: {
				...(typeof cost.input === "number" ? { input: cost.input } : {}),
				...(typeof cost.output === "number" ? { output: cost.output } : {}),
			},
		});
	}
	const find = (spec: string, depth: number): ModelLike | undefined => {
		const wanted = withoutLevel(spec.trim());
		if (wanted.startsWith("@")) {
			const role = roles[wanted.slice(1)];
			return typeof role === "string" && depth < 3 ? find(role, depth + 1) : undefined;
		}
		const exact = list.find((m) => labelOf(m) === wanted) ?? list.find((m) => m.id === wanted);
		if (exact) return exact;
		const near = list.filter((m) => labelOf(m).includes(wanted));
		return near.length === 1 ? near[0] : undefined;
	};
	return { list: () => list, resolve: (spec) => find(spec, 0), family: familyOf };
}

/** Where the quiet overlay is written once, in a folder of the server's own (mode 0700, the file 0600), gone when it exits. */
let overlayFile: string | null = null;
function quietOverlay(): string {
	if (overlayFile) return overlayFile;
	const dir = mkdtempSync(join(tmpdir(), "ompw-bench-"));
	process.once("exit", removeQuietOverlay);
	chmodSync(dir, 0o700);
	const file = join(dir, "reviewer.yml");
	writeFileSync(file, QUIET_OVERLAY, { mode: 0o600 });
	chmodSync(file, 0o600);
	overlayFile = file;
	return file;
}

/** Remove the quiet overlay's folder: when the process exits, or when a test that asked a reviewer is done (#768). */
export function removeQuietOverlay(): void {
	if (!overlayFile) return;
	rmSync(dirname(overlayFile), { recursive: true, force: true });
	overlayFile = null;
}

/** The command line of one request: print mode, the reviewer's prompt as the system prompt, nothing else of omp's. */
export function reviewerArgs(model: ModelLike, system: string, user: string, cwd: string, overlay: string): string[] {
	return [
		"-p",
		`--model=${labelOf(model)}`,
		`--system-prompt=${system}`,
		"--thinking=off",
		"--no-tools",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--no-rules",
		"--no-title",
		"--no-lsp",
		"--no-pty",
		`--config=${overlay}`,
		`--cwd=${cwd}`,
		user,
	];
}

/** Ask one model through `omp -p`. A signal that aborts ends the process. */
export function ompAsk(bin: string, cwd: string = tmpdir(), env: Record<string, string | undefined> = {}): Ask {
	return async (model, system, user, signal): Promise<Answer> => {
		const proc = Bun.spawn([bin, ...reviewerArgs(model, system, user, cwd, quietOverlay())], {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			env: childEnv(env),
			signal,
		});
		const [out, err, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("the request was cancelled");
		if (code !== 0)
			return {
				text: out.trim(),
				usage: NO_USAGE,
				stopReason: "error",
				errorMessage: err.trim().slice(-300) || `omp exited with status ${code}`,
			};
		return { text: out.trim(), usage: NO_USAGE, stopReason: "stop" };
	};
}

/** omp as the benchmark's reviewer: the gate's own choice among omp's models, asked through `omp -p`. */
export function ompReviewer(bin: string, env: Record<string, string | undefined> = {}): ReviewerSource {
	return {
		async choice() {
			const [raw, config] = await Promise.all([
				availableModels(bin),
				readKeys(bin, homedir(), ["modelRoles", "retry.fallbackChains"], { env }, 30_000),
			]);
			const roles = isRecord(config.modelRoles) ? config.modelRoles : {};
			const chains = isRecord(config["retry.fallbackChains"]) ? config["retry.fallbackChains"] : {};
			const chain = Array.isArray(chains.reviewer)
				? chains.reviewer.filter((s): s is string => typeof s === "string")
				: [];
			const models = modelsOf(raw, roles);
			return { models, chain, agent: models.resolve("@default") };
		},
		ask: ompAsk(bin, tmpdir(), env),
	};
}
