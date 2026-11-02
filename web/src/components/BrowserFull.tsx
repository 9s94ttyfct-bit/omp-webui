import * as Dialog from "@radix-ui/react-dialog";
import { Globe } from "lucide-react";
import { useEffect, useRef } from "react";
import { useShallow } from "zustand/react/shallow";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { markFullView } from "../lib/agent-full.ts";
import { useAnnounceBrowserWindow } from "../lib/browser-window.ts";
import { exitFull, takeFullOpener, viewedConversation } from "../store/agents.ts";
import { dismissOverlays, useApp } from "../store/app.ts";
import { BrowserTab } from "./BrowserTab.tsx";
import { Empty, ignoreToastRegion } from "./ui.tsx";

/**
 * A conversation's built-in browser, full screen: over the conversation (the page stays mounted underneath, hidden, and
 * its side panel's Browser tab steps aside), or, in a window popped out for it, as the whole page. The route says which
 * conversation (`#/s/<file>/browser`), so reload and Back/Forward keep it.
 */
export function BrowserFull({ popOut }: { popOut: boolean }) {
	const t = useT();
	const content = useRef<HTMLDivElement>(null);
	const { file } = useApp(useShallow(viewedConversation));
	useAnnounceBrowserWindow(popOut ? file : null);
	// The popped-out window's title says what it shows (the macOS window takes its title from the page).
	useEffect(() => {
		if (!popOut) return;
		const base = document.title;
		document.title = `${t("panel.tabBrowser")} · ${base}`;
		return () => {
			document.title = base;
		};
	}, [popOut, t]);
	// See SubagentFull: the page under the full screen is hidden, not unmounted.
	useEffect(() => (popOut ? undefined : markFullView()), [popOut]);
	// The Mac app's native page has the keyboard and swallows Escape before the web UI sees it: the app says so instead
	// (`BrowserBridge.watchEscape`), and the full screen ends as it does for the key itself. The page gets the key too.
	useEffect(() => {
		if (popOut) return;
		const onEscape = () => {
			if (!dismissOverlays()) exitFull();
		};
		window.addEventListener("ompw-native-escape", onEscape);
		return () => window.removeEventListener("ompw-native-escape", onEscape);
	}, [popOut]);

	const body = file ? (
		<BrowserTab owner={file} place={popOut ? "window" : "full"} />
	) : (
		<Empty icon={<Globe size={22} />} title={t("panel.tabBrowser")}>
			{t("browser.noConversation")}
		</Empty>
	);

	if (popOut) {
		return (
			<div className="flex h-full min-h-0 flex-col bg-bg" data-testid="browser-full" data-mode="popout">
				{body}
			</div>
		);
	}
	return (
		<Dialog.Root open onOpenChange={(open) => !open && exitFull()}>
			<Dialog.Portal>
				<Dialog.Content
					ref={content}
					aria-describedby={undefined}
					aria-modal="true"
					className="fade-in fixed inset-0 z-40 flex flex-col bg-bg pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] outline-none"
					data-testid="browser-full"
					data-mode="window"
					{...ignoreToastRegion}
					onOpenAutoFocus={(e) => {
						e.preventDefault();
						content.current?.focus();
					}}
					onEscapeKeyDown={(e) => {
						if (e.isComposing) e.preventDefault();
						else if (dismissOverlays()) e.preventDefault();
						else ignoreToastRegion.onEscapeKeyDown(e);
					}}
					onCloseAutoFocus={(e) => {
						const opener = takeFullOpener();
						if (!opener) return;
						e.preventDefault();
						opener.focus();
					}}
				>
					<Dialog.Title className="sr-only">{t("browser.fullTitle")}</Dialog.Title>
					{body}
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
