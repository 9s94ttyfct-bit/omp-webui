import { REMOTE_SHELL_OFF } from "@shared/remote.ts";
import type { Terminal as XTerm } from "@xterm/xterm";
import { Check, Copy, Eraser, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import "../i18n/later.ts";
import { t as translate, useT } from "../i18n/index.ts";
import { isApple } from "../lib/platform.ts";
import {
	clearShell,
	ensureShell,
	followShell,
	moveShell,
	restartShell,
	type ShellState,
	shellInput,
	shellResize,
} from "../lib/shell-terminals.ts";
import { bufferText, makeXterm } from "../lib/xterm-view.ts";
import { useApp } from "../store/app.ts";
import { Button } from "./ui.tsx";

const STATUS_KEYS = {
	starting: "pages.termStarting",
	running: "pages.termRunning",
	exited: "pages.termExited",
	error: "pages.termError",
	disconnected: "pages.termDisconnected",
} as const;

/** What the screen says when the shell ended, and why it could not start (a remote page's refusal in the page's words). */
function endLine(state: ShellState): string | null {
	if (state.status === "exited")
		return state.code !== null && state.code !== undefined
			? translate("pages.termProcessExitedCode", { code: state.code })
			: translate("pages.termProcessExited");
	if (state.status === "disconnected") return translate("pages.termConnectionLost");
	if (state.status === "error")
		return state.error === REMOTE_SHELL_OFF ? translate("panel.terminalRemoteOff") : (state.error ?? "");
	return null;
}

/**
 * The side panel's Terminal tab (v0.11.18 §8): a login shell in the conversation's folder, one per conversation
 * (`lib/shell-terminals.ts` keeps it while the tab is not shown). A page that is not on this computer may open one only
 * while Settings › Remote access allows it; the server enforces that, this only says so.
 */
export function ShellTab({
	conversation,
	liveKey,
	cwd,
}: {
	/** The conversation, as the shell is kept by: its file, or `liveKey` until it has one. */
	conversation: string;
	/** Its process's name for it (`live:<id>`), under which the shell was started before the file was written. */
	liveKey: string | null;
	cwd: string | undefined;
}) {
	const t = useT();
	const allowed = useApp((s) => s.meta?.shell !== false);
	const host = useRef<HTMLDivElement>(null);
	const termRef = useRef<XTerm | null>(null);
	const [state, setState] = useState<ShellState>({ ptyId: null, status: "starting" });
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		const el = host.current;
		if (!el || !allowed) return;
		if (liveKey && liveKey !== conversation) moveShell(liveKey, conversation);
		const { term, stop } = makeXterm(el, (cols, rows) => shellResize(conversation, cols, rows));
		termRef.current = term;
		let last: ShellState["status"] | null = null;
		const unfollow = followShell(conversation, (event) => {
			if ("data" in event) {
				term.write(event.data);
				return;
			}
			if ("cleared" in event) {
				term.clear();
				return;
			}
			setState(event.state);
			// An end is written once, when it happens (or when the screen is drawn for one that already ended).
			if (event.state.status !== last) {
				const line = endLine(event.state);
				// In italics, not dimmed (as `Terminal`'s own lines): dim text on the terminal's ground is about 3:1.
				if (line) term.write(`\r\n\x1b[3m${line}\x1b[0m\r\n`);
				if (event.state.status === "running") term.focus();
			}
			last = event.state.status;
		});
		// ⌘K, as in Terminal.app. It is the Terminal's while the screen has the keyboard: the page's own ⌘K (search) is not.
		term.attachCustomKeyEventHandler((e) => {
			if (e.type !== "keydown" || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.key.toLowerCase() !== "k")
				return true;
			e.preventDefault();
			e.stopPropagation();
			clearShell(conversation);
			return false;
		});
		const input = term.onData((data) => shellInput(conversation, data));
		void ensureShell(conversation, cwd, term.cols, term.rows);
		return () => {
			input.dispose();
			unfollow();
			stop();
			termRef.current = null;
		};
	}, [conversation, liveKey, cwd, allowed]);
	if (!allowed)
		return (
			<p className="p-3 text-xs text-muted" data-testid="shell-tab-off">
				{t("panel.terminalRemoteOff")}
			</p>
		);
	const restart = () => {
		const term = termRef.current;
		void restartShell(conversation, cwd, term?.cols ?? 80, term?.rows ?? 24);
	};
	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-code" data-testid="shell-tab">
			{/* Wraps: on a phone the buttons go to a second row rather than past the panel's edge. */}
			<div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-border px-2 py-1 font-mono text-xs text-muted">
				<span className="min-w-0 flex-1 basis-24 truncate" title={cwd}>
					{cwd ?? "~"}
				</span>
				<span data-testid="shell-status">
					{state.status === "exited"
						? t(STATUS_KEYS.exited, { code: state.code ?? "" }).trim()
						: t(STATUS_KEYS[state.status])}
				</span>
				<Button size="sm" variant="ghost" data-testid="shell-restart" onClick={restart}>
					<RotateCcw size={12} /> {t("panel.terminalRestart")}
				</Button>
				<Button
					size="sm"
					variant="ghost"
					data-testid="shell-clear"
					title={isApple ? `${t("panel.terminalClearTip")} (⌘K)` : t("panel.terminalClearTip")}
					onClick={() => {
						clearShell(conversation);
						termRef.current?.focus();
					}}
				>
					<Eraser size={12} /> {t("panel.terminalClear")}
				</Button>
				<Button
					size="sm"
					variant="ghost"
					data-testid="shell-copy"
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
				</Button>
			</div>
			<div ref={host} className="min-h-0 flex-1 p-1.5" data-testid="shell-screen" />
		</div>
	);
}
