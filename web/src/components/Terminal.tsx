import type { Terminal as XTerm } from "@xterm/xterm";
import { Check, Copy, Eye, EyeOff } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import "../i18n/later.ts";
import { type MessageKey, t as translate, useT } from "../i18n/index.ts";
import { stripAnsi } from "../lib/ansi.ts";
import { useCopy } from "../lib/clipboard.ts";
import { errorText } from "../lib/error-text.ts";
import { socket } from "../lib/ws.ts";
import { bufferText, makeXterm } from "../lib/xterm-view.ts";
import { Button } from "./ui.tsx";

const STATUS_KEYS = {
	starting: "pages.termStarting",
	running: "pages.termRunning",
	exited: "pages.termExited",
	error: "pages.termError",
	disconnected: "pages.termDisconnected",
} as const satisfies Record<string, MessageKey>;

/**
 * xterm.js bound to a server-side PTY running `omp <args>`: a new one, or, with `attach`, one the app's Run in Background held
 * for this window (`pty_held`), which is given the tail of what it printed and goes on from there.
 *
 * With `lines`, `omp <args>` runs without a terminal (`pty_open`'s `lines`) and is answered a line at a time from a field
 * under it: `omp login` asks for keys in plain text and, in a terminal, shows them as they are typed. What omp asks says
 * nothing structured about which answer is a secret, so every answer is hidden as it is typed, and shown as `********`
 * after it, unless the person shows it (the eye button).
 */
export function Terminal({
	args,
	cwd,
	attach,
	onExit,
	lines = false,
}: {
	args: string[];
	cwd?: string;
	attach?: string;
	onExit?: (code: number | null) => void;
	lines?: boolean;
}) {
	const t = useT();
	const host = useRef<HTMLDivElement>(null);
	const termRef = useRef<XTerm | null>(null);
	const [status, setStatus] = useState<{ key: keyof typeof STATUS_KEYS; code?: string }>({ key: "starting" });
	const { done: copied, copy } = useCopy();
	/** For `lines`: the line omp printed last and has not ended (its question), and how an answer is sent. */
	const [question, setQuestion] = useState("");
	const [answer, setAnswer] = useState("");
	const [shown, setShown] = useState(false);
	const send = useRef<((line: string, hidden: boolean) => void) | null>(null);
	const field = useRef<HTMLInputElement>(null);
	// The only thing to do in it is to answer omp's question: the field has the keyboard once omp runs.
	useEffect(() => {
		if (lines && status.key === "running") field.current?.focus();
	}, [lines, status.key]);
	useEffect(() => {
		const el = host.current;
		if (!el) return;
		let ptyId: string | null = null;
		let tail = "";
		const { term, stop } = makeXterm(el, (cols, rows) => {
			if (ptyId) socket.post({ t: "pty_resize", ptyId, cols, rows });
		});
		termRef.current = term;
		let disposed = false;
		// The app's own lines are set apart in italics, not dimmed: dim text on the terminal's ground is about 3:1.
		const finished = (code: number | null) => {
			term.write(
				`\r\n\x1b[3m${
					code !== null ? translate("pages.termProcessExitedCode", { code }) : translate("pages.termProcessExited")
				}\x1b[0m\r\n`,
			);
			setStatus({ key: "exited", code: code === null ? "" : String(code) });
			onExit?.(code);
		};
		const off = socket.on((msg) => {
			if (msg.t === "pty_data" && msg.ptyId === ptyId) {
				term.write(msg.data);
				if (lines) {
					tail = (tail + stripAnsi(msg.data)).split("\n").at(-1) ?? "";
					setQuestion(tail.trim());
				}
			}
			if (msg.t === "pty_exit" && msg.ptyId === ptyId) finished(msg.code);
		});
		send.current = (line, hidden) => {
			if (!ptyId) return;
			socket.post({ t: "pty_input", ptyId, data: `${line}\n` });
			// Nothing typed comes back from a process without a terminal: the answer is shown here, a hidden one as stars.
			term.write(`${hidden ? "********" : line}\r\n`);
			tail = "";
			setQuestion("");
		};
		// The server stops a socket's terminals when it closes; a reconnect cannot revive them.
		const offStatus = socket.onStatus((connected) => {
			if (connected || !ptyId) return;
			ptyId = null;
			term.write(`\r\n\x1b[3m${translate("pages.termConnectionLost")}\x1b[0m\r\n`);
			setStatus({ key: "disconnected" });
		});
		// A new terminal answers its id; one taken over answers what it printed (and how it ended, if it did).
		const taken: Promise<{ ptyId: string; replay?: string; exited?: number | null }> = attach
			? socket
					.request<{ replay: string; exited?: number | null }>({ t: "pty_attach", ptyId: attach })
					.then((r) => ({ ptyId: attach, ...r }))
			: socket.request<{ ptyId: string }>({
					t: "pty_open",
					args,
					cwd,
					cols: term.cols,
					rows: term.rows,
					...(lines ? { lines: true } : {}),
				});
		taken
			.then((r) => {
				if (disposed) return socket.post({ t: "pty_kill", ptyId: r.ptyId });
				if (r.replay !== undefined) {
					term.write(r.replay);
					// It ended while no page was there: the page is told now, and there is nothing to type into.
					if (r.exited !== undefined) return finished(r.exited);
					socket.post({ t: "pty_resize", ptyId: r.ptyId, cols: term.cols, rows: term.rows });
				}
				ptyId = r.ptyId;
				setStatus({ key: "running" });
				if (!lines) term.focus();
			})
			.catch((e) => {
				term.write(`\x1b[31m${errorText(e)}\x1b[0m\r\n`);
				setStatus({ key: "error" });
			});
		// Answered from the field under it (`lines`): keys typed into the terminal itself would go nowhere.
		if (lines) term.options.disableStdin = true;
		const input = lines ? null : term.onData((data) => ptyId && socket.post({ t: "pty_input", ptyId, data }));
		return () => {
			disposed = true;
			send.current = null;
			input?.dispose();
			off();
			offStatus();
			if (ptyId) socket.post({ t: "pty_kill", ptyId });
			stop();
			termRef.current = null;
		};
	}, [args, cwd, attach, onExit, lines]);
	return (
		<div className="flex h-full flex-col overflow-hidden rounded-xl border border-border bg-code">
			<div className="flex items-center gap-2 border-b border-border px-3 py-1.5 font-mono text-xs text-muted">
				<span className="truncate">$ omp {args.join(" ")}</span>
				<span className="ml-auto" data-testid="terminal-status">
					{status.key === "exited"
						? t(STATUS_KEYS.exited, { code: status.code ?? "" }).trim()
						: t(STATUS_KEYS[status.key])}
				</span>
				<button
					type="button"
					data-testid="terminal-copy"
					className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-hover hover:text-fg"
					onClick={() => {
						const term = termRef.current;
						if (!term) return;
						copy(bufferText(term));
					}}
				>
					{copied ? <Check size={12} /> : <Copy size={12} />} {t("pages.termCopyOutput")}
				</button>
			</div>
			<div ref={host} className="min-h-0 flex-1 p-2" data-testid="terminal" />
			{lines ? (
				<form
					className="flex gap-2 border-t border-border p-2"
					data-testid="terminal-answer"
					onSubmit={(e) => {
						e.preventDefault();
						send.current?.(answer, !shown);
						setAnswer("");
						setShown(false);
					}}
				>
					<input
						ref={field}
						aria-label={question || t("panel.reqResponse")}
						className="min-w-0 flex-1 rounded-md border border-border bg-bg px-2 py-1 font-mono text-sm"
						value={answer}
						disabled={status.key !== "running"}
						onChange={(e) => setAnswer(e.target.value)}
						// Hidden as it is typed, and the browser neither offers nor keeps it.
						{...(shown
							? { type: "text", autoComplete: "off" }
							: { type: "password", autoComplete: "off", spellCheck: false, "data-secret": "" })}
					/>
					<Button
						size="sm"
						variant="ghost"
						aria-label={t(shown ? "pages.termHideAnswer" : "pages.termShowAnswer")}
						aria-pressed={shown}
						data-testid="terminal-answer-show"
						onClick={() => {
							setShown((s) => !s);
							field.current?.focus();
						}}
					>
						{shown ? <EyeOff size={13} /> : <Eye size={13} />}
					</Button>
					<Button size="sm" variant="primary" type="submit" disabled={status.key !== "running"}>
						{t("panel.reqSubmit")}
					</Button>
				</form>
			) : null}
		</div>
	);
}
