import { parseSelector } from "@shared/model-config.ts";
import { runsLocal } from "@shared/offline.ts";
import { PREF } from "@shared/prefs.ts";
import { Send, Square } from "lucide-react";
import { useEffect, useState } from "react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { errorText } from "../lib/error-text.ts";
import { useModelCatalog } from "../lib/model-config.ts";
import { onPrefsChanged, setPref } from "../lib/prefs.ts";
import type { StartLive } from "../lib/start-live.ts";
import { socket } from "../lib/ws.ts";
import { continueConversation, useApp } from "../store/app.ts";
import type { BtwRecord, LiveState } from "../store/live.ts";
import { Markdown } from "./Markdown.tsx";
import { ModelSelect } from "./ModelSelect.tsx";
import { ScrollPane } from "./ScrollPane.tsx";
import { IconButton, Spinner } from "./ui.tsx";

function mergeRecords(liveId: string, records: BtwRecord[]): void {
	useApp.setState((st) => {
		const cur = st.lives[liveId];
		if (!cur) return {};
		const btw = { ...cur.btw };
		for (const r of records) btw[r.id] = r.model || !btw[r.id]?.model ? r : { ...r, model: btw[r.id].model };
		return { lives: { ...st.lives, [liveId]: { ...cur, btw } } };
	});
}

const BTW_STATUS = {
	error: "chat.btwStatusError",
	cancelled: "chat.btwStatusCancelled",
	interrupted: "chat.btwStatusInterrupted",
} as const;

const storedChoice = () => localStorage.getItem(PREF.btwModel) ?? "";

/**
 * The model that answers side questions: one choice for every conversation, kept with the app's other preferences and shown
 * in every page as it is made. Nothing chosen: the model the conversation runs on, answered by omp itself.
 */
function BtwModel({ live }: { live: LiveState | undefined }) {
	const t = useT();
	const toast = useApp((s) => s.toast);
	const [chosen, setChosen] = useState(storedChoice);
	// Listing the models starts an omp: it waits until the list is about to be opened, or a choice is there to be named.
	const [opened, setOpened] = useState(false);
	useEffect(() => onPrefsChanged((keys) => keys.includes(PREF.btwModel) && setChosen(storedChoice())), []);
	// On a local server only the models of the process the conversation runs on can be asked: another choice is answered by
	// the conversation's own model.
	const local = runsLocal(live?.info);
	const models = useModelCatalog(opened || chosen !== "", local ? "local" : "omp");
	const foreign = local && chosen !== "" && parseSelector(chosen)?.provider !== live?.state?.model?.provider;
	return (
		<div
			className="border-t border-border px-2 pt-2"
			data-testid="btw-model-row"
			onPointerEnter={() => setOpened(true)}
			onFocusCapture={() => setOpened(true)}
		>
			<ModelSelect
				value={chosen}
				models={models}
				label={t("chat.btwModelLabel")}
				testid="btw-model"
				blank={t("chat.btwModelDefault")}
				onChange={(selector) => {
					if (selector !== "" && !parseSelector(selector)) return toast("error", t("chat.btwModelInvalid"));
					setChosen(selector);
					setPref(PREF.btwModel, selector === "" ? null : selector);
				}}
			/>
			{chosen !== "" ? (
				<p className="mt-1 text-xs text-muted" data-testid="btw-model-note">
					{foreign ? t("chat.btwModelLocal") : t("chat.btwModelNote")}
				</p>
			) : null}
		</div>
	);
}

/**
 * omp side questions (`/btw`): one answer from the session's context without
 * tools, never added to the transcript. Follow-ups continue a topic. Asking in a conversation without a running
 * omp starts it (`start`), and in a paused one continues it: the answer is the model's work.
 */
export function BtwPanel({ live, start }: { live: LiveState | undefined; start?: StartLive }) {
	const t = useT();
	const toast = useApp((s) => s.toast);
	const liveId = live && !live.info.exited ? live.info.liveId : null;
	const [question, setQuestion] = useState("");
	const [topic, setTopic] = useState<string | null>(null);
	useEffect(() => {
		if (!liveId) return;
		socket
			.rpc<{ records: BtwRecord[] }>(liveId, { type: "get_btw_history" })
			.then((r) => mergeRecords(liveId, r.records ?? []))
			.catch(() => {});
	}, [liveId]);
	const records = Object.values(liveId ? (live?.btw ?? {}) : {}).sort((a, b) => b.createdAt - a.createdAt);
	const running = records.some((r) => r.status === "running" || r.followUps?.some((f) => f.status === "running"));
	const ask = () => {
		const q = question.trim();
		if (!q) return;
		setQuestion("");
		void (async () => {
			try {
				const id = liveId ?? (await start?.());
				// Not started (the reason is shown): the question goes back into the field.
				if (!id) return setQuestion((cur) => cur || q);
				if (await continueConversation(id)) toast("info", t("chat.btwResumed"));
				const r = await socket.rpc<{ record: BtwRecord }>(id, {
					type: "btw",
					question: q,
					...(topic ? { recordId: topic } : {}),
				});
				if (r?.record) mergeRecords(id, [r.record]);
			} catch (e) {
				toast("error", t("chat.btwFailed", { error: errorText(e) }));
			}
		})();
	};
	return (
		<div className="flex h-full flex-col" data-testid="btw-panel">
			<ScrollPane className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
				{!records.length ? <p className="text-xs text-muted">{t("chat.btwIntro")}</p> : null}
				{records.map((r) => (
					<article
						key={r.id}
						className="rounded-xl border border-border bg-surface p-3 text-sm"
						data-testid="btw-record"
					>
						{[{ question: r.question, answer: r.answer, status: r.status, error: r.error }, ...(r.followUps ?? [])].map(
							(turn, i) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: follow-ups are append-only
								<div key={i} className={i ? "mt-3 border-t border-border pt-3" : undefined}>
									<div className="mb-1 font-medium">{turn.question}</div>
									{turn.answer ? <Markdown text={turn.answer} /> : null}
									{turn.status === "running" ? <Spinner size={13} className="mt-1 text-accent" /> : null}
									{turn.status === "error" || turn.status === "cancelled" || turn.status === "interrupted" ? (
										<div className="mt-1 break-words text-xs text-danger" data-testid="btw-turn-status">
											{t(BTW_STATUS[turn.status])}
											{turn.error ? `: ${turn.error}` : ""}
										</div>
									) : null}
								</div>
							),
						)}
						{r.model ? (
							<div className="mt-2 break-all text-xs text-faint" data-testid="btw-record-model">
								{t("chat.btwAnsweredBy", { model: r.model })}
							</div>
						) : null}
						<button
							type="button"
							className="mt-1 inline-flex min-h-6 items-center text-xs text-accent hover:underline"
							onClick={() => setTopic(topic === r.id ? null : r.id)}
						>
							{topic === r.id ? t("chat.btwCancelFollowUp") : t("chat.btwFollowUp")}
						</button>
					</article>
				))}
			</ScrollPane>
			<BtwModel live={live} />
			<form
				className="flex gap-1.5 border-t border-border p-2"
				data-panel-bar
				onSubmit={(e) => {
					e.preventDefault();
					ask();
				}}
			>
				<input
					aria-label={t("chat.btwInputLabel")}
					data-testid="btw-input"
					placeholder={topic ? t("chat.btwFollowUpPlaceholder") : t("chat.btwPlaceholder")}
					value={question}
					onChange={(e) => setQuestion(e.target.value)}
					className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs outline-none focus:border-faint"
				/>
				{running ? (
					<IconButton
						label={t("chat.btwStop")}
						onClick={() => liveId && void socket.act(liveId, { type: "btw_cancel" }).catch(() => {})}
					>
						<Square size={13} />
					</IconButton>
				) : (
					<IconButton label={t("chat.btwAsk")} type="submit" data-testid="btw-send">
						<Send size={14} />
					</IconButton>
				)}
			</form>
		</div>
	);
}
