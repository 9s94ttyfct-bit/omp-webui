import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type ApprovalMode, isApprovalMode } from "../../shared/approval.ts";
import { type CompactAt, compactAtOf, compactAtWrites } from "../../shared/compact-at.ts";
import { COMPACT_STEP_LOADED_SUFFIX, COMPACT_STEP_SUFFIX } from "../../shared/compact-step.ts";
import {
	DAMAGED_GUARD,
	type GuardOverride,
	type KeptGuard,
	keptJson,
	NO_GUARD,
	readKeptGuard,
} from "../../shared/guard.ts";
import { PROPOSE_GOAL_TOOL } from "../../shared/guided-goal.ts";
import { type ConversationModels, parseConversationModels } from "../../shared/model-config.ts";
import { GUIDANCE_SUFFIX } from "../../shared/model-guidance.ts";
import { isMode, type Mode } from "../../shared/offline.ts";
import { QUOTA_LOADED_SUFFIX, QUOTA_SUFFIX } from "../../shared/quota-hold.ts";
import { RISK_LOADED_SUFFIX, RISK_SUFFIX } from "../../shared/risk-confirm.ts";
import type { ConfigValue } from "../../shared/session-defaults.ts";
import { UNATTENDED_SUFFIX } from "../../shared/unattended.ts";
import { GUIDANCE_LOADED_SUFFIX } from "./guidance/extension.ts";
import { identitiesOf, ParkedStore } from "./parked.ts";
import { QUICK_MS, run } from "./run.ts";
import { UNATTENDED_LOADED_SUFFIX } from "./unattended/extension.ts";

/**
 * Tool approval (`tools.approvalMode`) per conversation.
 *
 * omp has no RPC command for it, but its settings are layered and a running RPC process watches every
 * `--config` overlay and reloads it a short while after it changes (omp: settings.md, "config overlays").
 * So each process gets an overlay of its own, passed last so that nothing else overrides it, and a mode
 * change is a rewrite of that one file: it applies to the process's next tool call, no restart.
 * `--approval-mode` could not do this: a command-line override beats every overlay.
 */

/** omp reloads a changed overlay after a 200 ms debounce; give it a margin before saying a change is in force. */
export const OMP_RELOAD_MS = 400;

/**
 * The mode omp itself resolves for `cwd` from its settings (global, project, overlays), as `omp config get` prints it;
 * null when it cannot say (or does not within `timeoutMs`). A value that is none of `APPROVAL_MODES` (a newer omp's
 * mode) comes back as omp names it. `env` is what a process would add to its environment (Light points omp at an agent
 * dir of its own).
 */
export async function configuredApprovalMode(
	bin: string,
	cwd?: string,
	env?: Record<string, string>,
	timeoutMs = QUICK_MS,
): Promise<string | null> {
	try {
		const ran = await run([bin, "config", "get", "tools.approvalMode"], { cwd, env, timeoutMs });
		return ran.stdout.trim().replace(/^"|"$/g, "") || null;
	} catch {
		return null;
	}
}

/**
 * omp's own `retry.waitForUsageReset` for `cwd` (global, project and overlays), as `omp config get` prints it; null
 * when it cannot say. Whether a failed turn waits out its provider's usage limit is omp's own retry (see
 * `ProcessOverlay.wait`): the app keeps no wait of its own.
 */
export async function configuredUsageWait(
	bin: string,
	cwd?: string,
	env?: Record<string, string>,
	timeoutMs = QUICK_MS,
): Promise<boolean | null> {
	try {
		const out = (await run([bin, "config", "get", "retry.waitForUsageReset"], { cwd, env, timeoutMs })).stdout.trim();
		return out === "true" ? true : out === "false" ? false : null;
	} catch {
		return null;
	}
}

/** Set omp's global `retry.waitForUsageReset`, as `omp config set` does in the terminal; throws omp's complaint. */
export async function configureUsageWait(
	bin: string,
	on: boolean,
	env?: Record<string, string>,
	timeoutMs = QUICK_MS,
): Promise<void> {
	const ran = await run([bin, "config", "set", "retry.waitForUsageReset", String(on)], { env, timeoutMs });
	if (ran.code !== 0) throw new Error(ran.stderr.trim().slice(0, 300) || `omp config set exited ${ran.code}`);
}

/**
 * The key a conversation's choices are kept under: its session file's real path, written or not yet (a new
 * conversation's file appears with its first reply, so then it is its directory's real path and its name). The page,
 * the routes and the process all name the same conversation by it, wherever a symlink (macOS's `/var`) lies on the way.
 */
export function sessionKey(file: string): string {
	try {
		return realpathSync(file);
	} catch {
		// not written yet
	}
	try {
		return join(realpathSync(dirname(file)), basename(file));
	} catch {
		return file;
	}
}

/**
 * `args` without the flags that set the mode for the whole process. They would override the overlay, so the
 * mode shown in the UI would not be the mode in force; the conversation's own switcher replaces them.
 */
export function stripApprovalFlags(args: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "--auto-approve" || a === "--yolo" || a.startsWith("--approval-mode=")) continue;
		if (a === "--approval-mode") {
			i++;
			continue;
		}
		out.push(a);
	}
	return out;
}

/**
 * Tools every process may call whatever its mode, as `tools.approval.<tool>: allow`. omp deep-merges the overlay over
 * the user's own `tools.approval` policies, so those stay; but a host tool carries no approval declaration of its own
 * (omp's normalizeDecision gives it tier `exec`), so in Ask-every-time and Ask-for-commands omp would prompt
 * `Allow tool: propose_goal` before the guided-goal interview's one tool could show its own confirmation, and denying
 * that prompt breaks the interview. The tool only shows the user a card; it starts nothing.
 */
const ALWAYS_ALLOWED_TOOLS: readonly string[] = [PROPOSE_GOAL_TOOL];

/**
 * The tools of one conversation's own that the overlay gives a policy of their own, whatever the permission mode: the
 * host tools the server serves it (see `Live.serveHostTools`). `allow`: omp does not ask the user about them (they only
 * read). `prompt`: omp asks every time, in Auto-approve too (omp: an explicit `tools.approval.<tool>: prompt` wins over
 * the mode in yolo), because what they do is not to happen without the person seeing it.
 */
export interface ToolPolicies {
	allow: readonly string[];
	prompt: readonly string[];
}

/** A conversation with no tools of its own. */
export const NO_TOOL_POLICIES: ToolPolicies = { allow: [], prompt: [] };

/**
 * The overlay's lines for a conversation switched to a preset: its roles, each role the configuration of its folder
 * sets that the preset does not as `null` (omp's mark in an overlay that no lower layer's value applies: the
 * preset's roles and only those, as `/modelpreset switch` leaves the config), and its thinking level when it has one.
 * Names and selectors are written as JSON strings, which YAML reads as they are. The subagent models are not here: they
 * live under `task`, which a setting held by `pin` may share, so `settingLines` writes both (see `agentModels`).
 */
function modelLines(models: ConversationModels, absent: readonly string[]): string[] {
	const roles = [
		...Object.entries(models.roles).map(([role, selector]) => `  ${JSON.stringify(role)}: ${JSON.stringify(selector)}`),
		...absent.filter((role) => !Object.hasOwn(models.roles, role)).map((role) => `  ${JSON.stringify(role)}: null`),
	];
	return [
		// A key with nothing under it is null, which replaces the config's roles instead of leaving them as they are.
		...(roles.length > 0 ? ["modelRoles:", ...roles] : ["modelRoles: {}"]),
		...(models.defaultThinkingLevel ? [`defaultThinkingLevel: ${models.defaultThinkingLevel}`] : []),
	];
}

/** omp's setting for the models of subagents, by agent name. */
const AGENT_MODELS_KEY = "task.agentModelOverrides";

/**
 * A conversation's subagent models as the overlay's record under `task.agentModelOverrides`: the preset's agents, and each
 * agent the configuration gives a model that the preset does not as `null`. omp merges the overlay's record into the
 * configuration's, so without the `null`s the preset's agents would be added to the configuration's, not replace them.
 * None where the models carry none: the configuration's apply as they are.
 */
function agentModels(models: ConversationModels | null, absentAgents: readonly string[]): AgentRecord | null {
	const own = models?.agentModelOverrides;
	if (!own || Object.keys(own).length === 0) return null;
	const record: AgentRecord = new Map(Object.entries(own));
	for (const agent of absentAgents) if (!record.has(agent)) record.set(agent, null);
	return record;
}

/** Agent name → selector, or `null` for an agent the conversation does without. A map: names are user text, not omp's keys. */
type AgentRecord = Map<string, string | null>;

/**
 * The overlay's lines for settings given by dotted key (`retry.enabled`): each key's parents as nested mappings, which
 * is how omp reads an overlay. Values are written as JSON scalars, which YAML reads as they are. The keys are omp's
 * own settings (see `SESSION_DEFAULT_KEYS`), never user text. `agents` goes in the same tree, under
 * `task.agentModelOverrides`, so that a setting under `task` and the subagent models are one `task` mapping: a key written
 * twice at the top of a YAML file keeps only the last.
 */
function settingLines(settings: Readonly<Record<string, ConfigValue>>, agents: AgentRecord | null = null): string[] {
	interface Node {
		[key: string]: Node | AgentRecord | ConfigValue;
	}
	const tree: Node = {};
	const put = (key: string, value: Node | AgentRecord | ConfigValue) => {
		const path = key.split(".");
		const leaf = path.pop() as string;
		let at = tree;
		for (const part of path) {
			at[part] ??= {};
			at = at[part] as Node;
		}
		at[leaf] = value;
	};
	for (const [key, value] of Object.entries(settings)) put(key, value);
	if (agents) put(AGENT_MODELS_KEY, agents);
	const lines: string[] = [];
	const emit = (node: Node, depth: number) => {
		const pad = "  ".repeat(depth);
		for (const [key, value] of Object.entries(node)) {
			if (value instanceof Map) {
				lines.push(`${pad}${key}:`);
				for (const [agent, selector] of value) {
					lines.push(`${pad}  ${JSON.stringify(agent)}: ${JSON.stringify(selector)}`);
				}
			} else if (typeof value === "object") {
				lines.push(`${pad}${key}:`);
				emit(value, depth + 1);
			} else lines.push(`${pad}${key}: ${JSON.stringify(value)}`);
		}
	};
	emit(tree, 0);
	return lines;
}

/** Marks an overlay whose conversation is paused and may outlive its server: it is neither swept nor removed with its directory. */
const PARKED = ".parked";
/** Names the server (its pid) that took an overlay over from one that is gone: the directory is kept while that server runs. */
const ADOPTED = ".adopted";

/** One omp process's own overlay file. */
export class ProcessOverlay {
	/** The conversation is paused: see `park`. */
	private parked = false;
	/** This server took the overlay over from another: see `adopt`. */
	private adopted = false;

	constructor(
		readonly file: string,
		/** What the file says; null while it says nothing and omp's own settings decide. */
		public mode: ApprovalMode | null,
		private readonly reloadMs = OMP_RELOAD_MS,
		/**
		 * What the file says of `retry.waitForUsageReset`, omp's own switch for sleeping through a provider's usage
		 * limit instead of failing the turn; null while omp's settings decide. It is read at each retry, so a change
		 * applies to the next limit, not to a wait already under way.
		 */
		public wait: boolean | null = null,
		/**
		 * The models the conversation was switched to, which hold for this process only (its subagents resolve their
		 * roles from them); null while it follows the global config. Never written to omp's own files.
		 */
		public models: ConversationModels | null = null,
		/** What `models` clears of the configuration's roles (see `modelLines`). */
		public absent: readonly string[] = [],
		/** Settings this process holds at the value it had, whatever the global config says (see `pin`). */
		public pins: Readonly<Record<string, ConfigValue>> = {},
		/** The policies of this conversation's own tools, besides `ALWAYS_ALLOWED_TOOLS` (see `ToolPolicies`). */
		private readonly policies: ToolPolicies = NO_TOOL_POLICIES,
		/**
		 * How long omp gives an extension's `tool_call` handler, in ms (`extensionHandlers.toolCallTimeoutMs`); null: omp's own
		 * 30 s. The gate asks a reviewer model inside it (see `GATE_HANDLER_MS`).
		 */
		private readonly handlerMs: number | null = null,
		/** What `models`' subagent models clear of the configuration's `task.agentModelOverrides` (see `modelLines`). */
		public absentAgents: readonly string[] = [],
		/**
		 * Where this conversation compacts (see `shared/compact-at.ts`): held by this process's own overlay, over omp's
		 * configuration; null while omp's own default decides. omp reads it whenever it checks whether to compact, so a change
		 * applies from the conversation's next turn.
		 */
		public compact: CompactAt | null = null,
	) {
		this.write();
	}

	/**
	 * The settings this overlay holds the process at, by omp's dotted key: what `pin` holds, what `retry.waitForUsageReset`
	 * says where the conversation chose it, and the compaction point where the conversation has one. The file says exactly
	 * this, and the server holds it in memory, so what the process is held at never has to be read back from a file that
	 * may have been taken away.
	 */
	get settings(): Readonly<Record<string, ConfigValue>> {
		return {
			...this.pins,
			...(this.wait === null ? {} : { "retry.waitForUsageReset": this.wait }),
			...(this.compact === null ? {} : compactAtWrites(this.compact)),
		};
	}

	/** Replace the file in one step, so omp never reads half of it. */
	private write(): void {
		const lines = [
			"# Generated by omp-webui for one conversation; omp reloads it when it changes.",
			"tools:",
			"  approval:",
			...[...ALWAYS_ALLOWED_TOOLS, ...this.policies.allow].map((tool) => `    ${tool}: allow`),
			...this.policies.prompt.map((tool) => `    ${tool}: prompt`),
			...(this.mode ? [`  approvalMode: ${this.mode}`] : []),
			...(this.handlerMs === null ? [] : ["extensionHandlers:", `  toolCallTimeoutMs: ${this.handlerMs}`]),
			...settingLines(this.settings, agentModels(this.models, this.absentAgents)),
			...(this.models ? modelLines(this.models, this.absent) : []),
			"",
		];
		// The directory may be gone (a cleaner of the temp dir, another server's sweep): omp still reads the file where
		// it was told to, and a directory made again has none of what kept the old one.
		const made = mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
		writeFileSync(`${this.file}.tmp`, lines.join("\n"), { mode: 0o600 });
		renameSync(`${this.file}.tmp`, this.file);
		if (made !== undefined) this.mark();
	}

	/**
	 * Say `mode` from now on (null: say nothing, and omp's own settings decide). The file changes at once; omp reloads
	 * it a moment later, and the promise resolves once it has had that moment.
	 */
	set(mode: ApprovalMode | null): Promise<void> {
		this.mode = mode;
		this.write();
		return Bun.sleep(this.reloadMs);
	}

	/** Say `on` for `retry.waitForUsageReset` from now on (null: omp's own setting again); resolves as `set` does. */
	setWait(on: boolean | null): Promise<void> {
		this.wait = on;
		this.write();
		return Bun.sleep(this.reloadMs);
	}

	/**
	 * Run on `models` from now on (null: the global config again), with `absent` cleared of the configuration's roles. The
	 * file changes at once; omp reloads it a moment later, and the promise resolves once it has had that moment.
	 */
	setModels(
		models: ConversationModels | null,
		absent: readonly string[],
		absentAgents: readonly string[] = [],
	): Promise<void> {
		this.models = models;
		this.absent = absent;
		this.absentAgents = absentAgents;
		this.write();
		return Bun.sleep(this.reloadMs);
	}

	/**
	 * Hold `values` (omp setting → value) for this process from now on, whatever the global config is changed to, except
	 * what it holds already: a value held earlier is the one this process has had since, not the one the config has
	 * now. A value the process was given of its own (omp's RPC `set_*`) stays on top of these. The file changes at
	 * once; omp reloads it a moment later, and the promise resolves once it has had that moment.
	 */
	pin(values: Readonly<Record<string, ConfigValue>>): Promise<void> {
		const fresh = Object.entries(values).filter(([key]) => !Object.hasOwn(this.pins, key));
		if (fresh.length === 0) return Promise.resolve();
		this.pins = { ...this.pins, ...Object.fromEntries(fresh) };
		this.write();
		return Bun.sleep(this.reloadMs);
	}

	/** Where this conversation compacts becomes `at` (null: omp's own configuration again); resolves as `set` does. */
	setCompact(at: CompactAt | null): Promise<void> {
		this.compact = at;
		this.write();
		return Bun.sleep(this.reloadMs);
	}

	/** Write the markers this overlay is owed. */
	private mark(): void {
		mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
		if (this.parked) writeFileSync(`${this.file}${PARKED}`, "");
		if (this.adopted) writeFileSync(`${this.file}${ADOPTED}`, String(process.pid));
	}

	/**
	 * The conversation is paused and may outlive this server: omp reads this file when it runs again, so it must
	 * outlive the server too. A directory holding a parked overlay is not removed at exit, and a later server does not
	 * sweep it as long as the paused conversation is on record and running (see `inUse`).
	 */
	park(): void {
		this.parked = true;
		this.mark();
	}

	unpark(): void {
		this.parked = false;
		rmSync(`${this.file}${PARKED}`, { force: true });
	}

	/**
	 * This server took the overlay over from one that is gone, and the directory is that server's: it is not another
	 * server's to sweep while this one runs, whether or not the conversation is paused, until the overlay is removed.
	 */
	adopt(): void {
		this.adopted = true;
		this.mark();
	}

	remove(): void {
		removeOverlayFiles(this.file);
	}
}

/** The overlay file at `file` and what belongs to it, and the directory they were in when nothing else is. */
export function removeOverlayFiles(file: string): void {
	for (const f of [
		file,
		`${file}.tmp`,
		`${file}${PARKED}`,
		`${file}${ADOPTED}`,
		`${file}${RISK_SUFFIX}`,
		`${file}${RISK_SUFFIX}.tmp`,
		`${file}${RISK_LOADED_SUFFIX}`,
		// The model guidance's text and the note its extension leaves live beside the overlay and go with it (`guidanceFileFor`).
		`${file}${GUIDANCE_SUFFIX}`,
		`${file}${GUIDANCE_SUFFIX}.tmp`,
		`${file}${GUIDANCE_SUFFIX}${GUIDANCE_LOADED_SUFFIX}`,
		// So do unattended mode's instruction and the note its extension leaves (`UnattendedService.fileFor`).
		`${file}${UNATTENDED_SUFFIX}`,
		`${file}${UNATTENDED_SUFFIX}.tmp`,
		`${file}${UNATTENDED_SUFFIX}${UNATTENDED_LOADED_SUFFIX}`,
		// And the quota floor's hold and the note its extension leaves (`QuotaFloorService.fileFor`).
		`${file}${QUOTA_SUFFIX}`,
		`${file}${QUOTA_SUFFIX}.tmp`,
		`${file}${QUOTA_SUFFIX}${QUOTA_LOADED_SUFFIX}`,
		// And the one that asks it to hold a step boundary for a compact (`CompactStepService.fileFor`).
		`${file}${COMPACT_STEP_SUFFIX}`,
		`${file}${COMPACT_STEP_SUFFIX}.tmp`,
		`${file}${COMPACT_STEP_SUFFIX}${COMPACT_STEP_LOADED_SUFFIX}`,
	])
		rmSync(f, { force: true });
	try {
		const dir = dirname(file);
		if (readdirSync(dir).length === 0) rmdirSync(dir);
	} catch {
		// gone, or in use by another overlay
	}
}

/** The process `pid` exists. EPERM means it does, owned by someone else; ESRCH, that there is no such process. */
function alive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Whether something in `dir` outlives the server whose directory it is: the overlay of a paused conversation, which
 * may outlive every server, or one that a server which still runs took over from a server that is gone.
 *
 * A `.parked` marker is no more than a marker: the conversation may have ended without removing it (omp killed, the
 * machine restarted, the server killed between parking and discarding). `parkedAlive` says whether the overlay still has
 * a paused conversation behind it; null for a server's own directory, where the markers are its own to trust.
 */
function inUse(dir: string, parkedAlive: ((overlay: string) => boolean) | null): boolean {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return false;
	}
	return names.some((name) => {
		if (name.endsWith(PARKED)) return parkedAlive === null || parkedAlive(join(dir, name.slice(0, -PARKED.length)));
		if (!name.endsWith(ADOPTED)) return false;
		try {
			return alive(Number(readFileSync(join(dir, name), "utf8")));
		} catch {
			return false;
		}
	});
}

/** Conversations whose mode the user chose, kept; the oldest go first. */
const MAX_REMEMBERED = 500;

interface Prefs {
	/** The user's default for new conversations; null: whatever omp's settings say. */
	default: ApprovalMode | null;
	/** The mode the user picked for a conversation, by session file. */
	sessions: Record<string, ApprovalMode>;
	/** Whether a conversation waits out its provider's usage limit, where the user chose differently from omp's own setting; by session file. */
	usageWait: Record<string, boolean>;
	/** The preset a conversation was switched to, by session file (see `ConversationModels`). */
	models: Record<string, ConversationModels>;
	/** Where a conversation compacts, where that is its own point (see `shared/compact-at.ts`); by session file. */
	compact: Record<string, CompactAt>;
	/** The mode (Full or Light) a conversation last ran in, by session file: what it is reopened in (see `LivePool.resume`). */
	launch: Record<string, Mode>;
	/** What a conversation chose of "Guard dangerous commands" over the global settings is the server's own (see `ApprovalStore.guardMap`). */
	guard?: never;
}

/**
 * The overlay files of the paused conversations on record in `dataDir` that something will run on again: those whose omp
 * and relay still run as recorded, which is what a server needs to take a conversation over (`LivePool.adopt`). One
 * listing answers for all of them, and the server serves others while it is awaited.
 */
async function runningParkedOverlays(dataDir: string): Promise<Set<string>> {
	const records = new ParkedStore(dataDir).list().filter((r) => r.overlay);
	const running = await identitiesOf(records.flatMap((r) => [r.relay.pid, r.omp.pid]));
	const files = new Set<string>();
	for (const r of records) {
		if (r.overlay && running.get(r.relay.pid) === r.relay.identity && running.get(r.omp.pid) === r.omp.identity)
			files.add(r.overlay.file);
	}
	return files;
}

/**
 * The directory this server's overlays live in. A dead server's directory is cleaned up by the next one, unless it still
 * holds something that outlives that server (see `inUse`), and likewise this server's, when it ends.
 */
async function overlayDir(dataDir: string): Promise<string> {
	const prefix = "ompw-live-";
	const running = await runningParkedOverlays(dataDir);
	for (const name of readdirSync(tmpdir())) {
		const pid = new RegExp(`^${prefix}(\\d+)-`).exec(name)?.[1];
		if (!pid || inUse(join(tmpdir(), name), (overlay) => running.has(overlay))) continue;
		if (!alive(Number(pid))) removeStale(join(tmpdir(), name));
	}
	const dir = mkdtempSync(join(tmpdir(), `${prefix}${process.pid}-`));
	process.once("exit", () => {
		if (!inUse(dir, null)) removeStale(dir);
	});
	return dir;
}

/**
 * Remove an overlay directory nobody uses. One this user cannot remove (a mode-000 directory, one another user made,
 * as on a shared /tmp) is left where it is, with a note: it must not stop a conversation from starting.
 */
function removeStale(dir: string): void {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch (e) {
		console.warn(`omp-webui: could not remove ${dir}: ${(e as Error).message}`);
	}
}

/**
 * Approval modes for the web UI: the user's choices (kept in the data dir, never in omp's files) and the
 * per-process overlays that put them in force.
 */
export class ApprovalStore {
	private readonly prefsFile: string;
	/** What each conversation chose of the guard, by session file: the server's memory is the truth, the file keeps it (see `verify`). */
	private guardMap: Map<string, KeptGuard>;
	/** How the file looked when this server last wrote it, or found it (see `look`). */
	private stamp = "";
	/** The last write of the guard map by `verify` failed and was said: it is said again only after one succeeds. */
	private unwritable = false;
	/** The directory this server's overlays live in, made (and the directories of dead servers cleaned up) by the first overlay. */
	private dir: Promise<string> | null = null;
	/** What the overlays of the processes that start from now on say of the time a `tool_call` handler is given (see `ProcessOverlay`). */
	handlerMs: number | null = null;

	constructor(
		private ompBin: string,
		private readonly dataDir: string,
		/** How long a changed overlay is given to take effect before the change counts as in force. */
		private readonly reloadMs = OMP_RELOAD_MS,
	) {
		this.prefsFile = join(dataDir, "approval.json");
		// What the file says of the guard when the server starts is what it holds from then on.
		this.guardMap = this.guardOfFile();
		this.stamp = this.look();
	}

	/** omp is somewhere else now (it was installed while the server ran). */
	setBin(bin: string): void {
		this.ompBin = bin;
	}

	private read(): Omit<Prefs, "guard"> {
		try {
			const v = JSON.parse(readFileSync(this.prefsFile, "utf8")) as Partial<Prefs>;
			const sessions: Record<string, ApprovalMode> = {};
			for (const [file, mode] of Object.entries(v.sessions ?? {})) if (isApprovalMode(mode)) sessions[file] = mode;
			const usageWait: Record<string, boolean> = {};
			for (const [file, on] of Object.entries(v.usageWait ?? {})) if (typeof on === "boolean") usageWait[file] = on;
			const models: Record<string, ConversationModels> = {};
			for (const [file, raw] of Object.entries(v.models ?? {})) {
				const parsed = parseConversationModels(raw);
				if (parsed) models[file] = parsed;
			}
			const compact: Record<string, CompactAt> = {};
			for (const [file, raw] of Object.entries(v.compact ?? {})) {
				const parsed = compactAtOf(raw);
				if (parsed) compact[file] = parsed;
			}
			const launch: Record<string, Mode> = {};
			for (const [file, mode] of Object.entries(v.launch ?? {})) if (isMode(mode)) launch[file] = mode;
			return { default: isApprovalMode(v.default) ? v.default : null, sessions, usageWait, models, compact, launch };
		} catch {
			return { default: null, sessions: {}, usageWait: {}, models: {}, compact: {}, launch: {} };
		}
	}

	private save(prefs: Omit<Prefs, "guard">): void {
		// A name of its own: two servers on one data folder (not supported) must not write into each other's temp file.
		const tmp = `${this.prefsFile}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify({ ...prefs, guard: this.guardJson(this.guardMap) }), { mode: 0o600 });
		renameSync(tmp, this.prefsFile);
		this.stamp = this.look();
	}

	/**
	 * How the file looks: its inode, size and times, "" for none. A file written or replaced by anyone else looks different
	 * (its change time moves with any change, which a program cannot set back), so only a changed one is read.
	 */
	private look(): string {
		try {
			const st = statSync(this.prefsFile);
			return `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
		} catch {
			return "";
		}
	}

	/** The user's default for new conversations; null: omp's own setting. */
	defaultMode(): ApprovalMode | null {
		return this.read().default;
	}

	setDefault(mode: ApprovalMode | null): void {
		this.save({ ...this.read(), default: mode });
	}

	/** The mode the user last picked for this conversation, if they did. */
	sessionMode(file: string): ApprovalMode | null {
		return this.read().sessions[file] ?? null;
	}

	rememberSession(file: string, mode: ApprovalMode): void {
		const prefs = this.read();
		// Re-adding moves the conversation to the end, so the ones dropped past the limit are the longest untouched.
		delete prefs.sessions[file];
		prefs.sessions[file] = mode;
		for (const old of Object.keys(prefs.sessions).slice(0, -MAX_REMEMBERED)) delete prefs.sessions[old];
		this.save(prefs);
	}

	/** Whether the user chose for this conversation to wait out usage limits (true) or not to (false); null: omp's own setting. */
	sessionUsageWait(file: string): boolean | null {
		return this.read().usageWait[file] ?? null;
	}

	/** `on` null: the conversation follows omp's own setting again. */
	rememberUsageWait(file: string, on: boolean | null): void {
		const prefs = this.read();
		delete prefs.usageWait[file];
		if (on !== null) {
			prefs.usageWait[file] = on;
			for (const old of Object.keys(prefs.usageWait).slice(0, -MAX_REMEMBERED)) delete prefs.usageWait[old];
		}
		this.save(prefs);
	}

	/** Where the conversation in `file` compacts, if that is its own point; null: it follows omp's configuration. */
	sessionCompact(file: string): CompactAt | null {
		return this.read().compact[file] ?? null;
	}

	/** `at` null: the conversation follows omp's configuration again. */
	rememberCompact(file: string, at: CompactAt | null): void {
		const prefs = this.read();
		delete prefs.compact[file];
		if (at !== null) {
			prefs.compact[file] = at;
			for (const old of Object.keys(prefs.compact).slice(0, -MAX_REMEMBERED)) delete prefs.compact[old];
		}
		this.save(prefs);
	}

	/** The mode this conversation last ran in, if the server kept one; null: it follows the default for new conversations. */
	sessionLaunchMode(file: string): Mode | null {
		return this.read().launch[file] ?? null;
	}

	rememberLaunchMode(file: string, mode: Mode): void {
		const prefs = this.read();
		// Re-adding moves the conversation to the end, so the ones dropped past the limit are the longest untouched.
		delete prefs.launch[file];
		prefs.launch[file] = mode;
		for (const old of Object.keys(prefs.launch).slice(0, -MAX_REMEMBERED)) delete prefs.launch[old];
		this.save(prefs);
	}

	/** The preset this conversation was switched to, if it was; null: it follows the global config. */
	sessionModels(file: string): ConversationModels | null {
		return this.read().models[file] ?? null;
	}

	rememberModels(file: string, models: ConversationModels): void {
		const prefs = this.read();
		delete prefs.models[file];
		prefs.models[file] = models;
		for (const old of Object.keys(prefs.models).slice(0, -MAX_REMEMBERED)) delete prefs.models[old];
		this.save(prefs);
	}

	/**
	 * What this conversation chose of the guard over the global settings, if it did (none: it follows them), or that what was
	 * kept could not be read (`damaged`: read as the default at least, never Off). From the server's memory, not the file.
	 */
	sessionGuard(file: string): KeptGuard {
		return this.guardMap.get(file) ?? NO_GUARD;
	}

	/** `guard` null: the conversation follows the global settings again. */
	rememberGuard(file: string, guard: GuardOverride | null): void {
		this.guardMap.delete(file);
		if (guard !== null) {
			this.guardMap.set(file, { own: guard, damaged: false });
			for (const old of [...this.guardMap.keys()].slice(0, -MAX_REMEMBERED)) this.guardMap.delete(old);
		}
		this.save(this.read());
	}

	/** `kept` is what the conversation in `file` is under now, damage included: damage is written as damage. */
	rememberKept(file: string, kept: KeptGuard): void {
		if (!kept.damaged) {
			this.rememberGuard(file, kept.own);
			return;
		}
		this.guardMap.delete(file);
		this.guardMap.set(file, DAMAGED_GUARD);
		for (const old of [...this.guardMap.keys()].slice(0, -MAX_REMEMBERED)) this.guardMap.delete(old);
		this.save(this.read());
	}

	/** The guard map as it is written: damage as the word `"damaged"`. */
	private guardJson(map: ReadonlyMap<string, KeptGuard>): Record<string, unknown> {
		return Object.fromEntries([...map].map(([file, kept]) => [file, keptJson(kept)]));
	}

	/** The guard map the file holds, as the server would read it. */
	private guardOfFile(): Map<string, KeptGuard> {
		const map = new Map<string, KeptGuard>();
		try {
			const v: unknown = JSON.parse(readFileSync(this.prefsFile, "utf8"));
			const stored = typeof v === "object" && v !== null ? (v as { guard?: unknown }).guard : undefined;
			if (typeof stored === "object" && stored !== null && !Array.isArray(stored)) {
				for (const [file, raw] of Object.entries(stored)) {
					const kept = readKeptGuard(raw);
					if (kept.own || kept.damaged) map.set(file, kept);
				}
			}
		} catch {
			// No file, or one that cannot be read: it says nothing, and what the server holds is written again.
		}
		return map;
	}

	/**
	 * The file's guard map is not the server's to take from the file once it has started: what an agent plants there
	 * (an Off for a conversation) is written over with what the server holds, as `guard.json` is. True when it had to be.
	 * The file is read only when it is not as this server last left it (see `look`): once a second costs one `stat`.
	 * It never throws, for it runs in the server's once-a-second look and what else that does must go on: a write that cannot
	 * be made (a full disk, a data folder that is read only) is said once, and tried again at the next look.
	 */
	verify(): boolean {
		const stamp = this.look();
		if (stamp === this.stamp) return false;
		const same = (a: ReadonlyMap<string, KeptGuard>, b: ReadonlyMap<string, KeptGuard>) =>
			JSON.stringify(Object.entries(this.guardJson(a)).sort()) ===
			JSON.stringify(Object.entries(this.guardJson(b)).sort());
		if (same(this.guardOfFile(), this.guardMap)) {
			// Written with the same guard map (another section changed): not to be read again until it changes.
			this.stamp = stamp;
			return false;
		}
		try {
			this.save(this.read());
		} catch (e) {
			if (!this.unwritable) {
				this.unwritable = true;
				console.warn(
					`omp-webui: could not write the guard choices of the conversations again: ${(e as Error).message}`,
				);
			}
			return false;
		}
		this.unwritable = false;
		return true;
	}

	/**
	 * Take the guard map the file holds as the server's own. For a file the person put there on purpose, such as the data an
	 * import (Move to another computer) replaced: not for one an agent could have written, which `verify` writes over.
	 */
	reload(): void {
		this.guardMap = this.guardOfFile();
		this.stamp = this.look();
	}

	/** omp's own `retry.waitForUsageReset`, for showing what "follow omp" means. */
	configuredUsageWait(cwd?: string, env?: Record<string, string>): Promise<boolean | null> {
		return configuredUsageWait(this.ompBin, cwd, env);
	}

	/** Change omp's own `retry.waitForUsageReset`, the setting `omp config` shows and changes. */
	configureUsageWait(on: boolean): Promise<void> {
		return configureUsageWait(this.ompBin, on);
	}

	/** omp's own mode for `cwd`, for showing "same as omp" in the settings (see `configuredApprovalMode`). */
	configured(cwd?: string, env?: Record<string, string>): Promise<string | null> {
		return configuredApprovalMode(this.ompBin, cwd, env);
	}

	/**
	 * The mode a conversation starts in: the one asked for, the one the user picked for this conversation
	 * before, their default, and last what omp's settings give it in this folder. When that last is none of the modes
	 * the web UI can set (a newer omp's), `mode` is null, so that omp's own setting stays in force, and `omp` names it.
	 */
	async startingMode(
		cwd: string,
		sessionFile: string | null,
		requested?: ApprovalMode,
		env?: Record<string, string>,
	): Promise<{ mode: ApprovalMode | null; omp: string | null }> {
		const prefs = this.read();
		const chosen = requested ?? (sessionFile ? prefs.sessions[sessionFile] : undefined) ?? prefs.default;
		if (chosen) return { mode: chosen, omp: null };
		const own = await this.configured(cwd, env);
		return isApprovalMode(own) ? { mode: own, omp: null } : { mode: null, omp: own };
	}

	/** The overlay for a new process. */
	async create(
		liveId: string,
		mode: ApprovalMode | null,
		wait: boolean | null = null,
		models: ConversationModels | null = null,
		absent: readonly string[] = [],
		/** The policies of this conversation's own tools (see `ToolPolicies`). */
		policies: ToolPolicies = NO_TOOL_POLICIES,
		absentAgents: readonly string[] = [],
		/** Where the conversation compacts, as it chose before (see `sessionCompact`). */
		compact: CompactAt | null = null,
	): Promise<ProcessOverlay> {
		this.dir ??= overlayDir(this.dataDir).catch((e: unknown) => {
			// The next overlay tries again.
			this.dir = null;
			throw e;
		});
		return new ProcessOverlay(
			join(await this.dir, `${liveId}.yml`),
			mode,
			this.reloadMs,
			wait,
			models,
			absent,
			{},
			policies,
			this.handlerMs,
			absentAgents,
			compact,
		);
	}

	/**
	 * The overlay of a conversation a former server left paused. omp was told where its file is; whatever has become
	 * of the file (a cleaned temp directory) is made good, with what the conversation was set to.
	 */
	restore(
		file: string,
		mode: ApprovalMode | null,
		wait: boolean | null = null,
		models: ConversationModels | null = null,
		absent: readonly string[] = [],
		pins: Readonly<Record<string, ConfigValue>> = {},
		absentAgents: readonly string[] = [],
		compact: CompactAt | null = null,
	): ProcessOverlay {
		const overlay = new ProcessOverlay(
			file,
			mode,
			this.reloadMs,
			wait,
			models,
			absent,
			pins,
			NO_TOOL_POLICIES,
			this.handlerMs,
			absentAgents,
			compact,
		);
		overlay.park();
		overlay.adopt();
		return overlay;
	}
}
