import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { advisorOf } from "../../shared/advisor.ts";
import { type ApprovalMode, isApprovalMode } from "../../shared/approval.ts";
import { type CompactAt, compactAtOf } from "../../shared/compact-at.ts";
import { type CompactQueueRecord, compactQueueRecordOf } from "../../shared/compact-queue.ts";
import { type Goal, heldGoal } from "../../shared/goal.ts";
import { type GuardOverride, readKeptGuard } from "../../shared/guard.ts";
import { isRecord } from "../../shared/guards.ts";
import type { ConversationModels } from "../../shared/model-config.ts";
import { isLightModels, isMode, type LightModels, type Mode } from "../../shared/offline.ts";
import { type PanelState, panelStateOf } from "../../shared/panel-state.ts";
import type { LiveRetry, OmpFrame } from "../../shared/protocol.ts";
import { warmVerdictOf } from "../../shared/quota-hold.ts";
import {
	type ConfigValue,
	SESSION_DEFAULT_KEYS,
	type SessionSettings,
	sessionSettingsOf,
} from "../../shared/session-defaults.ts";
import { concurrencyOf } from "../../shared/subagent-concurrency.ts";
import { type Platform, platform } from "../platform/index.ts";
import type { QuotaHold } from "./quota-floor/decide.ts";
import type { QuotaRecord } from "./quota-floor/tracker.ts";

/**
 * Conversations that outlive the server. A paused conversation's omp is frozen (SIGSTOP) behind a relay (relay.ts)
 * that holds its pipes, and one that waits out a provider's usage limit keeps running behind it, its own timer going
 * (`Live.kept`), so quitting the app need not end either: the server writes down what it knows about the conversation
 * here, leaves relay and omp running, and the next server on the same data dir adopts them again (`LivePool.adopt`)
 * and finds the conversation as it was.
 *
 * One file per conversation, `<dataDir>/parked/<liveId>.json`, written when the conversation is paused or begins to
 * wait and whenever it changes meanwhile, so that even a server that is killed leaves a record that can be adopted.
 */

/** A process as it was when it was recorded: its id, and what makes that id still the same process (`Platform.proc.identity`). */
export interface ProcessRef {
	pid: number;
	identity: string;
}

export interface ParkedRecord {
	/** 2 since Full and Light (a record of version 1 names its mode `online` or `offline`: see `modeOf`). An older server leaves a newer record alone. */
	version: 1 | 2;
	liveId: string;
	/** omp, and the relay that holds its pipes. */
	omp: ProcessRef;
	relay: ProcessRef;
	/** The relay's unix socket. */
	socket: string;
	/** The server that holds the conversation now; null once it has let go (it is leaving). Another server never adopts a held one. */
	owner: ProcessRef | null;
	cwd: string;
	/** `LiveInfo.args`: omp's command line without this process's own overlay. */
	args: string[];
	/** The flags the user chose for the conversation, without the server's own (`Live.ownArgs`); absent in a record an older server wrote. */
	ownArgs?: string[];
	/** What the process added to its environment (Light mode's agent directory). */
	env: Record<string, string>;
	mode: Mode;
	/** What a Light process's models are; absent in Full, and read as `local` from a record an older server wrote of Offline (see `modeOf`). */
	lightModels?: LightModels;
	startedAt: number;
	/** When the conversation was paused (omp frozen); null: it is not, it waits out a usage limit (`retry`) and runs. */
	pausedAt: number | null;
	sessionFile: string | null;
	sessionId: string | null;
	/** A turn was in progress when the conversation was paused. */
	streaming: boolean;
	/**
	 * This process's own overlay (approval mode, what it says of `retry.waitForUsageReset`, and the models the conversation
	 * was switched to with what they clear: absent in a record an older server wrote, like null); null where modes are not
	 * managed.
	 */
	overlay: {
		file: string;
		mode: ApprovalMode | null;
		wait?: boolean | null;
		models?: ConversationModels | null;
		absent?: string[];
		/** The agents `models`' subagent models clear of the configuration's (`ProcessOverlay.absentAgents`): absent in a record an older server wrote, like none. */
		absentAgents?: string[];
		/** The settings this process holds at the value it had (`ProcessOverlay.pin`): absent in a record an older server wrote, like none. */
		pins?: Record<string, ConfigValue>;
		/** Where the conversation compacts (`ProcessOverlay.compact`): absent in a record an older server wrote, and while omp's default decides. */
		compact?: CompactAt | null;
		/** How many subagents the conversation runs at once (`ProcessOverlay.concurrency`): absent in a record an older server wrote, and while omp's configuration decides. */
		concurrency?: number | null;
		/** Whether the advisor reviews the conversation (`ProcessOverlay.advisor`): absent in a record an older server wrote, and while omp's configuration decides. */
		advisor?: boolean | null;
		/** The conversation's browser endpoint (`ProcessOverlay.browser`): absent in a record an older server wrote, like none. */
		browserCdpUrl?: string | null;
	} | null;
	/**
	 * What the process was told of the controls omp cannot report (`LiveInfo.sessionSettings`): it keeps them while it is
	 * frozen, and the next server cannot ask it. Absent in a record an older server wrote, like none.
	 */
	sessionSettings?: SessionSettings;
	/**
	 * What omp reported of the panel's settings when the conversation was paused, kept true to what changed meanwhile
	 * (`Live.askState`, `Live.noteSettingChange`): the next server cannot ask a frozen omp, and without it a page would show the session panel
	 * with no row chosen. Only for a paused conversation; absent in a record an older server wrote, and when omp had said
	 * nothing.
	 */
	state?: PanelState;
	/** omp holds the guided-goal tool: the conversation is in an interview. */
	interviewing: boolean;
	/** Dialogs omp is still waiting on, which no later frame repeats. */
	pendingUI: OmpFrame[];
	/**
	 * omp was backing off before a retry of its own (`LiveInfo.retry`): without it the next server would show no wait,
	 * and Retry now would not know there is a backoff to end. For a conversation that is not paused it is the reason
	 * the record exists: a usage-limit wait that has not started its turn. Absent in a record an older server wrote, and
	 * when there was none.
	 */
	retry?: LiveRetry;
	/**
	 * The goal omp held when the conversation was paused, or last changed while it was (`Live.goal`): the next server
	 * cannot ask a frozen omp, and without it a page would show the goal from the transcript, where an active goal
	 * reads as paused. Absent in a record an older server wrote, and when there was none.
	 */
	goal?: Goal;
	/**
	 * omp's registry of its subagents (`get_subagents`) as it was when the conversation was paused (`Live.subagents`): the
	 * next server cannot ask a frozen omp, and without it a page would find the subagents that were running in the
	 * transcripts on disk only, where all of them are over. Absent in a record an older server wrote, and when it was
	 * not paused.
	 */
	subagents?: Record<string, unknown>[];
	/**
	 * The gate of "Guard dangerous commands" had said it started in the process when this was written (`Live.gated`): the
	 * next server takes that over, so that an adopted process that has the gate is not taken for one without (the note it
	 * left is beside the overlay, but a cleaner of the temp folder may have taken it). Absent in a record an older server
	 * wrote, like false; the note beside the overlay is looked for then.
	 */
	gated?: boolean;
	/**
	 * What the conversation chose of "Guard dangerous commands" over the global settings (`Live.guardOverride`): the server
	 * that takes the process over tells its gate the same. Absent in a record an older server wrote, and when the
	 * conversation follows the global settings; a damaged one is read as absent, never as off.
	 */
	guard?: GuardOverride;
	/** What was recorded of the conversation's guard could not be read: the next server takes it as damage (see `readKeptGuard`), never as Off. */
	guardDamaged?: true;
	/**
	 * The quota floor's hold when the conversation was recorded (`QuotaTracker.record`): a conversation that is held at its provider's
	 * floor waits in a dialog that only the hold file ends, and the next server must know it is held, and why. Absent in a record an
	 * older server wrote, and while there is no hold.
	 */
	quota?: QuotaRecord;
	/**
	 * What omp had started when it was frozen. Its tool processes run in sessions of their own, out of reach of omp's
	 * process group: these are what is ended, as the recorded processes they still are, if omp is gone.
	 */
	descendants: ProcessRef[];
	/**
	 * A compact asked for while the agent worked, with the follow-ups held behind it (`Live.compactQueue`): a paused
	 * conversation's server holds it, and the next one must too, or the messages held for it would be lost. Absent in a
	 * record an older server wrote, and when none waits (a compact that already runs is not kept).
	 */
	compactQueue?: CompactQueueRecord;
}

/** The process is running, and is the one that was recorded (its pid was not reused; see `Platform.proc.identity`). */
export async function runsAs(ref: ProcessRef, system: Platform = platform): Promise<boolean> {
	return (await system.proc.identity(ref.pid)) === ref.identity;
}

/**
 * How often, and how far apart, a Linux process without a command line is read again before it is named by its own
 * name: one caught inside `execve` has its new name but not yet its command line, which it has a moment later.
 */
const EXEC_READS = 20;
const EXEC_READ_MS = 5;

/**
 * The process named `ref`, or null when it is not running. One just started may still be inside `execve` (Linux: its
 * new name, no command line yet): the name it is recorded by is the one it keeps, so it is read again until it has its
 * command line, or is a process that has none (a kernel thread, one that is ending).
 */
export async function referenceTo(pid: number | null, system: Platform = platform): Promise<ProcessRef | null> {
	if (pid === null) return null;
	let identity = await system.proc.identity(pid);
	// Only Linux's identity (`linux:<boot>:<start> [name]`) names a process by its own name.
	for (let read = 1; read < EXEC_READS && identity !== null && /^linux:\S* \[[^\]]*\]$/.test(identity); read++) {
		await Bun.sleep(EXEC_READ_MS);
		identity = await system.proc.identity(pid);
	}
	return identity !== null ? { pid, identity } : null;
}

function isRef(v: unknown): v is ProcessRef {
	return isRecord(v) && Number.isInteger(v.pid) && typeof v.identity === "string";
}

const isCount = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

/** What a record says of omp's backoff: a wait with all of its parts, else nothing (a damaged one is left out, not the conversation). */
function retryOf(v: unknown): LiveRetry | undefined {
	if (!isRecord(v)) return undefined;
	const { attempt, maxAttempts, delayMs, startedAt, usageLimit, resumed } = v;
	if (!isCount(attempt) || !isCount(maxAttempts) || !isCount(delayMs) || !isCount(startedAt)) return undefined;
	if (typeof usageLimit !== "boolean" || typeof resumed !== "boolean") return undefined;
	return { attempt, maxAttempts, delayMs, startedAt, usageLimit, resumed };
}

const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === "string");

/**
 * What a record says of a quota hold (`QuotaRecord`): all of its parts, else nothing (a damaged one costs the conversation its
 * hold, which the next look at the quota makes again, not its record).
 */
function quotaOf(v: unknown): QuotaRecord | undefined {
	if (!isRecord(v)) return undefined;
	const { hold, override, held, dialogs, verdict, refreshes, spent } = v;
	if (typeof override !== "boolean" || typeof held !== "boolean" || !isStrings(dialogs)) return undefined;
	if (!isCount(refreshes) || !isCount(spent)) return undefined;
	let kept: QuotaHold | null = null;
	if (hold !== null) {
		if (!isRecord(hold) || typeof hold.provider !== "string") return undefined;
		const { floor, remaining, window, resetsAt, since } = hold;
		if (!isCount(floor) || !isCount(remaining) || !isCount(since)) return undefined;
		if (window !== null && typeof window !== "string") return undefined;
		if (resetsAt !== null && !isCount(resetsAt)) return undefined;
		kept = { provider: hold.provider, floor, remaining, window, resetsAt, since };
	}
	return {
		hold: kept,
		override,
		held,
		dialogs,
		verdict: warmVerdictOf(verdict),
		refreshes,
		spent,
	};
}

/** What a record says of the settings its process holds (`ProcessOverlay.pin`): the ones a default can write; a damaged entry is left out, not the record. */
function pinsOf(v: unknown): Record<string, ConfigValue> {
	if (!isRecord(v)) return {};
	return Object.fromEntries(
		Object.entries(v).filter(
			(entry): entry is [string, ConfigValue] =>
				Object.hasOwn(SESSION_DEFAULT_KEYS, entry[0]) &&
				(typeof entry[1] === "string" || typeof entry[1] === "boolean" || typeof entry[1] === "number"),
		),
	);
}

/**
 * The mode a record names, with Light's models. A record an older server wrote says `online` or `offline`, the modes
 * before Full and Light: a paused conversation outlives the server's update, so these are read as what they were (Online
 * was Full; Offline was Light on a local server's models). Null when it names no mode.
 */
function modeOf(v: Record<string, unknown>): { mode: Mode; lightModels?: LightModels } | null {
	if (v.mode === "online") return { mode: "full" };
	if (v.mode === "offline") return { mode: "light", lightModels: "local" };
	if (!isMode(v.mode)) return null;
	if (v.mode === "full") return { mode: "full" };
	return { mode: "light", lightModels: isLightModels(v.lightModels) ? v.lightModels : "yours" };
}

/**
 * A record read from disk; "other" for one a different version of the server wrote (an older one must not delete what
 * a newer one will take over), null when it is not a record at all.
 */
function parse(text: string): ParkedRecord | "other" | null {
	let v: unknown;
	try {
		v = JSON.parse(text);
	} catch {
		return null;
	}
	if (isRecord(v) && typeof v.version === "number" && v.version !== 1 && v.version !== 2) return "other";
	if (!isRecord(v) || (v.version !== 1 && v.version !== 2)) return null;
	const overlay = v.overlay;
	const ok =
		typeof v.liveId === "string" &&
		isRef(v.omp) &&
		isRef(v.relay) &&
		typeof v.socket === "string" &&
		(v.owner === null || isRef(v.owner)) &&
		typeof v.cwd === "string" &&
		isStrings(v.args) &&
		isRecord(v.env) &&
		modeOf(v) !== null &&
		typeof v.startedAt === "number" &&
		(v.pausedAt === null || typeof v.pausedAt === "number") &&
		(v.sessionFile === null || typeof v.sessionFile === "string") &&
		(v.sessionId === null || typeof v.sessionId === "string") &&
		typeof v.streaming === "boolean" &&
		(overlay === null ||
			(isRecord(overlay) &&
				typeof overlay.file === "string" &&
				(overlay.mode === null || isApprovalMode(overlay.mode)) &&
				(overlay.wait === undefined || overlay.wait === null || typeof overlay.wait === "boolean") &&
				(overlay.absent === undefined || isStrings(overlay.absent)) &&
				(overlay.absentAgents === undefined || isStrings(overlay.absentAgents)))) &&
		typeof v.interviewing === "boolean" &&
		Array.isArray(v.pendingUI) &&
		(v.descendants === undefined || (Array.isArray(v.descendants) && v.descendants.every(isRef)));
	if (!ok) return null;
	// A record from before descendants were written down has none: nothing is known beyond omp's own process group.
	// A damaged `retry`, `goal`, session setting or overlay pin costs the conversation its wait, its goal or that one, not its record.
	return {
		...v,
		mode: modeOf(v)?.mode,
		lightModels: modeOf(v)?.lightModels,
		overlay: isRecord(overlay)
			? {
					...overlay,
					pins: pinsOf(overlay.pins),
					compact: compactAtOf(overlay.compact),
					concurrency: concurrencyOf(overlay.concurrency),
					advisor: advisorOf(overlay.advisor),
					browserCdpUrl: typeof overlay.browserCdpUrl === "string" ? overlay.browserCdpUrl : null,
				}
			: null,
		descendants: v.descendants ?? [],
		retry: retryOf(v.retry),
		goal: heldGoal(v.goal) ?? undefined,
		compactQueue: compactQueueRecordOf(v.compactQueue),
		subagents: Array.isArray(v.subagents) ? v.subagents.filter(isRecord) : undefined,
		sessionSettings: sessionSettingsOf(v.sessionSettings),
		state: panelStateOf(v.state),
		gated: v.gated === true ? true : undefined,
		guard: readKeptGuard(v.guard).own ?? undefined,
		guardDamaged: readKeptGuard(v.guard).damaged || v.guardDamaged === true ? true : undefined,
		quota: quotaOf(v.quota),
	} as unknown as ParkedRecord;
}

export class ParkedStore {
	private readonly dir: string;

	constructor(dataDir: string) {
		this.dir = join(dataDir, "parked");
	}

	private file(liveId: string): string {
		return join(this.dir, `${liveId}.json`);
	}

	save(record: ParkedRecord): void {
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		const file = this.file(record.liveId);
		writeFileSync(`${file}.tmp`, JSON.stringify(record), { mode: 0o600 });
		renameSync(`${file}.tmp`, file);
	}

	/** Whether the file of `liveId` holds exactly `text`: what a kept conversation's record is checked against once a second. */
	says(liveId: string, text: string): boolean {
		try {
			return readFileSync(this.file(liveId), "utf8") === text;
		} catch {
			return false;
		}
	}

	remove(liveId: string): void {
		rmSync(this.file(liveId), { force: true });
		rmSync(`${this.file(liveId)}.tmp`, { force: true });
	}

	/** Every conversation recorded, oldest first (by its pause, or its start when it was not paused). A file that is not a record is removed. */
	list(): ParkedRecord[] {
		let names: string[];
		try {
			names = readdirSync(this.dir);
		} catch {
			return [];
		}
		const records: ParkedRecord[] = [];
		for (const name of names) {
			if (!name.endsWith(".json")) continue;
			const path = join(this.dir, name);
			let record: ParkedRecord | "other" | null = null;
			try {
				record = parse(readFileSync(path, "utf8"));
			} catch {
				// unreadable: treated as not a record
			}
			if (record === "other") continue;
			if (record) records.push(record);
			else rmSync(path, { force: true });
		}
		return records.sort((a, b) => (a.pausedAt ?? a.startedAt) - (b.pausedAt ?? b.startedAt));
	}
}
