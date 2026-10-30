import { chmodSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { chmod, copyFile, open, truncate } from "node:fs/promises";
import { join, sep } from "node:path";
import { CodedError } from "../../shared/error-info.ts";
import { isRecord } from "../../shared/guards.ts";
import { parseSelector } from "../../shared/model-config.ts";
import { RISK_SUFFIX } from "../../shared/risk-confirm.ts";
import { RpcClient, type RpcResponse } from "./rpc-client.ts";

/**
 * Side questions (`/btw`) answered by a model other than the conversation's.
 *
 * omp answers a side question with the model its session runs on: `btw` takes a question and a topic, no model and no
 * role (omp 18.12: `runBtwTurn` reads `session.model`), and a `set_model` around it would change the conversation's own
 * model, in its transcript and for every turn that starts meanwhile. So when the person has chosen another model
 * (`ompw.btwModel`), the server answers the question in a short-lived omp of its own: the conversation's session file as
 * it is at that moment, copied into a private folder, resumed there on the chosen model (`--resume <copy> --model <it>`),
 * asked `btw`, and ended. The conversation's process and file are never touched.
 *
 * What differs from omp's own answer, and is said in docs/TECHNICAL.md: the copy is the file as saved, so a turn that is still
 * streaming is not in it; a process has to start; and a follow-up is the topic's earlier turns put in front of the
 * question (the copy has no history of the topic: omp's record of one is its own to write).
 * When omp's `btw` takes a model (see `omp-webui-notes/upstream/omp-btw-model.md`), all of this goes.
 */

/** What a short-lived omp that answers for a conversation is started from (see `Live.sideLaunch`). */
export interface SideLaunch {
	cwd: string;
	/** The conversation's session file; null while it has none. */
	sessionFile: string | null;
	/** The command line the conversation's omp was started with (the server's overlay, the gate, the mode's flags, the user's own). */
	args: string[];
	/** The environment of its mode: a Light process has an agent directory of its own. */
	env: Record<string, string>;
	/** It runs on a local server's models (Light with a local server): its agent directory lists that server's models alone. */
	local: boolean;
	/** The conversation's own settings overlay: copied for the process, never shared (see `Live.sideLaunch`). */
	overlay: string | null;
}

/** The part of a conversation this needs. */
export interface SideLive {
	readonly info: { liveId: string; sessionFile: string | null };
	/** `provider/id` of the model omp runs now; null when not known. */
	currentModel(): string | null;
	sideLaunch(): SideLaunch;
	broadcast(msg: unknown): void;
	rpc(command: Record<string, unknown>, options?: RpcCall): Promise<RpcResponse>;
}

interface RpcCall {
	user?: boolean;
	written?: () => void;
}

type Status = "running" | "complete" | "cancelled" | "error" | "interrupted";

interface Turn {
	question: string;
	answer: string;
	status: Status;
	createdAt: number;
	updatedAt: number;
	error?: string;
}

/** What the page is sent: omp's own record of a side question, plus the model that answered. */
export interface SideRecord extends Turn {
	id: string;
	leafId: null;
	model: string;
	followUps?: Turn[];
}

/** Side questions that are kept for a conversation, and conversations that are kept (the oldest go first). */
export const MAX_RECORDS = 30;
/** Questions of one conversation that may wait behind the one that runs, and processes that run at once, for all conversations. */
export const MAX_WAITING = 2;
export const MAX_FORKS = 3;
export const MAX_CONVERSATIONS = 30;
/** What a follow-up carries of the topic's earlier turns. */
const CONTEXT_CHARS = 24_000;
/** How long a process may take to start, to take the question, and to answer. */
const START_MS = 90_000;
const TAKE_MS = 60_000;
const ANSWER_MS = 10 * 60_000;
/** How long a process gets to end after its input is closed. */
const END_MS = 4_000;
/** How many of omp's own answers the model is noted for. */
const NOTED = 500;

/** Where the copies are made, in the data dir. */
export const FORK_DIR = "btw-fork";

/** The name `mkdtempSync` gives a question's folder (`makeRunDir`). */
const RUN_FOLDER = /^run-[A-Za-z0-9]{6}$/;

const latest = (record: SideRecord): Turn => record.followUps?.at(-1) ?? record;

function patchLatest(record: SideRecord, patch: Partial<Turn>): SideRecord {
	const ups = record.followUps;
	if (ups?.length) return { ...record, followUps: [...ups.slice(0, -1), { ...ups[ups.length - 1], ...patch } as Turn] };
	return { ...record, ...patch };
}

/** The same model, whatever thinking level either selector names. */
export function sameModel(a: string | null, b: string | null): boolean {
	if (a === null || b === null) return false;
	const x = parseSelector(a);
	const y = parseSelector(b);
	return x !== null && y !== null && x.provider === y.provider && x.id === y.id;
}

/**
 * Who answers a new side question: omp itself (nothing chosen; the choice is the model it runs on; or a conversation on a
 * local server, where only that server can be asked), or a process of the server's on the chosen model.
 */
export function routeOf(o: {
	choice: string | null;
	current: string | null;
	local: boolean;
}): { by: "omp" } | { by: "fork"; model: string } {
	const { choice, current } = o;
	if (!choice || sameModel(choice, current)) return { by: "omp" };
	if (o.local) {
		// A local-server process's agent directory lists that server's models alone: another provider is not there to be asked.
		const asked = parseSelector(choice);
		const running = current === null ? null : parseSelector(current);
		if (!asked || !running || asked.provider !== running.provider) return { by: "omp" };
	}
	return { by: "fork", model: choice };
}

/** What binds a process to a conversation, a model or a goal: the fork's to say, not the conversation's. */
const BARE = new Set(["-c", "--continue", "--no-session", "--from-claude", "--from-codex"]);
const VALUED = new Set(["-r", "--resume", "--session", "--restore", "--fork", "--model", "--goal", "--session-dir"]);

/** The command line of the process that answers: the conversation's own, bound to the copy and the chosen model. */
export function forkArgs(
	args: readonly string[],
	to: { model: string; session: string | null; overlay: string | null },
): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (BARE.has(a)) continue;
		if (VALUED.has(a.split("=", 1)[0])) {
			// The word after it is its value, unless that is another flag (`--resume` alone picks from a list).
			if (!a.includes("=") && i + 1 < args.length && !args[i + 1].startsWith("-")) i++;
			continue;
		}
		out.push(a);
	}
	out.push("--model", to.model);
	if (to.session) out.push("--resume", to.session);
	else out.push("--no-session");
	if (to.overlay) out.push("--config", to.overlay);
	return out;
}

/**
 * The session file as saved, up to its last whole line (omp may be writing the next one as it is copied), at `to` and
 * readable by this user alone. A copy that shares the file's blocks where the disk can (APFS), so a long conversation
 * costs no time to copy.
 */
export async function snapshotSession(from: string, to: string): Promise<void> {
	await copyFile(from, to, constants.COPYFILE_FICLONE);
	await chmod(to, 0o600);
	const handle = await open(to, "r");
	try {
		const size = (await handle.stat()).size;
		const block = Buffer.alloc(Math.min(size, 64 * 1024));
		let end = size;
		// Back from the end, a block at a time, to the newline that ends the last whole line.
		while (end > 0) {
			const start = Math.max(0, end - block.length);
			const { bytesRead } = await handle.read(block, 0, end - start, start);
			const at = block.subarray(0, bytesRead).lastIndexOf(0x0a);
			if (at >= 0) {
				if (start + at + 1 < size) await truncate(to, start + at + 1);
				return;
			}
			end = start;
		}
		// No newline at all: not one whole line.
		if (size > 0) await truncate(to, 0);
	} finally {
		await handle.close();
	}
}

/** `question` with the topic's earlier turns in front of it (the newest ones, within `CONTEXT_CHARS`). */
export function withTopic(question: string, earlier: readonly Turn[]): string {
	const answered = earlier.filter((t) => t.answer.trim() !== "");
	if (answered.length === 0) return question;
	const parts: string[] = [];
	let used = 0;
	for (const t of answered.toReversed()) {
		const part = `Question: ${t.question.trim()}\nAnswer: ${t.answer.trim()}`;
		if (used + part.length > CONTEXT_CHARS && parts.length > 0) break;
		parts.unshift(part);
		used += part.length;
	}
	return `Earlier in this side conversation:\n\n${parts.join("\n\n")}\n\nFollow-up question: ${question}`;
}

/** `work`, or an error when it takes longer than `ms`. */
async function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
	const late = Promise.withResolvers<never>();
	const timer = setTimeout(() => late.reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`)), ms);
	try {
		return await Promise.race([work, late.promise]);
	} finally {
		clearTimeout(timer);
	}
}

interface Job {
	key: string;
	live: SideLive;
	/** The record this answers, with the new turn last. */
	record: SideRecord;
	/** What omp is asked: the question, after the topic's earlier turns. */
	ask: string;
	launch: SideLaunch;
	model: string;
	finished: boolean;
	/** Has a place among the processes that run (`MAX_FORKS`): the question no longer waits. */
	started: boolean;
	/** Ends the process that answers; null until one runs. */
	abort: (() => void) | null;
}

/** The server's side questions: those a process of its own answers (on the model the person chose), and the ways to ask them. */
export class BtwForks {
	/** The side questions the server has answered, by conversation (see `keyOf`; the one used longest ago first), then by id. */
	private readonly store = new Map<string, Map<string, SideRecord>>();
	private readonly jobs = new Map<string, Job[]>();
	private readonly chains = new Map<string, Promise<void>>();
	/** The model omp's own answers were given by, where the server knew it when it took the question: the page says it. */
	private readonly noted = new Map<string, string>();
	private seq = 0;
	private stopping = false;
	/** Processes running now, and the questions waiting for a place among them (see `slot`). */
	private active = 0;
	private readonly slotQueue: (() => void)[] = [];

	constructor(
		private readonly deps: {
			/** omp. */
			bin: () => string;
			dataDir: string;
			/** The model chosen for side questions (`ompw.btwModel`); null: the conversation's own. */
			choice: () => string | null;
			/** Why no question can be taken now (an import is writing the files conversations run on); null: none. */
			refusal: () => Error | null;
		},
	) {}

	/**
	 * What the conversation's side questions are kept under: its session file, else the process. A new chat has no file until
	 * its first message: what was kept under the process is the file's from then on, so it is not lost when the file appears.
	 */
	private keyOf(live: SideLive): string {
		const own = `live:${live.info.liveId}`;
		const file = live.info.sessionFile;
		if (!file) return own;
		if (this.store.has(own) || this.jobs.has(own) || this.chains.has(own)) this.rekey(own, file);
		return file;
	}

	/** Everything kept under `from` is kept under `to`: its records, its questions that wait or run, and their order. */
	private rekey(from: string, to: string): void {
		const records = this.store.get(from);
		if (records) {
			const into = this.store.get(to) ?? new Map<string, SideRecord>();
			for (const [id, record] of records) into.set(id, record);
			this.store.delete(from);
			this.store.set(to, into);
		}
		const jobs = this.jobs.get(from);
		if (jobs) {
			for (const job of jobs) job.key = to;
			this.jobs.set(to, [...(this.jobs.get(to) ?? []), ...jobs]);
			this.jobs.delete(from);
		}
		const chain = this.chains.get(from);
		if (chain) {
			const there = this.chains.get(to);
			this.chains.set(to, there ? Promise.all([there, chain]).then(() => {}) : chain);
			this.chains.delete(from);
		}
	}

	private get parent(): string {
		return join(this.deps.dataDir, FORK_DIR);
	}

	/**
	 * A command the page sent a conversation, as far as it is about side questions: answered here (a question for another
	 * model, and the history and cancelling of those) or passed on to omp with its own answers' model noted. Null for any
	 * other command.
	 */
	async rpc(live: SideLive, command: Record<string, unknown>, call: RpcCall = {}): Promise<RpcResponse | null> {
		switch (command.type) {
			case "btw":
				return this.btw(live, command, call);
			case "btw_cancel":
				return this.cancelCommand(live, command, call);
			case "get_btw_history":
				return this.history(live, command, call);
			default:
				return null;
		}
	}

	private async btw(live: SideLive, command: Record<string, unknown>, call: RpcCall): Promise<RpcResponse> {
		const question = typeof command.question === "string" ? command.question.trim() : "";
		const key = this.keyOf(live);
		const asked = typeof command.recordId === "string" ? command.recordId : null;
		const topic = asked === null ? null : (this.store.get(key)?.get(asked) ?? null);
		// A topic omp answered is omp's to go on with, whatever is chosen: the server has none of its turns.
		if (asked !== null && topic === null) return this.byOmp(live, command, call);
		// A topic the server answered goes on where it began; a new question goes where the person's choice says.
		const route = topic
			? ({ by: "fork", model: topic.model } as const)
			: routeOf({ choice: this.deps.choice(), current: live.currentModel(), local: live.sideLaunch().local });
		if (route.by === "omp" || question === "") return this.byOmp(live, command, call);
		try {
			const record = this.ask(live, key, question, route.model, topic);
			call.written?.();
			return { type: "response", command: "btw", success: true, data: { record } };
		} catch (e) {
			const code = e instanceof CodedError ? e.code : undefined;
			return {
				type: "response",
				command: "btw",
				success: false,
				error: (e as Error).message,
				...(code ? { code } : {}),
			};
		}
	}

	/** omp's own answer, with the model it is given by noted when it is known. */
	private async byOmp(live: SideLive, command: Record<string, unknown>, call: RpcCall): Promise<RpcResponse> {
		const model = live.currentModel();
		const r = await live.rpc(command, call);
		const data = r.success && isRecord(r.data) ? r.data : null;
		const record = data && isRecord(data.record) ? data.record : null;
		if (!data || !record || typeof record.id !== "string") return r;
		// A topic keeps the model it began on, where that is known: its follow-ups are shown with it.
		const answered = this.noted.get(record.id) ?? model;
		if (!answered) return r;
		this.noted.set(record.id, answered);
		while (this.noted.size > NOTED) this.noted.delete(this.noted.keys().next().value as string);
		return { ...r, data: { ...data, record: { ...record, model: answered } } };
	}

	private async cancelCommand(live: SideLive, command: Record<string, unknown>, call: RpcCall): Promise<RpcResponse> {
		const key = this.keyOf(live);
		const id = typeof command.recordId === "string" ? command.recordId : undefined;
		const here = this.cancel(key, id);
		const answer = (cancelled: boolean): RpcResponse => ({
			type: "response",
			command: "btw_cancel",
			success: true,
			data: { cancelled },
		});
		// A topic the server answers is not omp's: omp has nothing to cancel for it.
		if (id !== undefined && this.store.get(key)?.has(id)) return answer(here);
		const r = await live.rpc(command, call).catch((): null => null);
		if (r?.success) return answer(here || (isRecord(r.data) && r.data.cancelled === true));
		if (here) return answer(true);
		return r ?? { type: "response", command: "btw_cancel", success: false, error: "omp is not running" };
	}

	private async history(live: SideLive, command: Record<string, unknown>, call: RpcCall): Promise<RpcResponse> {
		const ours = [...(this.store.get(this.keyOf(live))?.values() ?? [])];
		const r = await live.rpc(command, call).catch((): null => null);
		const theirs =
			r?.success && isRecord(r.data) && Array.isArray(r.data.records)
				? (r.data.records as Record<string, unknown>[])
				: null;
		// omp cannot say (the conversation is paused, or has ended) and the server has answers of its own: those are shown.
		if (!theirs && ours.length === 0) {
			return r ?? { type: "response", command: "get_btw_history", success: false, error: "omp is not running" };
		}
		const marked = (theirs ?? []).map((rec) => {
			const model = typeof rec.id === "string" ? this.noted.get(rec.id) : undefined;
			return model ? { ...rec, model } : rec;
		});
		const records = [...marked, ...ours].sort(
			(a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0) || String(a.id).localeCompare(String(b.id)),
		);
		return { type: "response", command: "get_btw_history", success: true, data: { records } };
	}

	/** Take a question for the process that answers: its record is shown at once (as omp's is), and the answer follows. */
	private ask(live: SideLive, key: string, question: string, model: string, topic: SideRecord | null): SideRecord {
		if (this.stopping) throw new Error("The server is shutting down");
		const refused = this.deps.refusal();
		if (refused) throw refused;
		const waiting = (this.jobs.get(key) ?? []).filter((j) => !j.finished && !j.started).length;
		if (waiting >= MAX_WAITING) {
			throw new CodedError(
				`${waiting} side questions of this conversation are already waiting: wait for one to be answered, or cancel one`,
				"btwTooMany",
			);
		}
		const now = Date.now();
		const turn: Turn = { question, answer: "", status: "running", createdAt: now, updatedAt: now };
		let record: SideRecord;
		if (topic) {
			if (latest(topic).status === "running") throw new Error("A /btw question is still running; cancel it first");
			record = { ...topic, followUps: [...(topic.followUps ?? []), turn] };
		} else {
			record = { ...turn, id: `side-${now.toString(36)}-${(++this.seq).toString(36)}`, leafId: null, model };
		}
		const earlier = topic ? [topic, ...(topic.followUps ?? [])] : [];
		const job: Job = {
			key,
			live,
			record,
			ask: withTopic(question, earlier),
			launch: live.sideLaunch(),
			model,
			finished: false,
			started: false,
			abort: null,
		};
		this.keep(key, record);
		this.announce(job);
		this.jobs.set(key, [...(this.jobs.get(key) ?? []), job]);
		// One at a time for a conversation: the next question waits for the answer before it.
		const chain = (this.chains.get(key) ?? Promise.resolve())
			.then(() => this.execute(job))
			.catch((e) => this.finish(job, "error", (e as Error).message))
			.finally(() => {
				// The job's own key: the conversation's file may have appeared since (see `keyOf`).
				const rest = (this.jobs.get(job.key) ?? []).filter((j) => j !== job);
				if (rest.length > 0) this.jobs.set(job.key, rest);
				else this.jobs.delete(job.key);
				if (this.chains.get(job.key) === chain) this.chains.delete(job.key);
			});
		this.chains.set(key, chain);
		return record;
	}

	/** Remember `record` for its conversation: the conversation used last comes last, and the oldest of both go past the bounds. */
	private keep(key: string, record: SideRecord): void {
		const records = this.store.get(key) ?? new Map<string, SideRecord>();
		records.set(record.id, record);
		while (records.size > MAX_RECORDS) records.delete(records.keys().next().value as string);
		this.store.delete(key);
		this.store.set(key, records);
		while (this.store.size > MAX_CONVERSATIONS) this.store.delete(this.store.keys().next().value as string);
	}

	private announce(job: Job): void {
		job.live.broadcast({ t: "frame", liveId: job.live.info.liveId, frame: { type: "btw_record", record: job.record } });
	}

	/** End a job's answer, once: the record says how, and every page is told. */
	private finish(job: Job, status: Exclude<Status, "running">, error?: string, answer?: string): void {
		if (job.finished) return;
		job.finished = true;
		job.record = patchLatest(job.record, {
			status,
			updatedAt: Date.now(),
			...(answer !== undefined ? { answer } : {}),
			...(error !== undefined ? { error } : {}),
		});
		this.keep(job.key, job.record);
		this.announce(job);
	}

	/** Cancel the side question `id` of a conversation (every one of them without `id`); whether any was running or waiting. */
	cancel(key: string, id?: string): boolean {
		let any = false;
		for (const job of this.jobs.get(key) ?? []) {
			if (job.finished || (id !== undefined && job.record.id !== id)) continue;
			any = true;
			this.finish(job, "cancelled");
			job.abort?.();
		}
		return any;
	}

	/** The folder one question runs in: this user's alone. */
	private makeRunDir(): string {
		mkdirSync(this.parent, { recursive: true, mode: 0o700 });
		chmodSync(this.parent, 0o700);
		return mkdtempSync(join(this.parent, "run-"));
	}

	/** Remove what a question left: only ever inside the folder the server made for it. */
	private clear(dir: string): void {
		if (!dir.startsWith(this.parent + sep)) return;
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch (e) {
			console.warn(`omp-webui: could not remove ${dir}: ${(e as Error).message}`);
		}
	}

	/** The files omp is given: the conversation as saved, and its settings overlay with the gate's word beside it. */
	private async prepare(dir: string, launch: SideLaunch): Promise<{ session: string | null; overlay: string | null }> {
		let session: string | null = null;
		if (launch.sessionFile && existsSync(launch.sessionFile)) {
			session = join(dir, "session.jsonl");
			await snapshotSession(launch.sessionFile, session);
		}
		let overlay: string | null = null;
		if (launch.overlay) {
			// Taken away since the process began (a cleaner of the temp dir): the conversation's approval mode and guard word are not
			// ours to guess, so the question is not asked without them.
			if (!existsSync(launch.overlay)) {
				throw new Error("This conversation's settings file is gone: open the conversation again, then ask");
			}
			overlay = join(dir, "overlay.yml");
			// The gate reads the server's word to it (`<overlay>.risk`) beside the overlay it was started with.
			for (const suffix of ["", RISK_SUFFIX]) {
				if (!existsSync(`${launch.overlay}${suffix}`)) continue;
				await copyFile(`${launch.overlay}${suffix}`, `${overlay}${suffix}`);
				await chmod(`${overlay}${suffix}`, 0o600);
			}
		}
		return { session, overlay };
	}

	/** A place among the processes that run at once: waits for one when `MAX_FORKS` already run, in the order asked. */
	private async slot(): Promise<void> {
		if (this.active < MAX_FORKS) {
			this.active++;
			return;
		}
		const turn = Promise.withResolvers<void>();
		this.slotQueue.push(turn.resolve);
		await turn.promise;
	}

	/** Give the place to the next question that waits for one, if any. */
	private release(): void {
		const next = this.slotQueue.shift();
		if (next) next();
		else this.active--;
	}

	private async execute(job: Job): Promise<void> {
		if (job.finished) return;
		await this.slot();
		try {
			if (job.finished) return;
			job.started = true;
			await this.run(job);
		} finally {
			this.release();
		}
	}

	private async run(job: Job): Promise<void> {
		if (job.finished) return;
		const dir = this.makeRunDir();
		let client: RpcClient | null = null;
		try {
			const files = await this.prepare(dir, job.launch);
			if (job.finished) return;
			const ended = Promise.withResolvers<{ status: Status; answer: string; error?: string }>();
			/** The id omp gave the question: set as its answer is read, before any frame that follows it. */
			let taken: string | null = null;
			client = new RpcClient({
				bin: this.deps.bin(),
				args: forkArgs(job.launch.args, { model: job.model, ...files }),
				cwd: job.launch.cwd,
				env: job.launch.env,
				mode: "rpc",
				private: true,
				onFrame: (f) => {
					if (job.finished || taken === null) return;
					if (f.type === "btw_delta" && f.recordId === taken && typeof f.delta === "string") {
						job.record = patchLatest(job.record, {
							answer: latest(job.record).answer + f.delta,
							updatedAt: Date.now(),
						});
						this.keep(job.key, job.record);
						job.live.broadcast({
							t: "frame",
							liveId: job.live.info.liveId,
							frame: { type: "btw_delta", recordId: job.record.id, delta: f.delta },
						});
					} else if (f.type === "btw_record" && isRecord(f.record) && f.record.id === taken) {
						const turn = (f.record.followUps as Turn[] | undefined)?.at(-1) ?? (f.record as unknown as Turn);
						if (turn.status !== "running")
							ended.resolve({ status: turn.status, answer: turn.answer, error: turn.error });
					}
				},
				onExit: (code, stderr) => {
					// It ended before it had answered: why, as it said.
					const why =
						stderr
							.trim()
							.split("\n")
							.findLast((l) => l.trim() !== "") ?? `omp exited (code ${code})`;
					ended.resolve({ status: "error", answer: "", error: why.slice(0, 500) });
				},
			});
			const forked = client;
			job.abort = () => forked.kill("SIGTERM");
			await within(client.ready, START_MS, "Starting omp");
			if (job.finished) return;
			const r = await within(
				client.request({ type: "btw", question: job.ask }, 0, undefined, (answer) => {
					const record = answer.success && isRecord(answer.data) ? answer.data.record : null;
					if (isRecord(record) && typeof record.id === "string") taken = record.id;
				}),
				TAKE_MS,
				"Taking the question",
			);
			if (!r.success) throw new Error(r.error ?? "omp refused the question");
			if (taken === null) throw new Error("omp did not say which question it took");
			const outcome = await within(ended.promise, ANSWER_MS, "The answer");
			this.finish(job, outcome.status === "running" ? "error" : outcome.status, outcome.error, outcome.answer);
		} catch (e) {
			this.finish(job, "error", (e as Error).message);
		} finally {
			job.abort = null;
			if (client) await this.end(client);
			this.clear(dir);
		}
	}

	/** Let the process end: its input is closed, and it is made to end when it does not. */
	private async end(client: RpcClient): Promise<void> {
		if (client.isExited) return;
		client.close();
		if (await Promise.race([client.whenExited.then(() => true), Bun.sleep(END_MS).then(() => false)])) return;
		client.kill("SIGKILL");
		await Promise.race([client.whenExited, Bun.sleep(END_MS)]);
	}

	/** The server is stopping: every question that waits or runs ends, and what each made is removed. */
	async stop(): Promise<void> {
		this.stopping = true;
		for (const jobs of this.jobs.values()) {
			for (const job of jobs) {
				if (job.finished) continue;
				this.finish(job, "interrupted");
				job.abort?.();
			}
		}
		await Promise.all(this.chains.values());
	}
}

/**
 * What a server that ended without a goodbye left in `<data dir>/btw-fork`: the `run-*` folders it made for copies of
 * conversations that nobody asks about any more. Cleared when the server starts. Only what this server makes is removed: a
 * real folder named `run-…` (a link, a file or any other name is left alone, and so is a `btw-fork` that is itself a link).
 */
export function sweepForkDir(dataDir: string): void {
	const dir = join(dataDir, FORK_DIR);
	try {
		if (!lstatSync(dir).isDirectory()) return;
	} catch {
		return;
	}
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		try {
			if (!RUN_FOLDER.test(name) || !lstatSync(path).isDirectory()) continue;
			rmSync(path, { recursive: true, force: true });
		} catch (e) {
			console.warn(`omp-webui: could not remove ${path}: ${(e as Error).message}`);
		}
	}
}
