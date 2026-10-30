import * as Menu from "@radix-ui/react-dropdown-menu";
import type { QuickPrompt } from "@shared/quick-prompts.ts";
import { Hand, Settings2, Zap } from "lucide-react";
import { useEffect, useRef } from "react";
import { registerStrings, useT } from "../i18n/index.ts";
import { en } from "../i18n/quick-prompts.ts";
import { agentFullOpen } from "../lib/agent-full.ts";
import { offerQuickPrompts, quickPromptSender } from "../lib/quick-prompt-bridge.ts";
import { promptName, quickPrompts, useQuickPrompts } from "../lib/quick-prompts.ts";
import { showSettingsCard } from "../lib/shortcut-view.ts";
import { quickPromptFor } from "../lib/shortcuts.ts";
import { setSoftStop } from "../lib/soft-stop.ts";
import { useApp } from "../store/app.ts";
import type { ImageAttachment, SendMode } from "./Composer.tsx";
import { useComposerMore } from "./ComposerMore.tsx";

// This chunk carries its own English strings: the first page does not (see `registerStrings`).
registerStrings("quickPrompts", en);

const itemCls =
	"flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-hover data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50";

let keysListening = false;

/**
 * A quick prompt's own key (#661, set in Settings › Keyboard shortcuts) sends it to the conversation on screen, as the
 * menu would: one listener for the page, whichever menu offers the sender now (`quick-prompt-bridge.ts`).
 */
function listenForKeys(): void {
	if (keysListening) return;
	keysListening = true;
	window.addEventListener("keydown", (e) => {
		if (e.defaultPrevented || e.repeat || agentFullOpen()) return;
		const id = quickPromptFor(e);
		const send = id === null ? null : quickPromptSender();
		const prompt = send ? quickPrompts().find((p) => p.id === id) : undefined;
		if (!send || !prompt) return;
		e.preventDefault();
		send(prompt);
	});
}

/**
 * The quick prompts beside the message box (#659): one click sends a prompt, as it says it is sent while the agent works
 * (steer now, or after the turn); when idle it is an ordinary message. A prompt that stops the session after (the
 * built-in Soft stop, #658) also asks the server to end the process when that turn ends. A chunk of its own, with its
 * strings: the list is edited in Settings.
 */
export default function QuickPromptMenu({
	liveId,
	streaming,
	onSend,
	ensureLive,
	hidden = false,
}: {
	liveId: string | null;
	/** A turn runs: a prompt is sent the way it says (steer or follow-up). */
	streaming: boolean;
	/** The conversation's own send (ChatView), which starts omp first when none runs. */
	onSend: (text: string, images: ImageAttachment[], mode: SendMode) => Promise<boolean>;
	/** The conversation's process, started when none runs (for the soft stop that follows the prompt). */
	ensureLive: () => Promise<string>;
	/**
	 * Something is typed in the message box: its button is not shown (its icon is Steer's, which then sits beside it),
	 * while its shortcuts and the command palette's prompts keep working.
	 */
	hidden?: boolean;
}) {
	const t = useT();
	const toast = useApp((s) => s.toast);
	const prompts = useQuickPrompts();
	// In the composer's "⋯" panel on a narrow screen: the button says what it is, and the panel closes once a prompt is chosen.
	const more = useComposerMore();
	const trigger = useRef<HTMLButtonElement>(null);

	const send = async (p: QuickPrompt) => {
		const name = promptName(p, t);
		const sent = await onSend(p.text, [], streaming ? p.mode : "normal").catch((e: unknown) => {
			toast("error", t("quickPrompts.sendFailed", { name, error: e instanceof Error ? e.message : String(e) }));
			return false;
		});
		if (!sent) return;
		if (p.stopAfter) {
			try {
				await setSoftStop(liveId ?? (await ensureLive()), true);
			} catch (e) {
				toast("error", t("quickPrompts.softStopFailed", { name, error: e instanceof Error ? e.message : String(e) }));
				return;
			}
		}
		toast("success", t("quickPrompts.sent", { name }));
	};
	// The command palette sends through the conversation on screen: this one, while it is shown.
	const sendRef = useRef(send);
	sendRef.current = send;
	useEffect(() => {
		listenForKeys();
		return offerQuickPrompts((p) => void sendRef.current(p));
	}, []);

	if (hidden) return null;
	return (
		<Menu.Root>
			<Menu.Trigger asChild>
				<button
					ref={trigger}
					type="button"
					data-testid="quick-prompts"
					aria-label={t("quickPrompts.menuLabel")}
					title={t("quickPrompts.menuLabel")}
					className="inline-flex h-8 w-8 shrink-0 items-center justify-center gap-1.5 rounded-lg text-muted hover:bg-hover hover:text-fg composer-more:w-auto composer-more:px-2 composer-more:text-xs"
				>
					<Zap size={14} />
					{/* A bare bolt in the row, with its name as a tooltip; in the "⋯" panel, where every control says what it is, its name. */}
					<span className="hidden composer-more:inline">{t("quickPrompts.menuLabel")}</span>
				</button>
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Content
					align="start"
					sideOffset={6}
					collisionPadding={12}
					data-testid="quick-prompts-menu"
					className="z-50 w-80 max-w-[calc(100vw-1.5rem)] rounded-xl border border-border bg-surface p-1 shadow-2xl"
					// A menu opened from the panel closes with it (a prompt chosen): its button is hidden then, so focus goes to "⋯".
					// Closed otherwise (Escape), the panel stays open and its button takes the focus back, as Radix does.
					onCloseAutoFocus={(e) => {
						if (!trigger.current?.getClientRects().length && more?.focusToggle()) e.preventDefault();
					}}
				>
					<Menu.Label className="px-2 py-1 text-xs uppercase text-faint">{t("quickPrompts.menuLabel")}</Menu.Label>
					{prompts.length === 0 ? (
						<p className="px-2 py-1.5 text-sm text-muted">{t("quickPrompts.menuEmpty")}</p>
					) : null}
					{prompts.map((p) => (
						<Menu.Item
							key={p.id}
							className={itemCls}
							data-testid="quick-prompt-item"
							data-id={p.id}
							onSelect={() => {
								more?.done();
								void send(p);
							}}
						>
							{p.stopAfter ? (
								<Hand size={14} className="mt-0.5 shrink-0" aria-hidden />
							) : (
								<Zap size={14} className="mt-0.5 shrink-0" aria-hidden />
							)}
							<span className="flex min-w-0 flex-1 flex-col">
								<span className="truncate">{promptName(p, t)}</span>
								<span className="text-xs text-muted">
									{p.mode === "steer" ? t("quickPrompts.modeSteer") : t("quickPrompts.modeFollowUp")}
									{p.stopAfter ? ` · ${t("quickPrompts.stopsAfter")}` : ""}
								</span>
							</span>
						</Menu.Item>
					))}
					<Menu.Separator className="my-1 h-px bg-border" />
					<Menu.Item
						className={itemCls}
						data-testid="quick-prompts-manage"
						onSelect={() => {
							more?.done();
							showSettingsCard('[data-testid="quick-prompts-settings"]');
						}}
					>
						<Settings2 size={14} className="mt-0.5 shrink-0" aria-hidden /> {t("quickPrompts.menuManage")}
					</Menu.Item>
				</Menu.Content>
			</Menu.Portal>
		</Menu.Root>
	);
}
