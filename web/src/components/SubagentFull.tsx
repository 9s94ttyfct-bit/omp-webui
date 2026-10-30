import * as Dialog from "@radix-ui/react-dialog";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { Bot, Check, ChevronDown, ChevronUp, ExternalLink, Maximize, Minimize, Minimize2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { fieldKeepsKey, neighbour, positionOf } from "../lib/agent-full.ts";
import { useWindowFullScreen } from "../lib/fullscreen.ts";
import { matches, typingInField, useShortcutLabel, withKeys } from "../lib/shortcuts.ts";
import { type AgentRow, parentId } from "../lib/subagents.ts";
import {
	exitAgentFull,
	popOutAgent,
	showAgentFull,
	takeFullOpener,
	useAgentList,
	viewedConversation,
} from "../store/agents.ts";
import { dismissOverlays, useApp } from "../store/app.ts";
import type { LiveState } from "../store/live.ts";
import { AgentDetail, DetailStop, StatusIcon, statusLabel } from "./Agents.tsx";
import { Badge, Empty, IconButton, ignoreToastRegion, Spinner } from "./ui.tsx";

/**
 * One subagent's live view, full screen: over the conversation it belongs to (the page stays mounted underneath, hidden,
 * exactly as it was), or, in a window popped out for it, as the whole page. The route says which subagent
 * (`#/s/<file>/agent/<id>`), so reload and Back/Forward keep it; `AgentDetail` is the same live view the Agents tab shows.
 */
export function SubagentFull({ popOut }: { popOut: boolean }) {
	const t = useT();
	const content = useRef<HTMLDivElement>(null);
	const view = useApp((s) => s.view);
	const { file, live } = useApp(useShallow(viewedConversation));
	const agent = view.kind === "chat" ? view.agent : undefined;
	const { rows, loaded } = useAgentList(file, live);
	// The popped-out window's title says what it shows (the macOS window takes its title from the page).
	useEffect(() => {
		if (!popOut || !agent) return;
		const base = document.title;
		document.title = `${agent} · ${base}`;
		return () => {
			document.title = base;
		};
	}, [popOut, agent]);
	// Over the conversation the page under the full screen is hidden, not unmounted: it keeps its scroll, its draft and
	// its panel, and costs no painting meanwhile (see `.app-shell` in index.css). Set here, so that a full screen that
	// fails to load leaves the page showing.
	useEffect(() => {
		if (popOut) return;
		const root = document.documentElement;
		root.dataset.agentFull = "";
		return () => {
			delete root.dataset.agentFull;
		};
	}, [popOut]);

	const row = agent ? rows.find((r) => r.id === agent) : undefined;
	const header = <FullHeader row={row} rows={rows} agent={agent} live={live} popOut={popOut} />;
	const body = row ? (
		<AgentDetail key={row.id} row={row} rows={rows} live={live} header={header} />
	) : (
		<div className="flex min-h-0 flex-1 flex-col" data-testid="subagent-full-detail">
			{header}
			{loaded || !agent ? (
				<Empty
					icon={<Bot size={22} />}
					title={t(agent ? "panel.agentFullMissingTitle" : "panel.agentFullNoAgentTitle")}
				>
					{agent ? t("panel.agentFullMissingBody", { name: agent }) : t("panel.agentFullNoAgentBody")}
				</Empty>
			) : (
				<div className="flex flex-1 items-center justify-center">
					<Spinner />
				</div>
			)}
		</div>
	);

	if (popOut) {
		return (
			<div className="flex h-full min-h-0 flex-col bg-bg" data-testid="subagent-full" data-mode="popout">
				{body}
			</div>
		);
	}
	return (
		<Dialog.Root open onOpenChange={(open) => !open && exitAgentFull()}>
			<Dialog.Portal>
				{/* A modal dialog: Escape leaves, focus goes in, stays in and returns to what opened it, and the page under
				    it is not reachable. The content is opaque and covers the window. */}
				<Dialog.Content
					ref={content}
					aria-describedby={undefined}
					aria-modal="true"
					className="fade-in fixed inset-0 z-40 flex flex-col bg-bg pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] outline-none"
					data-testid="subagent-full"
					data-mode="window"
					{...ignoreToastRegion}
					// Focus goes to the full screen itself, which is named for a screen reader and has Tab for the first control: on
					// a control with a tooltip, the first Escape would only dismiss that (a tooltip shows on focus).
					onOpenAutoFocus={(e) => {
						e.preventDefault();
						content.current?.focus();
					}}
					// Escape that ends an IME composition is the input method's.
					onEscapeKeyDown={(e) => {
						if (e.isComposing) e.preventDefault();
						// An overlay opened over the full screen takes this Escape, even before it has registered as the top layer.
						else if (dismissOverlays()) e.preventDefault();
						else ignoreToastRegion.onEscapeKeyDown(e);
					}}
					// Back to what opened it (it is on the page again by now), not to wherever the browser would put it.
					onCloseAutoFocus={(e) => {
						const opener = takeFullOpener();
						if (!opener) return;
						e.preventDefault();
						opener.focus();
					}}
				>
					<Dialog.Title className="sr-only">{t("panel.agentFullTitle", { name: row?.id ?? agent ?? "" })}</Dialog.Title>
					{body}
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

/**
 * The full screen's header: the way out, the subagent (its list opens to switch to another, Alt+L), previous and next
 * (Alt+Up, Alt+Down), what it is doing (its status and Stop), and the way into a window of its own — or, in that window,
 * the window's own full screen.
 */
function FullHeader({
	row,
	rows,
	agent,
	live,
	popOut,
}: {
	row: AgentRow | undefined;
	rows: AgentRow[];
	agent: string | undefined;
	live: LiveState | undefined;
	popOut: boolean;
}) {
	const t = useT();
	const prevHint = useShortcutLabel("agentPrev");
	const nextHint = useShortcutLabel("agentNext");
	const toast = useApp((s) => s.toast);
	const liveId = live && !live.info.exited ? live.info.liveId : null;
	const position = agent ? positionOf(rows, agent) : null;
	const prev = agent ? neighbour(rows, agent, -1) : null;
	const next = agent ? neighbour(rows, agent, 1) : null;
	const parent = row ? parentId(row.id) : null;
	const parentRow = parent ? rows.find((r) => r.id === parent) : undefined;
	const [listOpen, setListOpen] = useState(false);
	const screen = useWindowFullScreen((message) => toast("error", message));

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			// A dialog opened over the full screen (search, the shortcuts list) has the keys it needs.
			if (e.defaultPrevented) return;
			// In the steer box the arrows move the caret and a printable key (Option+L) is a character.
			if (typingInField(e.target) && fieldKeepsKey(e.key)) return;
			if (matches("agentPrev", e) && prev) showAgentFull(prev);
			else if (matches("agentNext", e) && next) showAgentFull(next);
			else if (matches("agentList", e)) setListOpen((open) => !open);
			else return;
			e.preventDefault();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [prev, next]);

	return (
		<div
			className="flex shrink-0 items-center gap-1.5 border-b border-border px-2 py-2"
			data-testid="subagent-full-header"
		>
			{popOut ? null : (
				<IconButton label={t("panel.agentFullExit")} data-testid="subagent-full-exit" onClick={exitAgentFull}>
					<Minimize2 size={15} />
				</IconButton>
			)}
			{row ? <StatusIcon status={row.status} /> : null}
			{parentRow ? (
				<button
					type="button"
					className="shrink-0 text-sm text-muted hover:text-fg hover:underline max-sm:hidden"
					data-testid="subagent-parent"
					aria-label={t("panel.agentParent", { name: parentRow.id })}
					onClick={() => showAgentFull(parentRow.id)}
				>
					{parentRow.id} ›
				</button>
			) : null}
			<Switcher rows={rows} agent={agent} open={listOpen} onOpenChange={setListOpen} />
			<div className="ml-auto flex shrink-0 items-center gap-1">
				{position ? (
					<span
						className="px-1 text-xs text-faint tabular-nums max-sm:hidden"
						data-testid="subagent-full-position"
						role="img"
						aria-label={t("panel.agentFullPosition", { index: position.index, total: position.total })}
					>
						{position.index}/{position.total}
					</span>
				) : null}
				<IconButton
					label={withKeys(t("panel.agentFullPrev"), prevHint)}
					size="sm"
					disabled={!prev}
					data-testid="subagent-full-prev"
					onClick={() => prev && showAgentFull(prev)}
				>
					<ChevronUp size={15} />
				</IconButton>
				<IconButton
					label={withKeys(t("panel.agentFullNext"), nextHint)}
					size="sm"
					disabled={!next}
					data-testid="subagent-full-next"
					onClick={() => next && showAgentFull(next)}
				>
					<ChevronDown size={15} />
				</IconButton>
				{row ? <Badge className="ml-1 shrink-0 max-sm:hidden">{statusLabel(t, row.status)}</Badge> : null}
				{row?.running && liveId ? <DetailStop liveId={liveId} row={row} rows={rows} live={live} /> : null}
				{popOut ? (
					screen.available ? (
						<IconButton
							label={screen.active ? t("panel.agentFullScreenExit") : t("panel.agentFullScreenEnter")}
							data-testid="subagent-full-screen"
							aria-pressed={screen.active}
							onClick={screen.toggle}
						>
							{screen.active ? <Minimize size={15} /> : <Maximize size={15} />}
						</IconButton>
					) : null
				) : agent ? (
					<IconButton
						label={t("panel.agentFullPopOut")}
						data-testid="subagent-full-popout"
						className="max-sm:hidden"
						onClick={() => popOutAgent(agent)}
					>
						<ExternalLink size={15} />
					</IconButton>
				) : null}
			</div>
		</div>
	);
}

/** The subagent on screen, and the list of the conversation's subagents to switch to another. */
function Switcher({
	rows,
	agent,
	open,
	onOpenChange,
}: {
	rows: AgentRow[];
	agent: string | undefined;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const t = useT();
	const listLabel = withKeys(t("panel.agentFullListAria"), useShortcutLabel("agentList"));
	const current = rows.find((r) => r.id === agent);
	return (
		<Menu.Root open={open} onOpenChange={onOpenChange}>
			<Menu.Trigger asChild>
				<button
					type="button"
					data-testid="subagent-full-switch"
					// Named by the subagent it shows, as a voice user says it; the tooltip says what the button is for.
					title={listLabel}
					className="flex min-w-0 items-center gap-1 rounded-lg px-2 py-1 text-sm font-semibold hover:bg-hover"
				>
					<span className="min-w-0 truncate" data-testid="subagent-full-name">
						{current?.name ?? agent ?? t("panel.agentFullList")}
					</span>
					<ChevronDown size={13} className="shrink-0 text-muted" />
				</button>
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Content
					align="start"
					sideOffset={6}
					collisionPadding={8}
					data-testid="subagent-full-list"
					className="z-50 max-h-[60vh] w-80 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-xl border border-border bg-surface p-1 shadow-2xl"
				>
					<Menu.Label className="px-2 pt-1.5 pb-1 text-xs font-medium text-faint">
						{t("panel.agentFullList")}
					</Menu.Label>
					<Menu.RadioGroup value={agent ?? ""} onValueChange={showAgentFull}>
						{rows.map((r) => (
							<Menu.RadioItem
								key={r.id}
								value={r.id}
								data-testid="subagent-full-option"
								data-agent-id={r.id}
								className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-hover"
							>
								<StatusIcon status={r.status} />
								<span className="min-w-0 flex-1 truncate" style={{ paddingLeft: `${r.depth * 12}px` }}>
									{r.name}
								</span>
								{r.agent ? <Badge>{r.agent}</Badge> : null}
								<Menu.ItemIndicator className="shrink-0">
									<Check size={14} />
								</Menu.ItemIndicator>
							</Menu.RadioItem>
						))}
					</Menu.RadioGroup>
				</Menu.Content>
			</Menu.Portal>
		</Menu.Root>
	);
}
