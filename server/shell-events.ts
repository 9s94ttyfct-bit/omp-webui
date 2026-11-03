import {
	type AttentionKind,
	type AttentionNotice,
	attentionNotice,
	attentionOf,
	conversationTitle,
	factsOf,
	noticeLang,
	type WorkCounts,
	type WorkFacts,
	workCounts,
} from "../shared/attention.ts";
import type { LiveInfo } from "../shared/protocol.ts";

/**
 * What the macOS app is told on its own (#627): the app shows its notifications itself, from here, and keeps a menu bar
 * icon that says what is running, so that it needs no window and no page while it runs in the background. One long
 * response of newline-delimited JSON, `GET /api/shell/events?lang=<en|zh-CN>&epoch=<id>&since=<n>`, for this computer's pages
 * only (the route is `isLocalOnlyRoute`'s: a page that came through the tunnel or over the network is refused it, token or not):
 *
 * - `{ t: "state", epoch, working, asking, paused, menuIcon, questions, unseen }`: how many conversations work, how many wait
 *   for an answer, how many are paused (the menu bar icon offers Resume all for those), whether the menu bar icon is shown while
 *   the app has its window too (Settings › Quitting, `ompw.menuIcon`; it always is while the app runs in the background), how
 *   many unattended questions are open (#646: asked by an agent, not yet answered or dismissed; the icon counts them with the
 *   conversations that wait, and its menu opens the Questions page) and the runs that ended and nobody here has looked at since
 *   (`unseen`: one token for each such conversation, new each time it finishes; the app puts a ✓ beside the icon while there is
 *   one it has not shown in its menu). A run that ends while a page on this computer is in use and shows its conversation is
 *   seen as it ends; the others are seen when such a page shows the conversation (`look`: any window, pop-out or tab here),
 *   whether or not notifications are on. First when the response begins (so a reader that reconnects has them as they are
 *   now) and again whenever one changes. `epoch` names this server's run: a reader that sees another one forgets what it had read.
 * - `{ t: "attention", seq, id, kind, title, body, liveId, file }`: a conversation needs somebody (`asking`: a dialog waits, a
 *   tool approval or a question; `finished`: its run ended), with the words the page's own notifications have, in the
 *   language the person saved (`ompw.lang`), else the one `lang` names (the Mac's own). Only while Settings has
 *   notifications on. `seq` counts them from 1 in an epoch; the last few are kept, and a reader that says which `epoch` and
 *   `since` which notice it last saw is sent the ones it missed while it was not reading, right after the state.
 * - an empty line every few seconds, so that a reader can tell a response that stalled from one that is quiet.
 *
 * The app of another Mac that has this one in its list reads the same stream from `GET /api/notify/events` (#656), which is not
 * local-only: it is the route a window onto this Mac is signed in for, and it is let in exactly as that window is. The request
 * has passed Cloudflare Access (`RemoteAuth.verify`: a valid token for this application and an allowed email) and holds this
 * server's access token, both from the cookies the window's own sign-in left; a page on this computer needs the token, as for any
 * route; a page on the network, which is neither, is refused. It is the same stream, except that its reader asked for it, so the
 * server's own switch (Settings › Notifications, which is for this Mac's own app, browsers and Web Push) is not asked: it ends when
 * the Access token does (the instant a socket of that page would be closed), and when remote access is changed or turned off.
 *
 * Whether it is wanted at all is the page's rule, shared (`shared/attention.ts`); whether anybody is looking at the window
 * and whether macOS allows notifications are the app's to ask.
 */

export const SHELL_EVENTS_PATH = "/api/shell/events";
/** The same stream for the app of another Mac, through the tunnel (#656). */
export const NOTIFY_EVENTS_PATH = "/api/notify/events";

/** What the menu bar icon counts: what works and what waits (`workCounts`), and what is paused. */
export type ShellCounts = WorkCounts & { paused: number };

/**
 * What a state message says: the counts, whether the icon is wanted while the app has its window, how many unattended questions
 * are open and the finished runs nobody here has looked at (a token each, in the order they finished).
 */
export type ShellState = ShellCounts & { menuIcon: boolean; questions: number; unseen: string[] };

/** What a page on this computer in use shows (`look`): a conversation by its process, its file, or both. */
export interface Shown {
	liveId: string | null;
	file: string | null;
}

/** The counts of the processes the server lists: a paused one is frozen, and counts for neither working nor waiting. */
export function shellCounts(infos: Iterable<LiveInfo>): ShellCounts {
	const all = [...infos];
	let paused = 0;
	for (const info of all) if (!info.exited && info.pausedAt !== null) paused++;
	return { ...workCounts(all), paused };
}

/** What goes down the response, one JSON object per line. */
export type ShellMessage =
	| ({ t: "state"; epoch: string } & ShellState)
	| ({ t: "attention"; seq: number } & AttentionNotice)
	/** The built-in browser's CEF was installed, updated or its data cleared: this computer's app restarts to take it. */
	| { t: "browserRestart" };

/** How many notices are kept for a reader that comes back. */
const KEPT = 20;

/** A notice kept: what its words are made from, so that each reader gets them in its language. */
interface Kept {
	seq: number;
	kind: AttentionKind;
	liveId: string;
	file: string | null;
	named: { title?: string | null; preview?: string | null } | null;
}

/** How often a quiet response says it is alive. */
const HEARTBEAT_MS = 15_000;
/** The longest a title is waited for: a notification is worth more than its words. */
const TITLE_WAIT_MS = 1500;
/** Chunks a reader may be behind before it is let go (one that cannot keep up is not reading). */
const MAX_BEHIND = 64;
/** The longest a timer may be set for (a larger delay fires at once). */
const MAX_TIMER_MS = 2 ** 31 - 1;

export interface ShellEventsDeps {
	/** The processes the server holds now. */
	lives: () => Iterable<LiveInfo>;
	/** The saved title and first prompt of a conversation's file, null when it has none. */
	named: (file: string) => Promise<{ title?: string | null; preview?: string | null } | null>;
	/** What the person chose: notifications on, the language they saved (null: none), and the menu bar icon always shown. */
	prefs: () => { notify: boolean; lang: string | null; menuIcon: boolean };
	/** How many unattended questions are open (`QuestionStore.counts().open`); `questionsChanged` says when it may be different. */
	questions: () => number;
	/** An app began reading, or the last one stopped: what `reaches` says may be different now (the guard is told). */
	changed?: () => void;
	/** How long a quiet response waits before it says it is alive, and how long a title is waited for (tests shorten both). */
	heartbeatMs?: number;
	titleWaitMs?: number;
}

interface Reader {
	controller: ReadableStreamDefaultController<Uint8Array>;
	/** The language the app's Mac prefers: the words' language when the person saved none. */
	fallback: string | null;
	lastState: ShellState;
	/** An app of another Mac (`NOTIFY_EVENTS_PATH`): it asked, so it is sent notices whatever Settings says here. */
	remote: boolean;
	/** Ends a remote reader when the Access token it came in with does. */
	expiry?: NodeJS.Timeout;
}

const encoder = new TextEncoder();
const sameState = (a: ShellState, b: ShellState) =>
	a.working === b.working &&
	a.asking === b.asking &&
	a.paused === b.paused &&
	a.menuIcon === b.menuIcon &&
	a.questions === b.questions &&
	a.unseen.join("\n") === b.unseen.join("\n");

/** Whether a page that shows `shown` shows the conversation of process `liveId` with file `file`. */
const shows = (shown: Shown, liveId: string, file: string | null) =>
	shown.liveId === liveId || (file !== null && shown.file === file);

export class ShellEvents {
	/** What was last known of each process that runs: what the next announcement is compared with. */
	private readonly known = new Map<string, WorkFacts>();
	private readonly readers = new Set<Reader>();
	/** Notifications are built one after the other: two of one conversation (asks, then finishes) must keep their order. */
	private queue: Promise<void> = Promise.resolve();
	private heartbeat: ReturnType<typeof setInterval> | undefined;
	/** This run of the server: a reader's `since` means something only in the epoch it was read in. */
	private readonly epoch = crypto.randomUUID();
	private seq = 0;
	/** Runs that ended and nobody here has looked at since, by process: the token the state names it by, and its file. */
	private readonly unseen = new Map<string, { token: string; file: string | null }>();
	/** How many runs ended since this server began: what makes each `unseen` token new. */
	private finished = 0;
	/** What each page on this computer shows while it is in use (`look`), by its socket. */
	private readonly looking = new Map<object, Shown>();
	private recent: Kept[] = [];
	/** An app has read at least once: notices are kept from then on, also while it is not reading. */
	private recording = false;

	constructor(private readonly deps: ShellEventsDeps) {}

	/** How many apps are reading (for tests, and so that nothing is built for nobody). */
	get listeners(): number {
		return this.readers.size;
	}

	/**
	 * Whether an app is running that will tell the person when a conversation asks them something: this computer's reads, and
	 * Settings has notifications on (the notice is not built otherwise), or an app of another Mac that asked for them reads. The
	 * guard asks the person, with no page open on the conversation, only when this is so (`GuardHooks.reachable`): a question
	 * nobody is told of is no question.
	 */
	reaches(): boolean {
		return this.hasRemote() || (this.readers.size > 0 && this.deps.prefs().notify);
	}

	private hasRemote(): boolean {
		for (const reader of this.readers) if (reader.remote) return true;
		return false;
	}

	/** Whether this reader is to be sent notices: it asked for them (another Mac's app), or Settings has them on. */
	private wants(reader: Reader): boolean {
		return reader.remote || this.deps.prefs().notify;
	}

	/** End every reader of another Mac: remote access was changed or turned off, and they come back through the Access check. */
	closeRemote(): void {
		for (const reader of [...this.readers]) if (reader.remote) this.drop(reader);
	}

	/** A process was announced (see `LivePool.onAnnounce`): what it did since the last time is what the app is told. */
	note(info: LiveInfo): void {
		if (info.exited) {
			this.known.delete(info.liveId);
		} else {
			const now = factsOf(info);
			const kinds = attentionOf(this.known.get(info.liveId), now);
			this.known.set(info.liveId, now);
			if (kinds.includes("finished")) this.finishedRun(info);
			if (this.recording) {
				for (const kind of kinds) this.queue = this.queue.then(() => this.attention(info, kind)).catch(report);
			}
		}
		if (this.readers.size > 0) this.counts();
	}

	/** A run ended: unseen unless a page on this computer in use shows its conversation now. */
	private finishedRun(info: LiveInfo): void {
		this.finished++;
		for (const shown of this.looking.values()) if (shows(shown, info.liveId, info.sessionFile)) return;
		// Put last again: the tokens are in the order the runs finished.
		this.unseen.delete(info.liveId);
		this.unseen.set(info.liveId, { token: `${info.liveId}:${this.finished}`, file: info.sessionFile });
	}

	/**
	 * A page on this computer (`page`: its socket) is in use and shows `shown`, or (null) is not in use or shows no conversation,
	 * or is gone. What it shows is seen: the ✓ of its runs that finished goes.
	 */
	look(page: object, shown: Shown | null): void {
		if (shown === null || (shown.liveId === null && shown.file === null)) {
			this.looking.delete(page);
			return;
		}
		this.looking.set(page, shown);
		let changed = false;
		for (const [liveId, run] of this.unseen)
			if (shows(shown, liveId, run.file)) {
				this.unseen.delete(liveId);
				changed = true;
			}
		if (changed && this.readers.size > 0) this.counts();
	}

	/**
	 * The response of a request: the state now, the notices it missed, then whatever happens until the reader goes. `remote`: the
	 * request came through the tunnel, with the Access token that is good until `validUntil` (epoch ms).
	 */
	serve(req: Request, remote?: { validUntil: number }): Response {
		const params = new URL(req.url).searchParams;
		const fallback = params.get("lang");
		const since =
			params.get("epoch") === this.epoch && /^\d+$/.test(params.get("since") ?? "")
				? Number(params.get("since"))
				: null;
		let reader: Reader | undefined;
		const stream = new ReadableStream<Uint8Array>({
			start: (controller) => {
				const lastState = this.state();
				reader = { controller, fallback, lastState, remote: remote !== undefined };
				this.readers.add(reader);
				this.recording = true;
				if (this.readers.size === 1) this.deps.changed?.();
				this.send(reader, { t: "state", epoch: this.epoch, ...lastState });
				if (since !== null) for (const kept of this.recent) if (kept.seq > since) this.sendKept(reader, kept);
				if (remote) {
					const ending = reader;
					const left = Math.min(Math.max(0, remote.validUntil - Date.now()), MAX_TIMER_MS);
					// A server that is stopping does not wait for it.
					ending.expiry = setTimeout(() => this.drop(ending), left).unref();
				}
				// A process that was never announced has a baseline now: its next change is news, what it is now is not.
				for (const info of this.deps.lives())
					if (!info.exited && !this.known.has(info.liveId)) this.known.set(info.liveId, factsOf(info));
				this.heartbeat ??= setInterval(() => this.beat(), this.deps.heartbeatMs ?? HEARTBEAT_MS);
			},
			cancel: () => reader && this.drop(reader),
		});
		req.signal.addEventListener("abort", () => reader && this.drop(reader), { once: true });
		return new Response(stream, {
			headers: { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-accel-buffering": "no" },
		});
	}

	/** A preference changed: the menu bar icon may be wanted, or not, while the app has its window. */
	prefsChanged(): void {
		if (this.readers.size > 0) this.counts();
	}

	/** A question was filed, answered or dismissed: the number that are open may be different. */
	questionsChanged(): void {
		if (this.readers.size > 0) this.counts();
	}

	/** Asks this computer's app (not another Mac's) to restart for the built-in browser (see `ShellMessage`). */
	browserRestart(): void {
		for (const reader of [...this.readers]) if (!reader.remote) this.send(reader, { t: "browserRestart" });
	}

	private state(): ShellState {
		return {
			...shellCounts(this.deps.lives()),
			menuIcon: this.deps.prefs().menuIcon,
			questions: this.deps.questions(),
			unseen: [...this.unseen.values()].map((run) => run.token),
		};
	}

	/** Tell every reader the state, when that is not what they were last told. */
	private counts(): void {
		const now = this.state();
		for (const reader of this.readers) {
			if (sameState(reader.lastState, now)) continue;
			reader.lastState = now;
			this.send(reader, { t: "state", epoch: this.epoch, ...now });
		}
	}

	private async attention(info: LiveInfo, kind: AttentionKind): Promise<void> {
		if (!this.deps.prefs().notify && !this.hasRemote()) return;
		const file = info.sessionFile;
		const named = file ? await within(this.deps.named(file), this.deps.titleWaitMs ?? TITLE_WAIT_MS) : null;
		// Asked again after the wait: the person may have turned notifications off, and the app that asked may be gone.
		if (!this.deps.prefs().notify && !this.hasRemote()) return;
		const kept: Kept = { seq: ++this.seq, kind, liveId: info.liveId, file, named };
		this.recent.push(kept);
		if (this.recent.length > KEPT) this.recent.shift();
		for (const reader of [...this.readers]) if (this.wants(reader)) this.sendKept(reader, kept);
	}

	private sendKept(reader: Reader, kept: Kept): void {
		const lang = noticeLang(this.deps.prefs().lang, reader.fallback);
		const notice = attentionNotice(
			kept.kind,
			kept.liveId,
			kept.file,
			conversationTitle(kept.named, kept.file, lang),
			lang,
		);
		this.send(reader, { t: "attention", seq: kept.seq, ...notice });
	}

	private send(reader: Reader, message: ShellMessage): void {
		this.write(reader, encoder.encode(`${JSON.stringify(message)}\n`));
	}

	private beat(): void {
		const tick = encoder.encode("\n");
		for (const reader of [...this.readers]) this.write(reader, tick);
	}

	private write(reader: Reader, chunk: Uint8Array): void {
		try {
			reader.controller.enqueue(chunk);
			if ((reader.controller.desiredSize ?? 0) < -MAX_BEHIND) this.drop(reader);
		} catch {
			this.drop(reader);
		}
	}

	private drop(reader: Reader): void {
		if (!this.readers.delete(reader)) return;
		clearTimeout(reader.expiry);
		try {
			reader.controller.close();
		} catch {
			// Already closed by the reader going away.
		}
		if (this.readers.size === 0 && this.heartbeat) {
			clearInterval(this.heartbeat);
			this.heartbeat = undefined;
		}
		if (this.readers.size === 0) this.deps.changed?.();
	}
}

/** `promise`, or null once `ms` have passed. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
	const { promise: out, resolve } = Promise.withResolvers<T | null>();
	const timer = setTimeout(resolve, ms, null);
	promise.then(resolve, () => resolve(null)).finally(() => clearTimeout(timer));
	return out;
}

function report(e: unknown): void {
	console.error(`omp-webui: could not tell the app what a conversation needs: ${(e as Error).message}`);
}
