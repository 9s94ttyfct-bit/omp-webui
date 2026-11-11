import * as Popover from "@radix-ui/react-popover";
import type { MacListing } from "@shared/macs.ts";
import { Server } from "lucide-react";
import { useState } from "react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { ownerPage, sessionActions } from "../lib/api.ts";
import { errorText } from "../lib/error-text.ts";
import { fmtClock } from "../lib/format.ts";
import { signedInUntil } from "../lib/macs.ts";
import { choosing } from "../lib/new-chat-remote.ts";
import { useApp } from "../store/app.ts";
import { cx } from "./ui.tsx";

const NONE: readonly string[] = [];

/**
 * "Remote computers" for one conversation (`SessionControls`' panel): which of the saved Macs (`Meta.macs`) its agent may run
 * shell commands on, with the `remote_run` tool this server serves it (`shared/remote-run.ts`), each with whether this server
 * holds its Cloudflare Access sign-in, which the tool needs. A tick sends the whole new list (`POST /api/remote-run/live`);
 * what is ticked is the conversation's own (`LiveInfo.remoteComputers`, which every page is told). Only the person's own page
 * may change it, and not while the conversation's server tools are held for something else
 * (`remoteComputersUnavailable`): the panel says why. Nothing is shown while no Mac is saved.
 */
export default function SessionRemote({ liveId }: { liveId: string }) {
	return <RemoteComputers liveId={liveId} className="mt-4 border-t border-border pt-3" />;
}

/**
 * New chat's control for the same list (in its settings bar, right after the guard's): an icon button that says which
 * computers the warm-up process has, and opens the list in a popover. A tick acts on that process; a new project's
 * conversation, started as the message is sent, is given the same (`NewChat`'s `startProject`). A warm-up New chat starts
 * later (another folder or options) starts with none, as every new conversation does. Not shown while no Mac is saved.
 */
export function RemotePicker({ liveId }: { liveId: string }) {
	const t = useT();
	const macs = useApp((s) => s.meta?.macs);
	const info = useApp((s) => s.lives[liveId]?.info);
	if (!info || !macs || macs.length === 0) return null;
	const have = info.remoteComputers ?? NONE;
	const names = macs.filter((m) => have.includes(m.id)).map((m) => m.name);
	const on = names.length > 0;
	const label =
		names.length === 0
			? t("panel.remotePickerOff")
			: names.length === 1
				? t("panel.remotePickerOne", { name: names[0] })
				: t("panel.remotePickerMany", { n: names.length });
	return (
		<Popover.Root>
			<Popover.Trigger asChild>
				<button
					type="button"
					data-testid="remote-picker"
					data-on={on}
					title={t("panel.remotePickerTitle")}
					className={cx(
						"inline-flex h-8 max-w-48 items-center gap-1.5 rounded-lg px-2 text-xs composer-narrow:w-8 composer-narrow:justify-center composer-narrow:px-0",
						// On is a shape as well as a tint (a ring), as the advisor's and unattended switches.
						on ? "bg-accent-soft text-accent ring-1 ring-accent/60" : "text-muted hover:bg-hover hover:text-fg",
					)}
				>
					<Server size={14} className="shrink-0" />
					<span className="truncate composer-narrow:sr-only">{label}</span>
				</button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					align="start"
					side="top"
					sideOffset={6}
					collisionPadding={8}
					className="z-50 max-h-[var(--radix-popover-content-available-height)] w-96 max-w-[calc(100vw-1rem)] overflow-y-auto overscroll-contain rounded-2xl border border-border bg-surface p-4 shadow-2xl"
					data-testid="remote-picker-panel"
				>
					<RemoteComputers liveId={liveId} carried />
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}

/**
 * The list itself: the title, what the tools do, a tick per saved Mac, and why it cannot be changed when it cannot.
 * `carried`: New chat's warm-up process, whose picks a new project's conversation is given (`carryRemote`).
 */
function RemoteComputers({ liveId, className, carried }: { liveId: string; className?: string; carried?: boolean }) {
	const t = useT();
	const macs = useApp((s) => s.meta?.macs);
	const owner = useApp((s) => ownerPage(s.meta));
	const info = useApp((s) => s.lives[liveId]?.info);
	/** The list asked for while the server has not answered. */
	const [asked, setAsked] = useState<string[] | null>(null);
	/** The server's answer, until the conversation's own record (`have`, the array it was then) is replaced. */
	const [answer, setAnswer] = useState<{ ids: string[]; over: readonly string[] } | null>(null);
	const [failed, setFailed] = useState<string | null>(null);
	if (!info || !macs || macs.length === 0) return null;
	const have = info.remoteComputers ?? NONE;
	const chosen = asked ?? (answer?.over === have ? answer.ids : have);
	const why = !owner
		? t("panel.controlsRemoteNotOwner")
		: info.remoteComputersUnavailable === "serverTools"
			? t("panel.controlsRemoteServerTools")
			: null;
	const disabled = why !== null || asked !== null;

	const toggle = async (mac: MacListing, on: boolean) => {
		// The Macs list's order, so the list sent is the same whatever order the ticks came in.
		const next = macs.filter((m) => (m.id === mac.id ? on : chosen.includes(m.id))).map((m) => m.id);
		setAsked(next);
		setFailed(null);
		try {
			const asking = sessionActions.setRemoteComputers(liveId, next).then((r) => r.macIds);
			// A new project's conversation started meanwhile, or before the process's own record says it, is given what this
			// settled on (`carryRemote`): the server's word on the page's socket may come after this answer.
			if (carried) choosing.set(liveId, asking);
			const macIds = await asking;
			setAnswer({ ids: macIds, over: have });
		} catch (e) {
			choosing.delete(liveId);
			setFailed(t("panel.controlsRemoteFailed", { error: errorText(e) }));
		} finally {
			setAsked(null);
		}
	};

	return (
		<section className={className} data-testid="session-remote" aria-label={t("panel.controlsRemoteTitle")}>
			<div className="text-sm font-semibold">{t("panel.controlsRemoteTitle")}</div>
			<p className="mt-1 text-xs text-muted" data-testid="session-remote-help">
				{t("panel.controlsRemoteHelp")}
			</p>
			<fieldset className="mt-1.5 space-y-1" disabled={disabled} aria-busy={asked !== null || undefined}>
				<legend className="sr-only">{t("panel.controlsRemoteTitle")}</legend>
				{macs.map((mac) => {
					const until = signedInUntil(mac);
					return (
						<label
							key={mac.id}
							className={cx(
								"flex items-start gap-2 rounded-md px-1.5 py-1 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
								disabled ? "cursor-not-allowed opacity-70" : "cursor-pointer hover:bg-hover",
							)}
							data-testid="session-remote-computer"
							data-mac={mac.id}
							data-signed-in={until !== null || undefined}
						>
							<input
								type="checkbox"
								className="mt-0.5 accent-[var(--accent)]"
								checked={chosen.includes(mac.id)}
								onChange={(e) => void toggle(mac, e.target.checked)}
							/>
							<span className="min-w-0 flex-1">
								<span className="block truncate">
									<span className="font-medium">{mac.name}</span> <span className="text-xs text-muted">{mac.host}</span>
								</span>
								<span className={cx("block text-xs", until === null ? "text-warning" : "text-muted")}>
									{until === null
										? t("panel.controlsRemoteNotSignedIn")
										: t("panel.controlsRemoteSignedIn", { when: fmtClock(until) })}
								</span>
							</span>
						</label>
					);
				})}
			</fieldset>
			{why ? (
				<p className="mt-1.5 text-xs text-muted" data-testid="session-remote-unavailable">
					{why}
				</p>
			) : null}
			{failed ? (
				<p className="mt-1.5 break-words text-xs text-danger" role="alert" data-testid="session-remote-failed">
					{failed}
				</p>
			) : null}
		</section>
	);
}
