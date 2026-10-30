import { existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { childEnv } from "./env.ts";
import type { Subscriber } from "./live.ts";

/** Where a terminal runs: `cwd` when that folder exists, else the home directory. */
export function terminalDir(cwd: string | undefined): string {
	return cwd && existsSync(cwd) ? cwd : homedir();
}

/**
 * The person's login shell: what the system has for the account, else `$SHELL`, else zsh (macOS's own). Only an absolute
 * path to a program that is there counts: Bun answers `"unknown"` for the account's shell where it cannot read it.
 */
export function loginShell(): string {
	let account: string | undefined;
	try {
		account = userInfo().shell ?? undefined;
	} catch {
		// No account entry (a container's user): the environment's.
	}
	for (const shell of [account, process.env.SHELL]) if (shell?.startsWith("/") && existsSync(shell)) return shell;
	return "/bin/zsh";
}

/**
 * Whether `omp <args>` is omp's interactive shell console (`omp shell`): a shell like the login one, so a page that may not
 * open a shell may not open this either (#682). Any argument that says `shell` counts: omp's global options before the
 * command take values, and a page is not given the benefit of the doubt.
 */
export function runsOmpShell(args: readonly string[]): boolean {
	return args.includes("shell");
}

/**
 * End a terminal's process. An interactive shell ignores SIGTERM (zsh, bash): it is hung up, as closing a terminal window
 * does, and it hangs up its own jobs in turn.
 */
function end(s: { proc: Bun.Subprocess; shell: boolean }): void {
	s.proc.kill(s.shell ? "SIGHUP" : undefined);
}

/** How long a terminal that its page left on purpose (Run in Background) is kept for the page that comes back. */
export const HELD_MS = 24 * 60 * 60 * 1000;
/** How much of a terminal's output is kept for a page that attaches again (the tail of it). */
export const RING_CHARS = 256 * 1024;
/** The longest name of a conversation a shell is kept with (a file path, or a process id). */
const TAG_MAX = 4096;

interface PtySession {
	id: string;
	proc: Bun.Subprocess;
	terminal: Bun.Terminal;
	args: string[];
	cwd: string;
	/** A login shell of the panel's Terminal tab, not `omp <args>`. */
	shell: boolean;
	/** For a shell: the conversation the panel opened it for, as the page names it (given back by `held`). */
	tag?: string;
	/** Opened by a page that is not on this computer (see `killRemoteShells`). */
	remote: boolean;
	/** The page that has it; null while it is held for a page that has not come back yet. */
	owner: Subscriber | null;
	/** The tail of what it printed: what an attaching page is given to draw. */
	ring: string[];
	ringChars: number;
	/** How the process ended, once it did and nobody was there to be told. */
	exited?: number | null;
	/** Ends a held terminal that nobody came for. */
	expiry?: ReturnType<typeof setTimeout>;
}

/** A terminal that is waiting for a page (see `PtyManager.held`). */
export interface HeldTerminal {
	ptyId: string;
	args: string[];
	cwd: string;
	/** Present for a login shell of the panel's Terminal tab. */
	shell?: true;
	/** The conversation a shell was opened for (see `PtySession.tag`). */
	tag?: string;
	/** Present once its process ended: the exit code, or null when it was killed. */
	exited?: number | null;
}

/**
 * Runs `omp <args>` inside a real pseudo-terminal so every CLI subcommand,
 * including fullscreen interactive ones (git, shell, play…), works from the
 * browser through xterm.js; or, for the panel's Terminal tab, the person's login shell (`open`'s `shell`).
 *
 * A page that goes away kills its terminals, except when the macOS app told the server it is going to run in the background
 * (`expectDetach`): that page's terminals are then held, with the tail of their output, for the page of the window that opens
 * again (`held`, `attach`), and ended after `HELD_MS` or with the server.
 */
export class PtyManager {
	private sessions = new Map<string, PtySession>();
	private seq = 0;
	/** Until when a page that closes is a window put away on purpose (see `expectDetach`). */
	private detachUntil = 0;

	constructor(
		private bin: string,
		private readonly heldMs = HELD_MS,
	) {}

	/** omp is somewhere else now (it was installed while the server ran). */
	setBin(bin: string): void {
		this.bin = bin;
	}

	/**
	 * The app is about to close its window for Run in Background: the pages that close in the next `forMs` keep their
	 * terminals. A window the app closes any other way (it never does) or a page that closes later is as before.
	 */
	expectDetach(forMs = 10_000, now = Date.now()): void {
		this.detachUntil = now + forMs;
	}

	/** The app opened its window again (before it closed, or within the time `expectDetach` gave): a page that closes next is a browser tab's. */
	cancelDetach(): void {
		this.detachUntil = 0;
	}

	/**
	 * Start a terminal for `owner`: `omp <args>`, or with `shell` the person's login shell (`-l`, so their profile is
	 * read) and no arguments, with `tag` naming the conversation it is for. `remote` says the page is not on this
	 * computer: its shells end when shells for remote pages are turned off (`killRemoteShells`).
	 */
	open(
		owner: Subscriber,
		args: string[],
		cwd: string | undefined,
		cols: number,
		rows: number,
		opts: { shell?: boolean; remote?: boolean; tag?: unknown } = {},
	): string {
		// From the page's socket: what is not a list of strings is refused before a terminal is made for it.
		if (!Array.isArray(args) || !args.every((a) => typeof a === "string"))
			throw new Error("args must be a list of strings");
		const shell = opts.shell === true;
		if (shell && args.length > 0) throw new Error("a shell takes no arguments");
		const tag = shell && typeof opts.tag === "string" && opts.tag.length <= TAG_MAX ? opts.tag : undefined;
		const id = `P${++this.seq}`;
		const dir = terminalDir(cwd);
		const dec = new TextDecoder();
		// Filled in once the session exists: the first output cannot come before it.
		let session: PtySession | undefined;
		const terminal = new Bun.Terminal({
			cols: Math.max(20, cols | 0),
			rows: Math.max(5, rows | 0),
			data: (_t, data) => {
				const text = dec.decode(data, { stream: true });
				if (!session) return;
				this.remember(session, text);
				session.owner?.send({ t: "pty_data", ptyId: id, data: text });
			},
		});
		let proc: Bun.Subprocess;
		try {
			proc = Bun.spawn(shell ? [loginShell(), "-l"] : [this.bin, ...args], {
				cwd: dir,
				terminal,
				env: childEnv({ TERM: "xterm-256color", COLORTERM: "truecolor" }),
			});
		} catch (e) {
			// No process will ever end to close it: its descriptors would stay open for as long as the server runs.
			terminal.close();
			throw e;
		}
		session = {
			id,
			proc,
			terminal,
			args,
			cwd: dir,
			shell,
			...(tag !== undefined ? { tag } : {}),
			remote: opts.remote === true,
			owner,
			ring: [],
			ringChars: 0,
		};
		const made = session;
		this.sessions.set(id, made);
		void proc.exited.then((code) => {
			// Let the PTY flush its last bytes before announcing the exit.
			setTimeout(() => {
				terminal.close();
				if (made.owner) {
					made.owner.send({ t: "pty_exit", ptyId: id, code });
					this.sessions.delete(id);
					return;
				}
				// Held for a page that has not come back: it is told when it does.
				made.exited = code;
			}, 50);
		});
		return id;
	}

	private remember(session: PtySession, text: string): void {
		session.ring.push(text);
		session.ringChars += text.length;
		while (session.ringChars > RING_CHARS && session.ring.length > 1)
			session.ringChars -= (session.ring.shift() as string).length;
	}

	/** Only the page that has the terminal (it opened or attached it) types into it, sizes it or ends it (#682). */
	private owned(owner: Subscriber, id: string): PtySession | undefined {
		const session = this.sessions.get(id);
		return session && session.owner === owner ? session : undefined;
	}

	input(owner: Subscriber, id: string, data: string): void {
		this.owned(owner, id)?.terminal.write(data);
	}

	resize(owner: Subscriber, id: string, cols: number, rows: number): void {
		this.owned(owner, id)?.terminal.resize(Math.max(20, cols | 0), Math.max(5, rows | 0));
	}

	kill(owner: Subscriber, id: string): void {
		const session = this.owned(owner, id);
		if (session) end(session);
	}

	/** Forget what the terminal printed: a page that attaches later is given none of it (the Terminal tab's Clear). */
	clear(owner: Subscriber, id: string): void {
		const session = this.owned(owner, id);
		if (!session) return;
		session.ring = [];
		session.ringChars = 0;
	}

	private forget(session: PtySession): void {
		clearTimeout(session.expiry);
		this.sessions.delete(session.id);
	}

	/**
	 * A disconnected browser's terminals are killed, unless the app announced this close (`expectDetach`) and `keep` says the
	 * page may leave its terminals (a page of this computer): they are held for a page that comes back, and ended after
	 * `heldMs` if none does. The notice is one close's: the first page that leaves terminals uses it up (a pop-out that
	 * closes before it has none to leave, and does not).
	 */
	dropOwner(owner: Subscriber, keep = false, now = Date.now()): void {
		const hold = keep && now < this.detachUntil;
		let held = false;
		for (const s of this.sessions.values()) {
			if (s.owner !== owner) continue;
			if (!hold) {
				end(s);
				continue;
			}
			held = true;
			s.owner = null;
			s.expiry = setTimeout(() => {
				end(s);
				this.forget(s);
			}, this.heldMs);
			s.expiry.unref?.();
		}
		if (held) this.detachUntil = 0;
	}

	/** The terminals that wait for a page. */
	held(): HeldTerminal[] {
		return [...this.sessions.values()]
			.filter((s) => s.owner === null)
			.map((s) => ({
				ptyId: s.id,
				args: s.args,
				cwd: s.cwd,
				...(s.shell ? { shell: true as const } : {}),
				...(s.tag !== undefined ? { tag: s.tag } : {}),
				...(s.exited !== undefined ? { exited: s.exited } : {}),
			}));
	}

	/** Shells for remote pages were turned off: the shells remote pages have open (`omp shell` among them) end now. */
	killRemoteShells(): void {
		for (const s of this.sessions.values()) if ((s.shell || runsOmpShell(s.args)) && s.remote) end(s);
	}

	/**
	 * A page takes over a held terminal: what it printed (the tail of it) to draw, and how it ended if it did. From here the
	 * page is told what it prints, and its input and size are its own. Null for a terminal that is not held (it is gone, or
	 * another page has it).
	 */
	attach(owner: Subscriber, id: string): { replay: string; exited?: number | null } | null {
		const s = this.sessions.get(id);
		if (!s || s.owner !== null) return null;
		clearTimeout(s.expiry);
		const replay = s.ring.join("");
		if (s.exited !== undefined) {
			// It ended while nobody was there: the page is told now, and nothing is left of it.
			this.sessions.delete(id);
			return { replay, exited: s.exited };
		}
		s.owner = owner;
		return { replay };
	}

	killAll(): void {
		for (const s of this.sessions.values()) {
			clearTimeout(s.expiry);
			end(s);
		}
	}
}
