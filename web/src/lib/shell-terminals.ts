import { socket } from "./ws.ts";

/**
 * The panel's Terminal tab (v0.11.18 §8): one login shell per conversation, in its folder. The shell outlives the tab's
 * screen: switching tabs, panes or conversations leaves it running, and the screen drawn again later is given what it
 * printed meanwhile (the tail of it, as the server keeps for Run in Background). It ends with Restart, when the page
 * goes (the server ends a page's terminals then), or by itself (`exit`).
 *
 * After the macOS app's Run in Background the server holds the window's terminals for the window that opens again: the
 * shells among them are taken back here, each for the conversation it was opened for (`pty_open`'s `tag`).
 */

export type ShellStatus = "starting" | "running" | "exited" | "error" | "disconnected";

export interface ShellState {
	ptyId: string | null;
	status: ShellStatus;
	/** How it ended (`exited`): the exit code, or null when it was killed. */
	code?: number | null;
	/** Why it could not start (`error`). */
	error?: string;
}

interface Shell extends ShellState {
	/** What it printed, the tail of it (`RING_CHARS`): what a screen drawn again is given. */
	chunks: string[];
	chars: number;
	listeners: Set<(event: ShellEvent) => void>;
}

/** What a screen is told: output to write, a new state, or that the screen and its scrollback are to be emptied (Clear). */
export type ShellEvent = { data: string } | { state: ShellState } | { cleared: true };

/** As much as the server keeps of a terminal's output for a page that attaches again. */
const RING_CHARS = 256 * 1024;

const shells = new Map<string, Shell>();
let wired = false;
/** Shells being opened, so that two screens drawn at once open one. */
const pending = new Set<string>();
/** The held shells being taken back, once: a shell is not opened for a conversation before its held one is known. */
let restored: Promise<void> | null = null;

function stateOf(s: Shell): ShellState {
	return {
		ptyId: s.ptyId,
		status: s.status,
		...(s.code !== undefined ? { code: s.code } : {}),
		...(s.error !== undefined ? { error: s.error } : {}),
	};
}

function shellFor(key: string): Shell {
	let s = shells.get(key);
	if (!s) {
		s = { ptyId: null, status: "starting", chunks: [], chars: 0, listeners: new Set() };
		shells.set(key, s);
	}
	return s;
}

function write(s: Shell, data: string): void {
	s.chunks.push(data);
	s.chars += data.length;
	while (s.chars > RING_CHARS && s.chunks.length > 1) s.chars -= (s.chunks.shift() as string).length;
	for (const l of s.listeners) l({ data });
}

function setState(s: Shell, patch: Partial<ShellState>): void {
	Object.assign(s, patch);
	const state = stateOf(s);
	for (const l of s.listeners) l({ state });
}

function byPty(ptyId: string): Shell | undefined {
	for (const s of shells.values()) if (s.ptyId === ptyId) return s;
	return undefined;
}

function wire(): void {
	if (wired) return;
	wired = true;
	socket.on((msg) => {
		if (msg.t === "pty_data") {
			const s = byPty(msg.ptyId);
			if (s) write(s, msg.data);
		} else if (msg.t === "pty_exit") {
			const s = byPty(msg.ptyId);
			if (s) setState(s, { ptyId: null, status: "exited", code: msg.code });
		}
	});
	// The server ends a page's terminals when its socket closes: a reconnect cannot bring them back.
	socket.onStatus((connected) => {
		if (connected) return;
		for (const s of shells.values()) if (s.status === "running") setState(s, { ptyId: null, status: "disconnected" });
	});
}

/** Take back the shells the app's Run in Background held for this window (a page elsewhere is given none). */
function restore(): Promise<void> {
	restored ??= socket
		.request<{ terminals: { ptyId: string; shell?: true; tag?: string }[] }>({ t: "pty_held" })
		.then(async ({ terminals }) => {
			for (const held of terminals) {
				if (!held.shell || held.tag === undefined || shells.get(held.tag)?.ptyId) continue;
				const s = shellFor(held.tag);
				try {
					const r = await socket.request<{ replay: string; exited?: number | null }>({
						t: "pty_attach",
						ptyId: held.ptyId,
					});
					write(s, r.replay);
					if (r.exited !== undefined) setState(s, { ptyId: null, status: "exited", code: r.exited });
					else setState(s, { ptyId: held.ptyId, status: "running" });
				} catch {
					// Gone meanwhile: the conversation's shell is opened anew when its tab is shown.
					shells.delete(held.tag);
				}
			}
		})
		.catch(() => {});
	return restored;
}

/** The conversation's shell as it is now (none before its tab was first shown). */
export function shellState(key: string): ShellState | undefined {
	const s = shells.get(key);
	return s ? stateOf(s) : undefined;
}

/**
 * Follow the conversation's shell: `listener` is first given what it printed so far and its state, then what it prints
 * and each change of state. Returns the way to stop following.
 */
export function followShell(key: string, listener: (event: ShellEvent) => void): () => void {
	wire();
	const s = shellFor(key);
	const text = s.chunks.join("");
	if (text) listener({ data: text });
	listener({ state: stateOf(s) });
	s.listeners.add(listener);
	return () => {
		s.listeners.delete(listener);
	};
}

/**
 * A new conversation is named by its process until omp writes its file: its shell goes with it to the file's name, so
 * the first message does not start another shell. Nothing happens when the file already has one.
 */
export function moveShell(from: string, to: string): void {
	const s = shells.get(from);
	if (!s || shells.has(to)) return;
	shells.delete(from);
	shells.set(to, s);
}

/** Start the conversation's shell in `cwd` unless it runs or is being started; one that ended stays ended until Restart. */
export async function ensureShell(key: string, cwd: string | undefined, cols: number, rows: number): Promise<void> {
	wire();
	await restore();
	const s = shellFor(key);
	if (s.ptyId || pending.has(key) || s.status !== "starting") return;
	await open(key, cwd, cols, rows);
}

async function open(key: string, cwd: string | undefined, cols: number, rows: number): Promise<void> {
	if (pending.has(key)) return;
	pending.add(key);
	const s = shellFor(key);
	setState(s, { ptyId: null, status: "starting", code: undefined, error: undefined });
	try {
		const r = await socket.request<{ ptyId: string }>({
			t: "pty_open",
			args: [],
			cwd,
			cols,
			rows,
			shell: true,
			tag: key,
		});
		setState(s, { ptyId: r.ptyId, status: "running" });
	} catch (e) {
		setState(s, { status: "error", error: e instanceof Error ? e.message : String(e) });
	} finally {
		pending.delete(key);
	}
}

/** End the conversation's shell (if it runs) and start a new one in `cwd`; the screen keeps what the old one printed. */
export async function restartShell(key: string, cwd: string | undefined, cols: number, rows: number): Promise<void> {
	wire();
	const s = shellFor(key);
	const old = s.ptyId;
	if (old) {
		// Its exit is not this shell's any more: the new one is.
		s.ptyId = null;
		socket.post({ t: "pty_kill", ptyId: old });
	}
	write(s, "\r\n");
	await open(key, cwd, cols, rows);
}

export function shellInput(key: string, data: string): void {
	const id = shells.get(key)?.ptyId;
	if (id) socket.post({ t: "pty_input", ptyId: id, data });
}

export function shellResize(key: string, cols: number, rows: number): void {
	const id = shells.get(key)?.ptyId;
	if (id) socket.post({ t: "pty_resize", ptyId: id, cols, rows });
}

/**
 * Clear the conversation's terminal, as ⌘K does in Terminal.app: every screen following it empties its screen and scrollback
 * (the line the cursor is on stays), and neither this page when its tab is drawn again nor a page that attaches to the
 * shell later (the server keeps a tail of the output too) is given what was cleared.
 */
export function clearShell(key: string): void {
	const s = shells.get(key);
	if (!s) return;
	s.chunks = [];
	s.chars = 0;
	if (s.ptyId) socket.post({ t: "pty_clear", ptyId: s.ptyId });
	for (const l of s.listeners) l({ cleared: true });
}
