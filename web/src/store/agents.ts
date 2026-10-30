import type { FamilyStats, SessionEntry, SubagentFile } from "@shared/protocol.ts";
import { useEffect, useMemo } from "react";
import { create } from "zustand";
import "../i18n/later.ts";
import { t } from "../i18n/index.ts";
import { popOutHref } from "../lib/agent-full.ts";
import { api } from "../lib/api.ts";
import { unwrittenOwnFile } from "../lib/family.ts";
import { showPanelTab } from "../lib/panel-panes.ts";
import { entryIdOf } from "../lib/reading.ts";
import { type AgentRow, agentRows, subagentsForToolCall, toolCallArguments } from "../lib/subagents.ts";
import { advisorUsageOf, type ConversationTotals, conversationTotals, sumEntries } from "../lib/totals.ts";
import { hashOf, liveFor, useApp, type View } from "./app.ts";
import type { LiveState } from "./live.ts";

/**
 * The subagents of the conversation on screen, as the UI reads them: what the server finds on disk (with what each
 * spent) merged with what the live omp process reports, and which one the Agents tab has open.
 */

// ------------------------------------------------------------------ the conversation on screen

/** What `viewedConversation` reads of the app state. */
interface Viewing {
	view: View;
	lives: Record<string, LiveState>;
}

/** The conversation the chat view shows: its process (if one runs) and its session file. */
export function viewedConversation(s: Viewing): { file: string | null; live: LiveState | undefined } {
	if (s.view.kind !== "chat") return { file: null, live: undefined };
	const live = (s.view.liveId ? s.lives[s.view.liveId] : undefined) ?? liveFor(s.view.file);
	return { file: live?.info.sessionFile ?? s.view.file, live };
}

// ------------------------------------------------------------------ transcripts on disk

const useFiles = create<{ byFile: Record<string, SubagentFile[]>; asked: Record<string, true> }>(() => ({
	byFile: {},
	asked: {},
}));
const asking = new Map<string, Promise<void>>();
const askAgain = new Set<string>();

/**
 * Ask the server for a conversation's subagents again. A request that arrives while one is out does not start
 * another: it makes the one in flight repeat once when it is back, so the answer is never older than the asking.
 */
export function refreshSubagentFiles(file: string): Promise<void> {
	const out = asking.get(file);
	if (out) {
		askAgain.add(file);
		return out;
	}
	const run = (async () => {
		do {
			askAgain.delete(file);
			try {
				const list = await api.subagents(file);
				useFiles.setState((s) => {
					const before = s.byFile[file];
					// Same answer, same array: nothing that reads it has to run again.
					return before && JSON.stringify(before) === JSON.stringify(list)
						? s
						: { byFile: { ...s.byFile, [file]: list } };
				});
			} catch {
				// The conversation's file went away, or the server is away: what was known stays.
			}
			// Answered or not, the question has been asked: a view that waits for the list stops waiting.
			useFiles.setState((s) => (s.asked[file] ? s : { asked: { ...s.asked, [file]: true } }));
		} while (askAgain.has(file));
	})().finally(() => asking.delete(file));
	asking.set(file, run);
	return run;
}

/**
 * The subagent transcripts of a conversation, with what each spent. Asked again when the conversation's totals in
 * the session list change (the server notices a subagent writing although its parent's file stays as it is) and
 * when a live subagent starts or ends. A new conversation's file, which omp names before it writes it, is not asked
 * for (the server answers 404): the session list gaining it asks.
 */
export function useSubagentFiles(file: string | null, live: LiveState | undefined): SubagentFile[] | undefined {
	const files = useFiles((s) => (file ? s.byFile[file] : undefined));
	const unwritten = useUnwritten(file, live);
	const summed = useApp((s) => {
		const own = s.sessions.find((x) => x.file === file);
		return own ? `${own.subagentCount}/${own.subagentUsage?.requests}/${own.subagentUsage?.totalTokens}` : "";
	});
	const lifecycle = Object.values(live?.subagents ?? {})
		.map((a) => `${a.id}:${a.status}`)
		.join(",");
	// biome-ignore lint/correctness/useExhaustiveDependencies: `summed` and `lifecycle` only say that the list is out of date.
	useEffect(() => {
		if (file && !unwritten) void refreshSubagentFiles(file);
	}, [file, unwritten, summed, lifecycle]);
	return files;
}

/** The conversation's file is one omp named and has not written yet (see `unwrittenOwnFile`): nothing is on disk to ask for. */
function useUnwritten(file: string | null, live: LiveState | undefined): boolean {
	const ownsFile = file !== null && live?.info.sessionFile === file;
	return useApp((s) => file !== null && unwrittenOwnFile(s.sessions, s.sessionsLoaded, file, ownsFile));
}

// ------------------------------------------------------------------ rows and totals

/** Every subagent of the conversation, running ones first (see `agentRows`). */
export function useAgentRows(file: string | null, live: LiveState | undefined): AgentRow[] {
	const files = useSubagentFiles(file, live);
	return useMemo(() => agentRows(files, live?.subagents), [files, live?.subagents]);
}

/**
 * The rows, and whether the list is known: a subagent that is in no row is only missing once the server has been
 * asked for the transcripts on disk (a conversation with no file or nothing written has none to ask for). For the
 * view that has to tell "not loaded yet" from "not there"; the rest of the page reads `useAgentRows`, which follows
 * less of the store.
 */
export function useAgentList(file: string | null, live: LiveState | undefined): { rows: AgentRow[]; loaded: boolean } {
	const rows = useAgentRows(file, live);
	const known = useFiles((s) => file !== null && (s.byFile[file] !== undefined || s.asked[file] === true));
	const unwritten = useUnwritten(file, live);
	return { rows, loaded: file === null || unwritten || known };
}

/**
 * What the conversation has used: its own requests (from `entries`, the transcript the header shows) plus its
 * subagents', whether finished, nested or still running, plus its advisors'. omp sends no frame for an advisor's
 * requests and its own statistics leave them out: they are what the session list says, which the server keeps up to
 * date from the advisor's transcript (the list's `usage` has them too, but it also has the conversation's own, which
 * `entries` already count: only `advisorUsage` is taken from it, so nothing is counted twice).
 *
 * A page that holds only the end of a long conversation passes the server's figures for the whole file (`base`): its own
 * requests are those and what `entries` add after the entry they end at.
 */
export function useConversationTotals(
	file: string | null,
	live: LiveState | undefined,
	entries: SessionEntry[],
	base?: FamilyStats | null,
): ConversationTotals {
	const rows = useAgentRows(file, live);
	const listed = useApp((s) => s.sessions.find((x) => x.file === file)?.advisorUsage);
	const main = useMemo(() => sumEntries(entries, base), [entries, base]);
	const advisor = useMemo(() => advisorUsageOf(listed), [listed]);
	return useMemo(() => conversationTotals(main, rows, advisor), [main, rows, advisor]);
}

// ------------------------------------------------------------------ the Agents tab

/** The subagent whose live view the Agents tab shows, and the conversation it belongs to. */
export const useAgentUi = create<{ selected: { file: string | null; id: string } | null }>(() => ({
	selected: null,
}));

/** Show the Agents tab: the live view of `id`, or the list when `id` is null. Opens the side panel if it is closed. */
export function openAgent(id: string | null): void {
	const app = useApp.getState();
	useAgentUi.setState({ selected: id ? { file: viewedConversation(app).file, id } : null });
	showPanelTab("agents");
}

/** Open `id` in the Agents tab of the conversation on screen (from inside the tab, where the panel is already open). */
export function selectAgent(id: string | null): void {
	useAgentUi.setState({ selected: id ? { file: viewedConversation(useApp.getState()).file, id } : null });
}

/**
 * A task card's "View subagents": the live view of its subagent when it started one, the Agents list when it started
 * several (or the conversation does not know them). `entries` holds the call, `owner` is the subagent whose
 * transcript the card is in, if it is in one. In a full screen (or a pop-out) the card is in the full screen's own view:
 * it goes there, not to the panel behind it (which a pop-out has none of), and the switcher has the others of the call.
 */
export function openAgentForToolCall(toolCallId: string, entries: SessionEntry[], owner = ""): void {
	const { file, live } = viewedConversation(useApp.getState());
	const rows = agentRows(file ? useFiles.getState().byFile[file] : undefined, live?.subagents);
	const found = subagentsForToolCall(rows, toolCallId, toolCallArguments(entries, toolCallId), owner);
	const view = useApp.getState().view;
	if (view.kind === "chat" && view.agent) {
		if (found.length > 0) showAgentFull(found[0].id);
		return;
	}
	openAgent(found.length === 1 ? found[0].id : null);
}

// ------------------------------------------------------------------ a subagent full screen

/**
 * The history entry this page pushed to show a full screen. Leaving it is a step back, which finds the conversation
 * as it was; a full screen the page was loaded into (a reload, a link) has no entry of the conversation below it to
 * step back to.
 */
let pushedFor: string | null = null;

/** What had focus (or was pressed) when the full screen opened: focus goes back to it when the full screen ends. */
let opener: HTMLElement | null = null;

/** The element that opened the full screen, once: for the full screen to give focus back to it when it ends. */
export function takeFullOpener(): HTMLElement | null {
	const el = opener;
	opener = null;
	return el?.isConnected ? el : null;
}

/**
 * Show `id` full screen over the conversation on screen, or, in a full screen already, switch to `id`. Entering is a
 * step of its own in the history (Back leaves the full screen); switching replaces it, so that going through ten
 * subagents is not ten steps back. `from` is the control that was used, when there is one (a button does not take
 * focus when pressed in every browser, so the focused element alone cannot say what opened it).
 */
export function showAgentFull(id: string, from?: Element | null): void {
	const { view, setView } = useApp.getState();
	if (view.kind !== "chat" || view.agent === id) return;
	if (view.agent) {
		setView({ ...view, agent: id }, { replace: true });
		return;
	}
	const focused = document.activeElement;
	const source = from ?? (focused === document.body ? null : focused);
	opener = source instanceof HTMLElement ? source : null;
	setView({ ...view, agent: id });
	pushedFor = entryIdOf(history.state);
}

/** Leave the full screen: back to the conversation exactly as it was left (it stays mounted underneath). */
export function exitAgentFull(): void {
	const { view, setView } = useApp.getState();
	if (view.kind !== "chat" || !view.agent) return;
	if (pushedFor !== null && entryIdOf(history.state) === pushedFor) {
		pushedFor = null;
		history.back();
		return;
	}
	const { agent: _agent, ...conversation } = view;
	setView(conversation, { replace: true });
}

/** The size of a window popped out for a subagent. */
const POPOUT_FEATURES = "popup=yes,width=1100,height=800";

/**
 * Open `id` in a window of its own (the macOS app opens a native window for it). The full screen it was opened from
 * ends: the window takes its place. Closing the window leaves this page as it is.
 */
export function popOutAgent(id: string): void {
	const { view, toast } = useApp.getState();
	if (view.kind !== "chat") return;
	const opened = window.open(popOutHref(location.origin, hashOf({ ...view, agent: id })), "_blank", POPOUT_FEATURES);
	if (!opened) {
		toast("error", t("panel.agentFullPopOutBlocked"));
		return;
	}
	if (view.agent) exitAgentFull();
}
