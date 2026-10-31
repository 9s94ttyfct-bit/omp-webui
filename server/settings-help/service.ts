import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../shared/guards.ts";
import type { LiveAttached } from "../../shared/protocol.ts";
import {
	classOf,
	type GrantEnd,
	SETTINGS_CHANGES_MAX,
	SETTINGS_CONFIRM_MS,
	SETTINGS_GRANT_MS,
	SETTINGS_LOG_MAX,
	SETTINGS_TOOL,
	type SettingsChange,
	type SettingsGrant,
	type SettingsGrantEnded,
	type SettingsHelpState,
	type SettingsRequest,
	sameValue,
} from "../../shared/settings-help.ts";
import type { HostToolCall, HostToolResult, HostToolServer } from "../omp/host-tools.ts";
import { type SettingsCatalog, SettingValueError } from "./catalog.ts";

/**
 * omp's tools that could change a setting without this tool — write the files the server keeps them in (`guard.json`,
 * `remote.json`, `ui-prefs.json`, …) or run something that does — asked about at every call in the dedicated conversation,
 * whatever its permission mode (`tools.approval.<tool>: prompt` in its overlay, which wins over Auto-approve): the agent has
 * no need of them there, and the person sees any attempt before it runs. A name omp does not have is a policy of nothing.
 */
export const SETTINGS_PROMPTED_TOOLS = [
	"bash",
	"edit",
	"write",
	"eval",
	"python",
	"notebook",
	"ast_edit",
	"lsp",
	"debug",
	"browser",
	"computer",
	"task",
] as const;

/**
 * "Ask agent for help" (Settings): a conversation of its own whose agent may read and change the app's settings with
 * `webui_settings` for a while.
 *
 * The tool is served over that conversation's own omp pipe (`Live.serveHostTools`, as Settings › Remote access › "Set up
 * with AI" serves its tools): no other conversation is told of it, and nothing is handed to omp to call the server with,
 * so no credential can reach the agent's commands, a tool's arguments or results, or the session file. What may use it is
 * a grant this server holds, bound to the conversation's live id and checked on every call:
 *
 * - it ends after `SETTINGS_GRANT_MS` (30 minutes), when the person presses Revoke now, and when the conversation's process
 *   ends (closed, stopped, the server restarted: a server holds no grant it did not make);
 * - a conversation a page that is not this computer's has touched is refused (that page could answer omp's prompts);
 * - a security-sensitive setting (`classOf`) is changed only after the person allowed that one change on a page of this
 *   computer (`answer`, over a local-only route); nobody answering within `SETTINGS_CONFIRM_MS` is a Deny.
 *
 * Every change is logged (`<data dir>/settings-help.json`: when, what, the value before and after, who let it through) and
 * can be undone from Settings, through the same validated setter (`SettingsCatalog`).
 */

/** What the service needs of the server. */
export interface SettingsHelpHooks {
	/** Start a conversation in `cwd` whose host tools `server` answers. */
	open(server: HostToolServer, cwd: string): Promise<LiveAttached>;
	/** Whether a page that is not this computer's has been on conversation `liveId`. */
	heldRemotely(liveId: string): boolean;
	/** Tell the pages on this computer what the state is now. */
	changed(state: SettingsHelpState): void;
}

/** Time, as the service reads it: a test moves it by hand. */
export interface Clock {
	now(): number;
	/** Run `fn` after `ms`; the answer cancels it. */
	after(ms: number, fn: () => void): () => void;
}

export const SYSTEM_CLOCK: Clock = {
	now: () => Date.now(),
	after(ms, fn) {
		const timer = setTimeout(fn, ms);
		timer.unref?.();
		return () => clearTimeout(timer);
	},
};

/** A refusal of the person's request (undo, answer), with the HTTP status the page is told. */
export class SettingsHelpError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

/** The most conversations whose ended access is remembered for their header. */
const ENDED_MAX = 50;

/** The tool, as omp is told of it. */
export const SETTINGS_TOOL_DEFINITION = {
	name: SETTINGS_TOOL,
	label: "omp-webui settings",
	description: `Read and change omp-webui's settings for the person (this conversation was started from Settings › Ask agent for help). \`get\`: every setting you can change (or the \`keys\` given), with its current value and its class. \`set\`: \`changes\`, a list of { key, value }. A \`normal\` setting is changed at once. A \`sensitive\` one (the guard, remote access, unattended mode, permission mode, updates, keeping the Mac awake, where Light sends conversations and what it may run, …) shows the person a card with the old and new value and waits for their Allow or Deny; a Deny or no answer leaves it as it was. Values are what the docs say (\`webui_docs\`: read the topic of a setting before changing it); a value or key the app refuses is refused whole, before anything changes. Access ends after 30 minutes or when the person revokes it; every change is logged in Settings, where the person can undo it. Change omp-webui's settings only with this tool, never by editing files in the app's data folder or by running commands: those skip the checks and the person's confirmation, and this conversation asks the person before every command or file write.`,
	parameters: {
		type: "object",
		properties: {
			action: { type: "string", enum: ["get", "set"], description: "`get` the settings, or `set` some of them." },
			keys: {
				type: "array",
				items: { type: "string" },
				description: "For `get`, optional: only these keys (e.g. `ompw.theme`, `guard.json:mode`).",
			},
			changes: {
				type: "array",
				maxItems: SETTINGS_CHANGES_MAX,
				items: {
					type: "object",
					properties: {
						key: { type: "string", description: "The setting's key, as `get` lists it." },
						value: { description: "The new value: a string, number, boolean, list, object, or null." },
					},
					required: ["key", "value"],
					additionalProperties: false,
				},
				description: "For `set`: the changes, each key at most once.",
			},
		},
		required: ["action"],
		additionalProperties: false,
	},
	// In the model's tool list from its first turn: the conversation exists for it.
	loadMode: "essential" as const,
};

interface Held {
	grant: SettingsGrant;
	cancel: () => void;
}

interface Waiting {
	request: SettingsRequest;
	settle: (allowed: boolean) => void;
}

/** What became of one asked change. */
interface Outcome {
	key: string;
	outcome: "applied" | "unchanged" | "denied" | "failed";
	old?: unknown;
	new?: unknown;
	message?: string;
}

const REFUSED_NOT_HELP =
	"This conversation was not started from Settings › Ask agent for help, so it cannot change settings. Tell the person to use that button.";

const ENDED_TEXT: Record<GrantEnd, string> = {
	expired:
		"Access to the settings has ended: it lasts 30 minutes. Nothing more can be changed from this conversation; tell the person that they can start a new one with Settings › Ask agent for help. Do not try another way.",
	revoked:
		"The person revoked this conversation's access to the settings. Nothing more can be changed from it; do not try another way.",
	ended: "This conversation's access to the settings has ended. Nothing more can be changed from it.",
};

export class SettingsHelp implements HostToolServer {
	readonly tools = [SETTINGS_TOOL_DEFINITION];
	/**
	 * omp does not prompt for the tool itself: the server asks the person about every sensitive change (the card), and the
	 * normal ones are the person's request to the agent. omp's own prompt in front of every change, a theme among them,
	 * would be a second question for what the person just asked for.
	 */
	readonly readOnly: readonly string[] = [SETTINGS_TOOL];
	readonly prompted: readonly string[] = SETTINGS_PROMPTED_TOOLS;

	private readonly grants = new Map<string, Held>();
	private readonly ends = new Map<string, SettingsGrantEnded>();
	private readonly waiting = new Map<string, Waiting>();
	private changes: SettingsChange[];
	private readonly logFile: string;
	private readonly grantMs: number;

	constructor(
		private readonly catalog: SettingsCatalog,
		private readonly places: { dataDir: string; folder: string },
		private readonly hooks: SettingsHelpHooks | null,
		private readonly clock: Clock = SYSTEM_CLOCK,
		/** How long an access lasts: `SETTINGS_GRANT_MS`, or less (a test's `OMP_WEBUI_SETTINGS_HELP_MS`); never more. */
		grantMs: number = SETTINGS_GRANT_MS,
	) {
		this.grantMs = Math.min(SETTINGS_GRANT_MS, Math.max(1000, grantMs));
		this.logFile = join(places.dataDir, "settings-help.json");
		this.changes = this.readLog();
	}

	// ------------------------------------------------------------------ state

	state(): SettingsHelpState {
		return {
			folder: this.places.folder,
			grants: [...this.grants.values()].map((h) => h.grant),
			ended: [...this.ends.values()],
			requests: [...this.waiting.values()].map((w) => w.request),
			changes: [...this.changes].reverse(),
		};
	}

	private changed(): void {
		this.hooks?.changed(this.state());
	}

	// ------------------------------------------------------------------ the conversation and its grant

	/** "Ask agent for help": a new conversation in the feature's own folder, holding the tool for `SETTINGS_GRANT_MS`. */
	async start(): Promise<LiveAttached> {
		if (!this.hooks) throw new SettingsHelpError("This server cannot start a conversation", 501);
		mkdirSync(this.places.folder, { recursive: true, mode: 0o700 });
		const info = await this.hooks.open(this, this.places.folder);
		this.grant(info.liveId);
		return info;
	}

	/** Conversation `liveId` may change settings from now for `grantMs` (30 minutes). */
	grant(liveId: string): SettingsGrant {
		this.grants.get(liveId)?.cancel();
		const startedAt = this.clock.now();
		const grant = { liveId, startedAt, expiresAt: startedAt + this.grantMs };
		const cancel = this.clock.after(this.grantMs, () => this.revoke(liveId, "expired"));
		this.grants.set(liveId, { grant, cancel });
		this.ends.delete(liveId);
		this.changed();
		return grant;
	}

	/** End `liveId`'s access: every change it waits on is denied. False when it had none. */
	revoke(liveId: string, reason: GrantEnd): boolean {
		const held = this.grants.get(liveId);
		if (!held) return false;
		held.cancel();
		this.grants.delete(liveId);
		for (const w of [...this.waiting.values()]) if (w.request.liveId === liveId) w.settle(false);
		this.ends.set(liveId, { liveId, reason, at: this.clock.now() });
		while (this.ends.size > ENDED_MAX) this.ends.delete(this.ends.keys().next().value as string);
		this.changed();
		return true;
	}

	/** The process ended (closed, stopped, the server going away): its access goes with it. */
	ended(liveId: string): void {
		this.revoke(liveId, "ended");
	}

	/** The grant of `liveId` while it holds; one past its time is ended here (a timer may be late, a clock moved). */
	private current(liveId: string): SettingsGrant | null {
		const held = this.grants.get(liveId);
		if (!held) return null;
		if (this.clock.now() >= held.grant.expiresAt) {
			this.revoke(liveId, "expired");
			return null;
		}
		return held.grant;
	}

	/** Why a call of `liveId` is refused now, or null when it may go on. Asked at every call and again before a write. */
	private refusal(liveId: string): string | null {
		if (!this.current(liveId)) {
			const end = this.ends.get(liveId);
			return end ? ENDED_TEXT[end.reason] : REFUSED_NOT_HELP;
		}
		if (this.hooks?.heldRemotely(liveId))
			return "A page that is not on this computer has been on this conversation and could answer its prompts, so settings cannot be changed from it. Tell the person to continue at the computer omp-webui runs on (it is lifted by sending a message from there).";
		return null;
	}

	// ------------------------------------------------------------------ the tool

	async call(call: HostToolCall): Promise<HostToolResult> {
		const refused = this.refusal(call.liveId);
		if (refused !== null) return { text: refused, isError: true };
		if (call.name !== SETTINGS_TOOL) return { text: `There is no tool named ${call.name} here.`, isError: true };
		const args = isRecord(call.args) ? call.args : {};
		try {
			if (args.action === "get") return { text: await this.get(call.liveId, args.keys) };
			if (args.action === "set") return await this.set(call, args.changes);
			return { text: '`action` must be "get" or "set".', isError: true };
		} catch (e) {
			if (e instanceof SettingValueError) return { text: e.message, isError: true };
			console.error("omp-webui: webui_settings failed:", e);
			return { text: "The app could not do that (see its log).", isError: true };
		}
	}

	private async get(liveId: string, keys: unknown): Promise<string> {
		let asked: string[] | undefined;
		if (keys !== undefined) {
			if (!Array.isArray(keys) || !keys.every((k) => typeof k === "string"))
				throw new SettingValueError("`keys` must be a list of setting keys");
			const unknown = keys.filter((k) => !this.catalog.has(k));
			if (unknown.length > 0) throw new SettingValueError(this.unknownText(unknown));
			asked = keys;
		}
		const grant = this.current(liveId);
		return JSON.stringify(
			{
				accessEndsInMinutes: grant ? Math.max(0, Math.ceil((grant.expiresAt - this.clock.now()) / 60_000)) : 0,
				settings: await this.catalog.view(asked),
			},
			null,
			2,
		);
	}

	/** What a key the tool cannot change is, in a sentence per key. */
	private unknownText(keys: readonly string[]): string {
		return keys
			.map((key) =>
				classOf(key) === "unavailable"
					? `${key} cannot be changed here: it is something the app keeps for itself, or omp's own configuration (Settings, or \`omp config\` in a terminal). Tell the person where it is.`
					: `Unknown setting: ${key}. \`get\` lists the keys this tool can change.`,
			)
			.join("\n");
	}

	private async set(call: HostToolCall, raw: unknown): Promise<HostToolResult> {
		if (!Array.isArray(raw) || raw.length === 0)
			throw new SettingValueError("`changes` must be a list of { key, value }");
		if (raw.length > SETTINGS_CHANGES_MAX)
			throw new SettingValueError(`At most ${SETTINGS_CHANGES_MAX} changes at a time`);
		const asked: { key: string; value: unknown }[] = [];
		for (const item of raw) {
			if (!isRecord(item) || typeof item.key !== "string" || !("value" in item))
				throw new SettingValueError("Each change is { key, value }");
			asked.push({ key: item.key, value: item.value });
		}
		const keys = asked.map((c) => c.key);
		if (new Set(keys).size !== keys.length) throw new SettingValueError("Name each key once");
		const unknown = keys.filter((k) => !this.catalog.has(k));
		if (unknown.length > 0) throw new SettingValueError(this.unknownText(unknown));
		// Every value is checked before anything is asked or changed: one the app refuses refuses the call whole.
		const problems: string[] = [];
		const checked: { key: string; value: unknown }[] = [];
		for (const { key, value } of asked) {
			try {
				checked.push({ key, value: await this.catalog.check(key, value) });
			} catch (e) {
				problems.push(`${key}: ${(e as Error).message}`);
			}
		}
		if (problems.length > 0) throw new SettingValueError(`Nothing was changed.\n${problems.join("\n")}`);

		const outcomes = await Promise.all(checked.map(({ key, value }) => this.change(call, key, value)));
		const text = JSON.stringify({ results: outcomes }, null, 2);
		return outcomes.some((o) => o.outcome === "applied" || o.outcome === "unchanged")
			? { text }
			: { text, isError: true };
	}

	/** One change: at once for a normal setting, after the person's Allow for a sensitive one. */
	private async change(call: HostToolCall, key: string, value: unknown): Promise<Outcome> {
		const before = await this.catalog.read(key);
		if (sameValue(before, value)) return { key, outcome: "unchanged", old: before };
		let confirmedBy: SettingsChange["confirmedBy"] = "agent";
		if (classOf(key) === "sensitive") {
			const allowed = await this.ask(call, key, before, value);
			if (!allowed)
				return {
					key,
					outcome: "denied",
					old: before,
					message:
						"The person did not allow this change (Deny, no answer in time, or access ended); it was left as it was.",
				};
			confirmedBy = "person";
		}
		// The access may have ended while the person was asked: what was allowed is not written after a revoke.
		const refused = this.refusal(call.liveId);
		if (refused !== null) return { key, outcome: "denied", old: before, message: refused };
		try {
			const old = await this.catalog.read(key);
			await this.catalog.write(key, value);
			const now = await this.catalog.read(key);
			this.log({ liveId: call.liveId, key, old, new: now, confirmedBy });
			return { key, outcome: "applied", old, new: now };
		} catch (e) {
			return { key, outcome: "failed", old: before, message: (e as Error).message };
		}
	}

	/** Put the change to the person and wait for the answer; false for a Deny, no answer in time, or the access ending. */
	private ask(call: HostToolCall, key: string, old: unknown, value: unknown): Promise<boolean> {
		const grant = this.current(call.liveId);
		if (!grant || call.signal.aborted) return Promise.resolve(false);
		const askedAt = this.clock.now();
		const request: SettingsRequest = {
			id: randomUUID(),
			liveId: call.liveId,
			key,
			old,
			new: value,
			askedAt,
			expiresAt: Math.min(askedAt + SETTINGS_CONFIRM_MS, grant.expiresAt),
		};
		const { promise, resolve } = Promise.withResolvers<boolean>();
		const settle = (allowed: boolean) => {
			if (!this.waiting.delete(request.id)) return;
			cancelTimer();
			call.signal.removeEventListener("abort", onAbort);
			this.changed();
			resolve(allowed);
		};
		const onAbort = () => settle(false);
		const cancelTimer = this.clock.after(request.expiresAt - askedAt, onAbort);
		call.signal.addEventListener("abort", onAbort);
		this.waiting.set(request.id, { request, settle });
		this.changed();
		return promise;
	}

	/** The person's Allow (true) or Deny of request `id`. */
	answer(id: unknown, allow: unknown): void {
		const w = typeof id === "string" ? this.waiting.get(id) : undefined;
		if (!w) throw new SettingsHelpError("That change is no longer waiting for an answer", 404);
		if (typeof allow !== "boolean") throw new SettingsHelpError("allow must be true or false", 400);
		w.settle(allow);
	}

	// ------------------------------------------------------------------ the log and undo

	private log(change: Omit<SettingsChange, "id" | "at" | "undoneAt">): void {
		this.changes.push({ id: randomUUID(), at: this.clock.now(), undoneAt: null, ...change });
		if (this.changes.length > SETTINGS_LOG_MAX) this.changes = this.changes.slice(-SETTINGS_LOG_MAX);
		this.saveLog();
		this.changed();
	}

	/**
	 * Put back what change `id` replaced, through the same validated setter. Refused when the setting was changed again
	 * since (its value is not the one the change made): undoing would throw that later change away.
	 */
	async undo(id: unknown): Promise<SettingsChange> {
		const change = this.changes.find((c) => c.id === id);
		if (!change) throw new SettingsHelpError("No such change", 404);
		if (change.undoneAt !== null) throw new SettingsHelpError("That change was undone already", 409);
		const now = await this.catalog.read(change.key);
		if (!sameValue(now, change.new))
			throw new SettingsHelpError(
				`${change.key} was changed again since (it is ${JSON.stringify(now)} now): undo the later change first`,
				409,
			);
		await this.catalog.check(change.key, change.old);
		await this.catalog.write(change.key, change.old);
		change.undoneAt = this.clock.now();
		this.saveLog();
		this.changed();
		return change;
	}

	/** Undo every change conversation `liveId` made that stands, the newest first. The ones that could not be are named. */
	async undoAll(liveId: unknown): Promise<{ undone: number; failed: { id: string; key: string; error: string }[] }> {
		const standing = this.changes.filter((c) => c.liveId === liveId && c.undoneAt === null).reverse();
		if (standing.length === 0) throw new SettingsHelpError("That conversation has no change to undo", 404);
		let undone = 0;
		const failed: { id: string; key: string; error: string }[] = [];
		for (const change of standing) {
			try {
				await this.undo(change.id);
				undone++;
			} catch (e) {
				failed.push({ id: change.id, key: change.key, error: (e as Error).message });
			}
		}
		return { undone, failed };
	}

	private readLog(): SettingsChange[] {
		try {
			const read: unknown = JSON.parse(readFileSync(this.logFile, "utf8"));
			if (!isRecord(read) || !Array.isArray(read.changes)) return [];
			return read.changes
				.filter(
					(c): c is SettingsChange =>
						isRecord(c) &&
						typeof c.id === "string" &&
						typeof c.at === "number" &&
						typeof c.liveId === "string" &&
						typeof c.key === "string" &&
						"old" in c &&
						"new" in c &&
						(c.confirmedBy === "agent" || c.confirmedBy === "person") &&
						(c.undoneAt === null || typeof c.undoneAt === "number"),
				)
				.slice(-SETTINGS_LOG_MAX);
		} catch {
			return [];
		}
	}

	/** Written whole and moved into place: never half a file. */
	private saveLog(): void {
		mkdirSync(this.places.dataDir, { recursive: true, mode: 0o700 });
		const temporary = `${this.logFile}.${process.pid}.tmp`;
		try {
			writeFileSync(temporary, `${JSON.stringify({ changes: this.changes }, null, 2)}\n`, { mode: 0o600 });
			renameSync(temporary, this.logFile);
		} catch (e) {
			rmSync(temporary, { force: true });
			console.error(`omp-webui: the change log of Ask agent for help was not saved: ${(e as Error).message}`);
		}
	}
}
