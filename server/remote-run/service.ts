import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { isRecord } from "../../shared/guards.ts";
import type { HostToolDefinition } from "../../shared/guided-goal.ts";
import { MAC_LIMIT, type MacRecord } from "../../shared/macs.ts";
import type { LiveInfo } from "../../shared/protocol.ts";
import { parseRemoteRunArgs, REMOTE_RUN_TOOL, remoteRunTool } from "../../shared/remote-run.ts";
import type { HostToolCall, HostToolResult, HostToolServer } from "../omp/host-tools.ts";
import { RemoteNotSignedIn, type RemoteRunResult, RemoteUnsupported, runRemote } from "./client.ts";
import type { RemoteSignIns } from "./sign-ins.ts";

/**
 * Run commands on another computer (docs/superpowers/specs/2026-11-10-remote-run-design.md): which conversations may, on which
 * of the person's saved computers, and the `remote_run` tool they are served.
 *
 * The choice is the person's, per conversation, made from their own page (`POST /api/remote-run/live`; no tool can make it):
 * kept by session file in `<data dir>/remote-run.json` (`{ "version": 1, "conversations": { "<session file>": ["<mac id>", …] } }`,
 * written whole and moved into place, mode 0600), so that it holds when the conversation is resumed, restarted or taken over
 * by a server that started again (`started`), and follows it to another session file (`moved`). Off in every conversation
 * until the person turns it on; an id that is no longer on the Macs list counts for nothing, and is forgotten when the Mac is
 * removed (`forget`).
 *
 * A conversation that has computers is served one tool (`Live.serveHostTools`), whose `computer` is one of their names (an
 * enum): it runs over that conversation's own omp pipe, follows its approval mode like `bash` (a host tool with no policy of
 * its own is tier `exec` in omp), and is given again with the new names whenever the choice or the list changes. A conversation
 * whose one set of server tools is held for something else ("Set up with AI", "Ask agent for help") is given none.
 *
 * A call is refused in a conversation a page that is not the person's own has been on (it could have answered omp's approval
 * prompt), as `RemoteAi`'s are; it runs with the sign-in the macOS app handed over (`RemoteSignIns`), which is never in what the
 * tool is given or returns.
 */

/** A refused change of a conversation's computers, with the HTTP status to answer it with. */
export class RemoteRunError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

/** What the service needs of a conversation's process (`Live` is one). */
export interface RemoteRunConversation {
	readonly info: LiveInfo;
	readonly hostToolServer: HostToolServer | null;
	serveHostTools(server: HostToolServer | null): Promise<void>;
}

/** What the service needs of the server around it; `C` is what a conversation is there (`Live`). */
export interface RemoteRunNeeds<C extends RemoteRunConversation> {
	/** Where the choices are kept. */
	file: string;
	/** The saved computers, as the list holds them now. */
	macs(): readonly MacRecord[];
	signIns: RemoteSignIns;
	/** The running conversation `liveId`, if there is one. */
	live(liveId: string): C | undefined;
	/** Every running conversation. */
	lives(): C[];
	/** Whether a page that is not the person's own (one that holds only the token) has been on conversation `liveId`. */
	heldRemotely(liveId: string): boolean;
	/** The conversation's info changed: every page is told. */
	announce(live: C): void;
	/** A sign-in was found to have lapsed and was forgotten: every page is told (the Macs list shows it). */
	signedOut(): void;
	/** How a command is run (tests stand in for the remote computer here). */
	run?: typeof runRemote;
}

/** The tool for one conversation, with the names of its computers: what `Live.serveHostTools` is given. */
export class RemoteRunTools implements HostToolServer {
	readonly tools: readonly HostToolDefinition[];
	readonly readOnly: readonly string[] = [];

	constructor(
		private readonly service: Pick<HostToolServer, "call">,
		readonly computers: readonly string[],
	) {
		this.tools = [remoteRunTool(computers)];
	}

	call(call: HostToolCall): Promise<HostToolResult> {
		return this.service.call(call);
	}

	ended(): void {
		// Nothing is held per process: the choice is the conversation's, and outlives it.
	}
}

const NOT_ON_HERE =
	"A page that is not the person's own (one that holds only the access token, without a Cloudflare Access sign-in) has been on this conversation, and could have answered omp's approval prompt itself, so commands on other computers are refused. Do nothing, and tell the person to continue from their own page: this computer's, or one signed in through Access (it is lifted by sending a message from there).";
const NONE_GIVEN =
	"This conversation was given no remote computers (or they were taken away). Only the person can give it some, in the conversation's session controls. Tell them, and do not try another way.";
export const WINDOWS_REFUSED = "Running commands on Windows computers is not supported yet.";
export const notSignedIn = (name: string): string =>
	`${name}: not signed in (or the sign-in has lapsed). Open its window from the Macs list and sign in, then try again.`;

/** What the agent is told of a run: one line of what came of it, then the output. */
export function describeRun(name: string, r: RemoteRunResult): string {
	const parts = [name, r.exitCode === null ? "no exit code" : `exit ${r.exitCode}`, `${(r.ms / 1000).toFixed(1)}s`];
	if (r.timedOut) parts.push("timed out");
	else if (r.cancelled) parts.push("cancelled");
	else if (r.exitCode === null) parts.push("the shell ended before the command did");
	if (r.cut) parts.push("output cut to the last 64 KB");
	return `${parts.join(" · ")}\n${r.output}`;
}

export class RemoteRun<C extends RemoteRunConversation = RemoteRunConversation> {
	constructor(private readonly hooks: RemoteRunNeeds<C>) {}

	// ------------------------------------------------------------------ the choices

	/** The kept choices, by session file; a file that cannot be read is none. */
	private read(): Record<string, string[]> {
		try {
			const read: unknown = JSON.parse(readFileSync(this.hooks.file, "utf8"));
			if (!isRecord(read) || read.version !== 1 || !isRecord(read.conversations)) return {};
			const out: Record<string, string[]> = {};
			for (const [key, ids] of Object.entries(read.conversations))
				if (Array.isArray(ids)) out[key] = ids.filter((id): id is string => typeof id === "string");
			return out;
		} catch {
			return {};
		}
	}

	private write(conversations: Record<string, string[]>): void {
		mkdirSync(dirname(this.hooks.file), { recursive: true, mode: 0o700 });
		const temporary = `${this.hooks.file}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temporary, `${JSON.stringify({ version: 1, conversations }, null, 2)}\n`, { mode: 0o600 });
			chmodSync(temporary, 0o600);
			renameSync(temporary, this.hooks.file);
		} catch (e) {
			rmSync(temporary, { force: true });
			throw e;
		}
	}

	/** The computers the conversation in `sessionFile` was given that are still on the list, in the list's order. */
	computersOf(sessionFile: string | null): MacRecord[] {
		if (sessionFile === null) return [];
		const ids = new Set((this.read()[sessionFile] ?? []).map((id) => id.toLowerCase()));
		return this.hooks.macs().filter((m) => ids.has(m.id.toLowerCase()));
	}

	/**
	 * The person gave the running conversation `live` these computers (`macIds`, ids on the Macs list; empty: none): kept, and
	 * the conversation is served the tool for them now (or has it taken away). Returns the ids as kept.
	 */
	async choose(live: C, macIds: unknown): Promise<string[]> {
		if (!Array.isArray(macIds) || macIds.length > MAC_LIMIT || !macIds.every((id) => typeof id === "string"))
			throw new RemoteRunError("macIds must be a list of the ids of saved computers", 400);
		const macs = this.hooks.macs();
		const chosen: string[] = [];
		for (const id of macIds) {
			const mac = macs.find((m) => m.id.toLowerCase() === id.toLowerCase());
			if (!mac) throw new RemoteRunError(`No saved computer has the id ${id}`, 400);
			if (!chosen.includes(mac.id)) chosen.push(mac.id);
		}
		const key = live.info.sessionFile;
		if (key === null) throw new RemoteRunError("This conversation has no session file yet", 409);
		if (this.heldElsewhere(live))
			throw new RemoteRunError(
				'This conversation\'s tools are held by "Set up with AI" or "Ask agent for help", so it cannot run commands on other computers',
				409,
			);
		const all = this.read();
		if (chosen.length > 0) all[key] = chosen;
		else delete all[key];
		this.write(all);
		try {
			await this.apply(live);
		} catch (e) {
			throw new RemoteRunError(`Could not give the conversation the tool: ${(e as Error).message}`, 409);
		}
		return chosen;
	}

	/** Whether the conversation's one set of server tools is held for something else. */
	private heldElsewhere(live: C): boolean {
		const holder = live.hostToolServer;
		return holder !== null && !(holder instanceof RemoteRunTools);
	}

	/**
	 * Serve the conversation the tool for the computers it has now, or take it away when it has none; the pages are told.
	 * Nothing is served to one whose server tools are held for something else.
	 */
	private async apply(live: C): Promise<void> {
		if (live.info.exited) return;
		const macs = this.computersOf(live.info.sessionFile);
		const holder = live.hostToolServer;
		const ours = holder instanceof RemoteRunTools;
		if (macs.length === 0 || this.heldElsewhere(live)) {
			if (ours) await live.serveHostTools(null);
			if (live.info.remoteComputers !== undefined) {
				delete live.info.remoteComputers;
				this.hooks.announce(live);
			}
			return;
		}
		const names = macs.map((m) => m.name);
		const ids = macs.map((m) => m.id);
		// The same names as it has: omp is not told again (the list changes for a sign-in, or a Mac's last connection).
		if (!ours || JSON.stringify(holder.computers) !== JSON.stringify(names))
			await live.serveHostTools(new RemoteRunTools(this, names));
		if (JSON.stringify(live.info.remoteComputers) === JSON.stringify(ids)) return;
		live.info.remoteComputers = ids;
		this.hooks.announce(live);
	}

	/** A process started for a conversation: one that was given computers is served the tool. Never rejects. */
	async started(live: C): Promise<void> {
		// One that was given none is left as it is: nothing is sent to its omp.
		if (this.computersOf(live.info.sessionFile).length === 0) return;
		try {
			await this.apply(live);
		} catch (e) {
			console.error(`omp-webui: could not give ${live.info.liveId} its remote computers: ${(e as Error).message}`);
		}
	}

	/** The conversation in `from` moved to `to`: its computers go along, unless `to` has its own. */
	moved(from: string, to: string): void {
		const all = this.read();
		const picked = all[from];
		if (!picked || picked.length === 0 || all[to] !== undefined) return;
		all[to] = picked;
		this.write(all);
	}

	/** The Mac `macId` left the list: no conversation keeps it, and the ones that run are served without it. */
	async forget(macId: string): Promise<void> {
		const all = this.read();
		let changed = false;
		for (const [key, ids] of Object.entries(all)) {
			const kept = ids.filter((id) => id.toLowerCase() !== macId.toLowerCase());
			if (kept.length === ids.length) continue;
			changed = true;
			if (kept.length > 0) all[key] = kept;
			else delete all[key];
		}
		if (changed) this.write(all);
		await this.macsChanged();
	}

	/** The list changed (a Mac renamed, added or removed): every conversation that has the tool is given its names again. */
	async macsChanged(): Promise<void> {
		const serving = this.hooks
			.lives()
			.filter((l) => !l.info.exited && (l.hostToolServer instanceof RemoteRunTools || l.info.remoteComputers));
		await Promise.all(
			serving.map((l) =>
				this.apply(l).catch((e: unknown) =>
					console.error(`omp-webui: could not give ${l.info.liveId} its remote computers: ${(e as Error).message}`),
				),
			),
		);
	}

	// ------------------------------------------------------------------ the tool

	/** Answer a call of `remote_run`. */
	async call(call: HostToolCall): Promise<HostToolResult> {
		if (call.name !== REMOTE_RUN_TOOL) return { text: `There is no tool named ${call.name} here.`, isError: true };
		if (this.hooks.heldRemotely(call.liveId)) return { text: NOT_ON_HERE, isError: true };
		// What the conversation has now, not what it had when the tool was given: the person may have changed it since.
		const macs = this.computersOf(this.hooks.live(call.liveId)?.info.sessionFile ?? null);
		if (macs.length === 0) return { text: NONE_GIVEN, isError: true };
		const args = parseRemoteRunArgs(
			call.args,
			macs.map((m) => m.name),
		);
		if ("error" in args) return { text: args.error, isError: true };
		const mac = macs.find((m) => m.name === args.computer);
		if (!mac) return { text: NONE_GIVEN, isError: true };
		const signIn = this.hooks.signIns.get(mac.id);
		if (!signIn) return { text: notSignedIn(mac.name), isError: true };
		if (call.signal.aborted) return { text: "The call was cancelled.", isError: true };
		try {
			const result = await (this.hooks.run ?? runRemote)({
				host: mac.host,
				jwt: signIn.jwt,
				command: args.command,
				cwd: args.cwd,
				timeoutMs: args.timeoutS * 1000,
				signal: call.signal,
			});
			return { text: describeRun(mac.name, result), ...(result.exitCode === 0 ? {} : { isError: true }) };
		} catch (e) {
			if (e instanceof RemoteNotSignedIn) {
				// The computer no longer takes it: the person sees the Mac signed out, and signs in again in its window.
				this.hooks.signIns.clear(mac.id);
				this.hooks.signedOut();
				return { text: notSignedIn(mac.name), isError: true };
			}
			if (e instanceof RemoteUnsupported) return { text: WINDOWS_REFUSED, isError: true };
			return { text: `${mac.name}: ${(e as Error).message}`, isError: true };
		}
	}
}
