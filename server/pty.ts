import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { isolatedPathPrefix } from "../shared/isolated-env.ts";
import { childEnv } from "./env.ts";
import { envFor } from "./isolated-env.ts";
import type { Subscriber } from "./live.ts";
import { platform } from "./platform/index.ts";

/** The folder of the zsh startup files `keepPathInFront` gives an isolated folder's Terminal tab; made once, private. */
let zdotdir: string | null = null;

/** zsh's startup files, each running the person's own of that name and then going on with ours; the last puts the prefix back. */
function wrapperZdotdir(): string {
	if (zdotdir && existsSync(zdotdir)) return zdotdir;
	const dir = mkdtempSync(join(tmpdir(), "ompw-zdotdir-"));
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const run = (name: string) =>
		[
			"# omp-webui: the person's own startup file, then back to these (server/pty.ts `keepPathInFront`).",
			'ZDOTDIR="$OMPW_USER_ZDOTDIR"',
			`[[ -r "$ZDOTDIR/${name}" ]] && source "$ZDOTDIR/${name}"`,
			'OMPW_USER_ZDOTDIR="$ZDOTDIR"',
		].join("\n");
	for (const name of [".zshenv", ".zprofile", ".zshrc"])
		writeFileSync(join(dir, name), `${run(name)}\nZDOTDIR="$OMPW_WRAP_ZDOTDIR"\n`);
	// The last file of a login shell: the person's, then the isolated folders in front again, and the person's ZDOTDIR kept.
	writeFileSync(
		join(dir, ".zlogin"),
		`${run(".zlogin")}\npath=(\${(s.:.)OMPW_ISOLATED_PATH} $path)\ntypeset -U path\nunset OMPW_ISOLATED_PATH OMPW_WRAP_ZDOTDIR OMPW_USER_ZDOTDIR\n`,
	);
	zdotdir = dir;
	return dir;
}

/** The startup file `keepPathInFront` gives an isolated folder's bash Terminal tab; made once, private. */
let bashRc: string | null = null;

/**
 * bash's startup file for an isolated folder: what a login bash reads (`/etc/profile`, then the first of
 * `~/.bash_profile`, `~/.bash_login`, `~/.profile`), then the prefix in front, so that nothing those files do (a
 * `PROMPT_COMMAND` of their own, a `PATH` set whole) can undo it. A shell started with it is not a login shell, so
 * `logout` ends it as `exit` does and `~/.bash_logout` still runs when it ends.
 */
function wrapperBashRc(): string {
	if (bashRc && existsSync(bashRc)) return bashRc;
	const dir = mkdtempSync(join(tmpdir(), "ompw-bashrc-"));
	const file = join(dir, "bashrc");
	writeFileSync(
		file,
		[
			"# omp-webui: a login shell's startup files, then the isolated folders in front (server/pty.ts `keepPathInFront`).",
			"[ -r /etc/profile ] && . /etc/profile",
			'if [ -r "$HOME/.bash_profile" ]; then . "$HOME/.bash_profile"',
			'elif [ -r "$HOME/.bash_login" ]; then . "$HOME/.bash_login"',
			'elif [ -r "$HOME/.profile" ]; then . "$HOME/.profile"; fi',
			'PATH="$OMPW_ISOLATED_PATH:$PATH"',
			"unset OMPW_ISOLATED_PATH",
			'logout() { exit "$@"; }',
			// An EXIT trap of the person's own stays theirs.
			'[ -z "$(trap -p EXIT)" ] && trap \'[ -r "$HOME/.bash_logout" ] && . "$HOME/.bash_logout"\' EXIT',
			"",
		].join("\n"),
		{ mode: 0o600 },
	);
	bashRc = file;
	return file;
}

/**
 * How a Terminal tab's login shell `shell` is started so that the isolated folder `root`'s `PATH` prefix is still in front
 * after the startup files: a login shell runs `path_helper` (macOS `/etc/zprofile`, `/etc/profile`), which moves it behind
 * the system's. zsh: startup files that run the person's own and put it back last; bash: a startup file that runs what a
 * login bash runs and then puts it back (`argv` replaces the login shell's). Other shells get the variables only. The
 * person's own files are never changed.
 */
export function keepPathInFront(shell: string, root: string): { env: Record<string, string>; argv?: string[] } {
	const prefix = isolatedPathPrefix(root).join(":");
	switch (basename(shell)) {
		case "zsh": {
			const wrap = wrapperZdotdir();
			return {
				env: {
					ZDOTDIR: wrap,
					OMPW_WRAP_ZDOTDIR: wrap,
					OMPW_USER_ZDOTDIR: process.env.ZDOTDIR ?? homedir(),
					OMPW_ISOLATED_PATH: prefix,
				},
			};
		}
		case "bash":
			return { env: { OMPW_ISOLATED_PATH: prefix }, argv: [shell, "--noprofile", "--rcfile", wrapperBashRc(), "-i"] };
		default:
			return { env: {} };
	}
}

/** Where a terminal runs: `cwd` when that folder exists, else the home directory. */
export function terminalDir(cwd: string | undefined): string {
	return cwd && existsSync(cwd) ? cwd : homedir();
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
 * does (`Platform.shell.hangup`; Windows terminates it). The terminal's process runs in a session of its own, which it
 * leads (`open`), and the whole process group it leads is hung up, not the shell alone: a command it runs in the
 * foreground ends with it, as when a terminal window closes. What the shell put in a group of its own and did not hang up
 * (`setsid`, a `nohup` job) is left, as a terminal window closing leaves it.
 */
function end(s: { proc: Bun.Subprocess; shell: boolean }): void {
	const hangup = s.shell ? platform.shell.hangup : undefined;
	if (hangup === undefined) s.proc.kill();
	else platform.proc.signalChild(s.proc, hangup);
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
	/** Where its input goes and its size is set: the pseudo-terminal, or for `lines` the process's stdin. */
	io: { write(data: string): void; resize(cols: number, rows: number): void; close(): void };
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
	 * computer: its shells end when shells for remote pages are turned off (`killRemoteShells`). With `lines`, `omp
	 * <args>` runs without a terminal, on pipes: it reads its answers a line at a time and nothing typed is echoed back
	 * (`omp login` asks for keys in plain text: in a terminal it shows them as they are typed).
	 */
	open(
		owner: Subscriber,
		args: string[],
		cwd: string | undefined,
		cols: number,
		rows: number,
		opts: { shell?: boolean; remote?: boolean; tag?: unknown; lines?: boolean } = {},
	): string {
		// From the page's socket: what is not a list of strings is refused before a terminal is made for it.
		if (!Array.isArray(args) || !args.every((a) => typeof a === "string"))
			throw new Error("args must be a list of strings");
		const shell = opts.shell === true;
		if (shell && args.length > 0) throw new Error("a shell takes no arguments");
		const lines = opts.lines === true;
		if (shell && lines) throw new Error("a shell needs a terminal");
		const tag = shell && typeof opts.tag === "string" && opts.tag.length <= TAG_MAX ? opts.tag : undefined;
		const id = `P${++this.seq}`;
		const dir = terminalDir(cwd);
		const dec = new TextDecoder();
		// Filled in once the session exists: the first output cannot come before it.
		let session: PtySession | undefined;
		const output = (text: string) => {
			if (!session || !text) return;
			this.remember(session, text);
			session.owner?.send({ t: "pty_data", ptyId: id, data: text });
		};
		const terminal = lines
			? null
			: new Bun.Terminal({
					cols: Math.max(20, cols | 0),
					rows: Math.max(5, rows | 0),
					data: (_t, data) => output(dec.decode(data, { stream: true })),
				});
		let proc: Bun.Subprocess;
		let io: PtySession["io"];
		let streams: Promise<unknown> = Promise.resolve();
		try {
			const isolation = envFor(dir, process.env.PATH ?? "");
			const login = platform.shell.interactive();
			// A login shell's startup files move a `PATH` prefix behind the system's (`path_helper`): it is put back after them.
			const inFront = isolation && shell ? keepPathInFront(login[0] ?? "", isolation.root) : null;
			const env = childEnv({
				...isolation?.env,
				...inFront?.env,
				TERM: "xterm-256color",
				COLORTERM: "truecolor",
			});
			const argv = shell ? (inFront?.argv ?? login) : [this.bin, ...args];
			if (terminal) {
				proc = Bun.spawn(argv, {
					cwd: dir,
					terminal,
					env,
					// A session of its own, with this terminal as its controlling terminal: without it the process stays in the
					// server's process group, with no terminal of its own, so a shell has no job control and hangs up its group
					// when it is hung up (bash): the server itself. Windows has no sessions (and `detached` means something else).
					detached: platform.id !== "win32",
				});
				io = {
					write: (data) => terminal.write(data),
					resize: (c, r) => terminal.resize(c, r),
					close: () => terminal.close(),
				};
			} else {
				const piped = Bun.spawn(argv, { cwd: dir, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
				proc = piped;
				// Each stream decoded on its own: a character split across two reads of one must not meet the other's bytes.
				// A pipe's lines end in a newline alone; the page draws them as a terminal does.
				const pump = async (stream: ReadableStream<Uint8Array>) => {
					const d = new TextDecoder();
					for await (const chunk of stream) output(d.decode(chunk, { stream: true }).replace(/\r?\n/g, "\r\n"));
				};
				streams = Promise.all([pump(piped.stdout), pump(piped.stderr)]).catch(() => {});
				io = {
					write: (data) => {
						try {
							// What a terminal's Enter sends is a carriage return; on a pipe a line ends with a newline.
							piped.stdin.write(data.replace(/\r\n?/g, "\n"));
							piped.stdin.flush();
						} catch {
							// It ended: what was typed has nobody to read it.
						}
					},
					resize: () => {},
					close: () => {
						try {
							piped.stdin.end();
						} catch {
							// Already closed.
						}
					},
				};
			}
		} catch (e) {
			// No process will ever end to close it: its descriptors would stay open for as long as the server runs.
			terminal?.close();
			throw e;
		}
		session = {
			id,
			proc,
			io,
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
		void Promise.all([proc.exited, streams]).then(([code]) => {
			// Let the PTY flush its last bytes before announcing the exit.
			setTimeout(() => {
				made.io.close();
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
		this.owned(owner, id)?.io.write(data);
	}

	resize(owner: Subscriber, id: string, cols: number, rows: number): void {
		this.owned(owner, id)?.io.resize(Math.max(20, cols | 0), Math.max(5, rows | 0));
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

	/** The process ids of the terminals' shells (and programs) still running. */
	pids(): Set<number> {
		const out = new Set<number>();
		for (const s of this.sessions.values()) if (s.exited === undefined) out.add(s.proc.pid);
		return out;
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
