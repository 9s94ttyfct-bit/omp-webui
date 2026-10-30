import * as Menu from "@radix-ui/react-dropdown-menu";
import { ChevronDown, RotateCw, Square } from "lucide-react";
import { useMemo, useState } from "react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { agentRows, subagentsForToolCall } from "../lib/subagents.ts";
import { viewedConversation } from "../store/agents.ts";
import { stopSubagent, useApp } from "../store/app.ts";
import { continueSubagent } from "../store/subagent-actions.ts";
import { Button, cx, IconButton } from "./ui.tsx";

/** What the two halves of the split Stop share: one control, so one outline and one disabled look. */
const SPLIT_PART =
	"inline-flex h-7 items-center justify-center border border-border text-xs font-medium text-fg transition-colors hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50";

/**
 * Stops one running subagent (omp's `cancel_subagent`): it ends as aborted and whatever else its task call started goes
 * on. `icon` for a row of the Agents list, `button` for the header of a subagent's live view, `link` on a task card.
 * It waits for omp's answer, so a second click cannot stop a subagent twice.
 *
 * `continuable` (the `button` only): the subagent waits to retry in a way the page can end for the person. The button
 * becomes a split one: the main part still only stops, and its menu has "Stop and continue" (omp's `cancel_subagent`,
 * then the main agent is asked to continue it, see `continueSubagent`), which the two used to be two buttons side by side.
 * Both parts stay disabled until omp has answered, so a second click cannot ask twice.
 */
export function StopSubagent({
	liveId,
	id,
	name,
	kind,
	continuable = false,
}: {
	liveId: string;
	id: string;
	name: string;
	kind: "icon" | "button" | "link";
	continuable?: boolean;
}) {
	const t = useT();
	const [busy, setBusy] = useState(false);
	const label = t("panel.agentStop", { name });
	const stop = () => {
		setBusy(true);
		void stopSubagent(liveId, id).finally(() => setBusy(false));
	};
	if (kind === "icon") {
		return (
			<IconButton label={label} size="sm" disabled={busy} onClick={stop} data-testid="subagent-stop">
				<Square size={13} fill="currentColor" />
			</IconButton>
		);
	}
	if (kind === "button" && continuable) {
		return (
			<div className="flex shrink-0 items-center" data-testid="subagent-stop-split">
				<button
					type="button"
					disabled={busy}
					onClick={stop}
					aria-label={label}
					data-testid="subagent-stop"
					className={cx(SPLIT_PART, "gap-1.5 rounded-l-lg px-2.5")}
				>
					<Square size={12} fill="currentColor" aria-hidden />
					{t("panel.agentStopShort")}
				</button>
				<Menu.Root>
					<Menu.Trigger asChild>
						<button
							type="button"
							disabled={busy}
							aria-label={t("panel.agentStopMore")}
							title={t("panel.agentStopMore")}
							data-testid="subagent-stop-more"
							className={cx(SPLIT_PART, "-ml-px w-7 rounded-r-lg data-[state=open]:bg-hover")}
						>
							<ChevronDown size={13} aria-hidden />
						</button>
					</Menu.Trigger>
					<Menu.Portal>
						<Menu.Content
							align="end"
							sideOffset={6}
							collisionPadding={8}
							className="z-50 w-72 max-w-[calc(100vw-1rem)] rounded-xl border border-border bg-surface p-1 shadow-2xl"
						>
							<Menu.Item
								data-testid="subagent-continue"
								onSelect={() => {
									setBusy(true);
									void continueSubagent(liveId, id, name).finally(() => setBusy(false));
								}}
								className="cursor-pointer rounded-lg px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-hover"
							>
								<span className="flex items-center gap-2 font-medium">
									<RotateCw size={13} aria-hidden />
									{t("panel.agentContinue")}
								</span>
								<span className="mt-1 block text-xs text-muted" data-testid="subagent-continue-hint">
									{t("chat.agentContinueHint")}
								</span>
							</Menu.Item>
						</Menu.Content>
					</Menu.Portal>
				</Menu.Root>
			</div>
		);
	}
	if (kind === "button") {
		return (
			<Button
				size="sm"
				variant="ghost"
				disabled={busy}
				onClick={stop}
				aria-label={label}
				data-testid="subagent-stop"
				className="shrink-0"
			>
				<Square size={12} fill="currentColor" />
				{t("panel.agentStopShort")}
			</Button>
		);
	}
	return (
		<button
			type="button"
			className="inline-flex min-h-6 items-center gap-1 text-xs text-muted hover:text-danger disabled:opacity-40"
			disabled={busy}
			onClick={stop}
			data-testid="subagent-stop"
			data-agent-id={id}
		>
			<Square size={11} fill="currentColor" aria-hidden />
			{label}
		</button>
	);
}

/**
 * A task card's Stop controls: one for each subagent the call started that still runs, in the conversation on screen.
 * Nothing once they are over (their state is in the Agents tab), or when no process runs them.
 */
export function CallStops({ toolCallId, args, owner }: { toolCallId: string; args: unknown; owner?: string }) {
	const subagents = useApp((s) => viewedConversation(s).live?.subagents);
	const liveId = useApp((s) => {
		const live = viewedConversation(s).live;
		return live && !live.info.exited ? live.info.liveId : null;
	});
	const running = useMemo(
		() => subagentsForToolCall(agentRows(undefined, subagents), toolCallId, args, owner).filter((r) => r.running),
		[subagents, toolCallId, args, owner],
	);
	if (!liveId) return null;
	return running.map((r) => <StopSubagent key={r.id} liveId={liveId} id={r.id} name={r.name} kind="link" />);
}
