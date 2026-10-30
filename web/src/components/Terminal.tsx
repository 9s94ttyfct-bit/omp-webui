import type { Terminal as XTerm } from "@xterm/xterm";
import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import "../i18n/later.ts";
import { type MessageKey, t as translate, useT } from "../i18n/index.ts";
import { errorText } from "../lib/error-text.ts";
import { socket } from "../lib/ws.ts";
import { bufferText, makeXterm } from "../lib/xterm-view.ts";

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
 */
export function Terminal({
	args,
	cwd,
	attach,
	onExit,
}: {
	args: string[];
	cwd?: string;
	attach?: string;
	onExit?: (code: number | null) => void;
}) {
	const t = useT();
	const host = useRef<HTMLDivElement>(null);
	const termRef = useRef<XTerm | null>(null);
	const [status, setStatus] = useState<{ key: keyof typeof STATUS_KEYS; code?: string }>({ key: "starting" });
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		const el = host.current;
		if (!el) return;
		let ptyId: string | null = null;
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
			if (msg.t === "pty_data" && msg.ptyId === ptyId) term.write(msg.data);
			if (msg.t === "pty_exit" && msg.ptyId === ptyId) finished(msg.code);
		});
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
			: socket.request<{ ptyId: string }>({ t: "pty_open", args, cwd, cols: term.cols, rows: term.rows });
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
				term.focus();
			})
			.catch((e) => {
				term.write(`\x1b[31m${errorText(e)}\x1b[0m\r\n`);
				setStatus({ key: "error" });
			});
		const input = term.onData((data) => ptyId && socket.post({ t: "pty_input", ptyId, data }));
		return () => {
			disposed = true;
			input.dispose();
			off();
			offStatus();
			if (ptyId) socket.post({ t: "pty_kill", ptyId });
			stop();
			termRef.current = null;
		};
	}, [args, cwd, attach, onExit]);
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
						void navigator.clipboard.writeText(bufferText(term)).then(() => {
							setCopied(true);
							setTimeout(() => setCopied(false), 1200);
						});
					}}
				>
					{copied ? <Check size={12} /> : <Copy size={12} />} {t("pages.termCopyOutput")}
				</button>
			</div>
			<div ref={host} className="min-h-0 flex-1 p-2" data-testid="terminal" />
		</div>
	);
}
