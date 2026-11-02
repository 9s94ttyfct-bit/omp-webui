import type { ConsoleEntry, PageInfo } from "@shared/browser-protocol.ts";
import { Eraser, Send } from "lucide-react";
import { useEffect, useRef } from "react";
import { type MessageKey, useT } from "../i18n/index.ts";
import { insertIntoComposer } from "../lib/composer-bridge.ts";
import { useApp } from "../store/app.ts";
import { clearConsole, useScreen } from "../store/browser-screen.ts";
import { Button, cx, IconButton } from "./ui.tsx";

const NO_ENTRIES: readonly ConsoleEntry[] = [];

const LEVEL_KEYS: Record<ConsoleEntry["level"], MessageKey> = {
	log: "browser.levelLog",
	info: "browser.levelInfo",
	warn: "browser.levelWarn",
	error: "browser.levelError",
};

const LEVEL_TONES: Record<ConsoleEntry["level"], string> = {
	log: "text-muted",
	info: "text-accent",
	warn: "text-warning",
	error: "text-danger",
};

/** What "Send to agent" puts into the message box: words for the agent, the same in every language of the page. */
export const consoleErrorText = (url: string, text: string): string => `Console error on ${url}: ${text}`;

/**
 * The console strip under a page: what the page logged and the requests that failed, read from that page's own CDP session
 * by the server (a conversation never sees another conversation's page's output). An error can be put into the message box
 * for the agent.
 */
export function BrowserConsole({ page }: { page: PageInfo }) {
	const t = useT();
	const toast = useApp((s) => s.toast);
	const entries = useScreen((s) => s.console[page.targetId] ?? NO_ENTRIES);
	const list = useRef<HTMLOListElement>(null);
	// The newest entry in view, as a console keeps it.
	useEffect(() => {
		const el = list.current;
		if (el && entries.length) el.scrollTop = el.scrollHeight;
	}, [entries]);
	return (
		<section
			className="flex max-h-36 min-h-0 shrink-0 flex-col border-t border-border bg-surface text-xs"
			aria-label={t("browser.consoleLabel")}
			data-testid="browser-console"
		>
			<div className="flex items-center gap-2 px-2 py-1">
				<span className="flex-1 font-semibold text-muted">{t("browser.consoleLabel")}</span>
				<IconButton
					size="xs"
					label={t("browser.consoleClear")}
					onClick={() => clearConsole(page.targetId)}
					disabled={!entries.length}
					data-testid="browser-console-clear"
				>
					<Eraser size={13} />
				</IconButton>
			</div>
			{entries.length ? (
				<ol ref={list} className="min-h-0 overflow-y-auto font-mono">
					{entries.map((entry, i) => (
						<li
							// Entries are only ever added at the end (or all cleared): the place is the identity.
							// biome-ignore lint/suspicious/noArrayIndexKey: see above.
							key={i}
							className="flex items-start gap-2 border-t border-border/60 px-2 py-1"
							data-testid="browser-console-entry"
							data-level={entry.level}
							data-source={entry.source}
						>
							<span className={cx("shrink-0 font-sans font-medium", LEVEL_TONES[entry.level])}>
								{entry.source === "network" ? t("browser.consoleNetwork") : t(LEVEL_KEYS[entry.level])}
							</span>
							<span className="min-w-0 flex-1 break-words whitespace-pre-wrap">
								{entry.text}
								{entry.url ? <span className="block truncate text-faint">{entry.url}</span> : null}
							</span>
							{entry.level === "error" ? (
								<Button
									size="sm"
									variant="ghost"
									className="h-6 shrink-0 px-1.5"
									title={t("browser.consoleSendTitle")}
									data-testid="browser-console-send"
									onClick={() => {
										const sent = insertIntoComposer(consoleErrorText(entry.url ?? page.url, entry.text), true);
										toast(sent ? "info" : "error", t(sent ? "browser.consoleSent" : "browser.consoleNoComposer"));
									}}
								>
									<Send size={12} /> {t("browser.consoleSend")}
								</Button>
							) : null}
						</li>
					))}
				</ol>
			) : (
				<p className="px-2 pb-1.5 text-faint">{t("browser.consoleEmpty")}</p>
			)}
		</section>
	);
}
