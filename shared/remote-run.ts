import { isRecord } from "./guards.ts";
import type { HostToolDefinition } from "./guided-goal.ts";

/**
 * Run commands on another computer (docs/superpowers/specs/2026-11-10-remote-run-design.md): a conversation on this computer
 * that the person gave some of their saved computers (the Macs list) gets one tool, `remote_run`, which this server answers
 * itself (`server/remote-run/`). It opens the remote computer's own page WebSocket through its tunnel, with the Cloudflare
 * Access sign-in the macOS app handed over, starts a login shell there as the remote computer's Terminal tab does, and types
 * one line into it: the command, between two markers the line itself cannot print.
 *
 * This module is the contract both sides read: the line that is typed (`remoteRunLine`), how what the terminal sends back is
 * read (`parseRemoteRun`), the tool as omp is told of it, and its arguments as they are checked. Pure: no I/O.
 */

/** The tool's name. */
export const REMOTE_RUN_TOOL = "remote_run";

/** How long a command may run, in seconds: what it gets unless it asks, and the most it may ask for. */
export const REMOTE_RUN_TIMEOUT_S = { default: 120, max: 3600 } as const;

/** How much of what a command printed the agent is given: the last 64 KB (in characters), marked when more was cut. */
export const REMOTE_RUN_OUTPUT_TAIL = 65536;

/** A string as a shell reads it in single quotes: a quote inside is ended, escaped and begun again. */
const quoted = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

/**
 * Typed first, on a line of its own: the shell stops keeping a history file before the line that carries the command is
 * entered (`unset HISTFILE`; bash also stops recording, `set +o history`; zsh switches to a fresh history list that is never
 * saved, `fc -p`; each shell's error at the other's word is thrown away). A leading space is no guarantee (only shells set
 * to ignore such lines skip them), and a shell that writes each line as it is entered (bash's `history -a` in
 * `PROMPT_COMMAND`, zsh's INC_APPEND_HISTORY or SHARE_HISTORY) would keep the command (in base64) before the kill. This line
 * itself may be kept: it holds nothing of the call.
 */
export const REMOTE_RUN_HISTORY_OFF = " unset HISTFILE; set +o history 2>/dev/null; fc -p 2>/dev/null\r";

/**
 * The line that runs the command, typed into the remote login shell after `REMOTE_RUN_HISTORY_OFF`, ending in a carriage
 * return (the Enter key). It starts with a space too (kept out of the history of a shell that ignores such lines, even where
 * that first line could not turn it off), and:
 *
 *   - prints `B<nonce>X` on a line of its own: where the command's output begins;
 *   - in a subshell whose input is `/dev/null` (the command gets no input, and an `exit` in it ends the command, not the
 *     shell), enters `cwd` (`cd --`, so a folder that does not exist fails with the shell's own error and a non-zero status,
 *     and never runs the command in another one) and then runs the command, carried in base64 and handed to `eval` as it
 *     was given: any quote, `$`, heredoc, line break or non-ASCII text in it reaches the shell untouched, and nothing of it
 *     is typed (a line break typed would be Enter);
 *   - prints `E<nonce>X <exit status>` on a line of its own, after a line break of its own (the command's output need not
 *     end with one: `parseRemoteRun` takes that one away again).
 *
 * The markers are written `"B<nonce>""X"` in the line: the terminal echoes what is typed as it was typed, so the echo never
 * holds `B<nonce>X`, which only the shell's `printf` prints. `cwd` must be one line (see `parseRemoteRunArgs`).
 */
export function remoteRunLine(command: string, cwd: string | null, nonce: string): string {
	const begin = `"B${nonce}""X"`;
	const end = `"E${nonce}""X"`;
	// Base64 of the UTF-8 bytes, without Node's `Buffer`: the pages read this module too.
	let bytes = "";
	for (const byte of new TextEncoder().encode(command)) bytes += String.fromCharCode(byte);
	const run = `eval "$(printf %s '${btoa(bytes)}' | base64 -d)"`;
	const body = cwd === null ? run : `cd -- ${quoted(cwd)} && ${run}`;
	return ` printf '%s\\n' ${begin}; ( ${body} ) </dev/null; printf '\\n%s %s\\n' ${end} "$?"\r`;
}

/**
 * The terminal's escapes: CSI (`ESC [ … final`), OSC (`ESC ] … BEL` or `ESC ] … ESC \`), the other string sequences
 * (DCS, SOS, PM, APC up to `ESC \`), the two-character ones (`ESC (B`, `ESC =`, `ESC 7`), and the 8-bit CSI.
 */
const ESCAPES =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: the escapes are control characters.
	/\u001b\[[0-?]*[ -/]*[@-~]|\u009b[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[PX^_][^\u001b]*(?:\u001b\\)?|\u001b[ -/]*[0-~]?/g;

/** What a terminal sent, as text: no escapes, no carriage returns. */
function plain(raw: string): string {
	return raw.replace(ESCAPES, "").replaceAll("\r", "");
}

/**
 * Read what the remote terminal has sent so far (`raw`, everything since the shell started) for the line typed with `nonce`.
 * `output` is what the command printed (escapes and carriage returns taken out), from the begin marker's line on; `done` once
 * the end marker's whole line has come, with the exit status in `exitCode`. Before that, the output so far (a command cut
 * short by its time limit gives back what it printed), and no status.
 */
export function parseRemoteRun(raw: string, nonce: string): { done: boolean; output: string; exitCode: number | null } {
	const text = plain(raw);
	const begin = `B${nonce}X\n`;
	const at = text.lastIndexOf(begin);
	if (at < 0) return { done: false, output: "", exitCode: null };
	const after = text.slice(at + begin.length);
	const endMark = `\nE${nonce}X`;
	const ending = after.indexOf(endMark);
	if (ending < 0) return { done: false, output: after, exitCode: null };
	const output = after.slice(0, ending);
	const status = /^ (\d+)\n/.exec(after.slice(ending + endMark.length));
	if (!status) return { done: false, output, exitCode: null };
	return { done: true, output, exitCode: Number(status[1]) };
}

/** The last `max` characters of `text`, and whether anything was cut; never half of a character made of two. */
export function tailOutput(text: string, max: number = REMOTE_RUN_OUTPUT_TAIL): { text: string; cut: boolean } {
	if (text.length <= max) return { text, cut: false };
	let start = text.length - max;
	// A low surrogate whose high one was cut away: the character is left out whole.
	const unit = text.charCodeAt(start);
	if (unit >= 0xdc00 && unit <= 0xdfff) start++;
	return { text: text.slice(start), cut: true };
}

/**
 * The tool as omp is told of it, for a conversation given `computers` (their names, as the Macs list holds them). The names
 * are the only computers it may name (`enum`), and its description lists them. `essential`: in the model's tool list from its
 * next turn on, not one it has to search for.
 */
export function remoteRunTool(computers: readonly string[]): HostToolDefinition {
	return {
		name: REMOTE_RUN_TOOL,
		label: "Run on a remote computer",
		loadMode: "essential",
		description:
			`Run a shell command on one of the person's other computers, through its own remote connection: ${computers.map((c) => JSON.stringify(c)).join(", ")}. ` +
			"Each call starts a fresh login shell there (nothing carries over from one call to the next: no folder, no variable), runs the command with no input (no prompts, no editors, no interactive programs), and returns its exit code and output (the last 64 KB). " +
			"Paths and ~ are that computer's, not this one's. " +
			`It is stopped after timeout seconds (default ${REMOTE_RUN_TIMEOUT_S.default}, at most ${REMOTE_RUN_TIMEOUT_S.max}): do not start a command that never ends (tail -f, a server in the foreground); run it in the background with its output in a file instead.`,
		parameters: {
			type: "object",
			properties: {
				computer: {
					type: "string",
					enum: [...computers],
					description: "The computer to run it on, by its name.",
				},
				command: {
					type: "string",
					description: "The shell command, run as given (several lines, pipes, heredocs and quotes are fine).",
				},
				cwd: {
					type: "string",
					description:
						"The folder on that computer to run it in; absent: its home folder. The call fails if it does not exist.",
				},
				timeout: {
					type: "integer",
					minimum: 1,
					maximum: REMOTE_RUN_TIMEOUT_S.max,
					description: `Seconds before the command is stopped (default ${REMOTE_RUN_TIMEOUT_S.default}).`,
				},
			},
			required: ["computer", "command"],
			additionalProperties: false,
		},
	};
}

/** A call's arguments as they were checked. */
export interface RemoteRunArgs {
	computer: string;
	command: string;
	/** The folder to run in; null: the login shell's own (the home folder). */
	cwd: string | null;
	timeoutS: number;
}

/**
 * The arguments of a call as the model sent them, checked against `computers` (the names the conversation was given), or why
 * they are refused, in words the model can act on. The time limit is held to 1 … `REMOTE_RUN_TIMEOUT_S.max`.
 */
export function parseRemoteRunArgs(args: unknown, computers: readonly string[]): RemoteRunArgs | { error: string } {
	if (!isRecord(args)) return { error: "Give the computer and the command." };
	const names = computers.map((c) => JSON.stringify(c)).join(", ");
	if (typeof args.computer !== "string" || !computers.includes(args.computer))
		return { error: `computer must be one of the computers this conversation was given: ${names}.` };
	if (typeof args.command !== "string" || args.command.trim() === "")
		return { error: "command must be a shell command." };
	let cwd: string | null = null;
	if (args.cwd !== undefined && args.cwd !== null) {
		if (typeof args.cwd !== "string") return { error: "cwd must be a folder's path." };
		// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused.
		if (/[\u0000-\u001f\u007f]/.test(args.cwd)) return { error: "cwd must be one line, with no control characters." };
		cwd = args.cwd === "" ? null : args.cwd;
	}
	let timeoutS: number = REMOTE_RUN_TIMEOUT_S.default;
	if (args.timeout !== undefined && args.timeout !== null) {
		if (typeof args.timeout !== "number" || Number.isNaN(args.timeout))
			return { error: `timeout must be a number of seconds, at most ${REMOTE_RUN_TIMEOUT_S.max}.` };
		timeoutS = Math.min(REMOTE_RUN_TIMEOUT_S.max, Math.max(1, Math.round(args.timeout)));
	}
	return { computer: args.computer, command: args.command, cwd, timeoutS };
}
