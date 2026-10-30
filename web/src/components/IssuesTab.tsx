import {
	ISSUE_LIST_LIMIT,
	type IssueDetail,
	type IssueFilter,
	type IssueSummary,
	type IssuesAnswer,
	type IssuesProblem,
} from "@shared/github.ts";
import { PREF } from "@shared/prefs.ts";
import {
	ArrowLeft,
	CircleCheck,
	CircleDot,
	ExternalLink,
	MessageSquarePlus,
	RefreshCw,
	TextCursorInput,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import "../i18n/later.ts";
import { type MessageKey, registerStrings, type Translate, useT } from "../i18n/index.ts";
import { en } from "../i18n/issues.ts";
import { autoRefresh } from "../lib/auto-refresh.ts";
import { appendPiece, insertIntoComposer } from "../lib/composer-bridge.ts";
import { keepDraft, readDraft } from "../lib/drafts.ts";
import { fmtRelative } from "../lib/format.ts";
import { issuePrompt } from "../lib/issue-prompt.ts";
import { PANEL_SHEET_QUERY, useMediaQuery } from "../lib/media.ts";
import { setPref } from "../lib/prefs.ts";
import { useApp } from "../store/app.ts";
import { Markdown } from "./Markdown.tsx";
import { ScrollPane } from "./ScrollPane.tsx";
import { Button, cx, Empty, IconButton, Spinner } from "./ui.tsx";

// This chunk carries its own English strings: the first page does not (see `registerStrings`).
registerStrings("issues", en);

/**
 * The side panel's Issues tab (#653): the GitHub issues of the conversation's folder, asked of the person's `gh` by the
 * server (`server/gh-issues.ts`). Read only. An issue can be handed to the agent: put into this conversation's message box,
 * or into the message box of a new conversation in the same folder.
 */

async function ask<T>(path: string, body: unknown): Promise<IssuesAnswer<T>> {
	const res = await fetch(path, {
		method: "POST",
		headers: { "content-type": "application/json", "x-omp-webui": "1" },
		body: JSON.stringify(body),
	});
	const data = await res.json().catch(() => ({}));
	if (!res.ok) return { ok: false, problem: "failed", message: data.error ?? res.statusText };
	return data as IssuesAnswer<T>;
}

const FILTERS: { value: IssueFilter; key: MessageKey }[] = [
	{ value: "open", key: "issues.filterOpen" },
	{ value: "closed", key: "issues.filterClosed" },
	{ value: "all", key: "issues.filterAll" },
];

function problemText(t: Translate, problem: IssuesProblem, message?: string): string {
	switch (problem) {
		case "no-gh":
			return t("issues.problemNoGh");
		case "signed-out":
			return t("issues.problemSignedOut");
		case "no-repo":
			return t("issues.problemNoRepo");
		case "unsafe":
			return t("issues.problemUnsafe", { why: message ?? "" });
		case "slow":
			return t("issues.problemSlow");
		case "failed":
			return message ? t("issues.problemFailed", { message }) : t("issues.problemFailedBare");
	}
}

function Problem({ answer }: { answer: { problem: IssuesProblem; message?: string } }) {
	const t = useT();
	return (
		<p
			className="rounded-lg border border-border bg-surface p-3 text-xs text-muted"
			role="alert"
			data-testid="issues-problem"
			data-problem={answer.problem}
		>
			{problemText(t, answer.problem, answer.message)}
		</p>
	);
}

function StateIcon({ state, size = 14 }: { state: IssueSummary["state"]; size?: number }) {
	return state === "open" ? (
		<CircleDot size={size} className="shrink-0 text-success" aria-hidden />
	) : (
		<CircleCheck size={size} className="shrink-0 text-muted" aria-hidden />
	);
}

function Labels({ issue }: { issue: IssueSummary }) {
	if (!issue.labels.length) return null;
	return (
		<span className="flex flex-wrap gap-1">
			{issue.labels.map((l) => (
				<span
					key={l.name}
					className="inline-flex items-center gap-1 rounded-full border border-border px-1.5 text-xs text-muted"
				>
					{l.color ? <span className="h-2 w-2 rounded-full" style={{ background: `#${l.color}` }} aria-hidden /> : null}
					{l.name}
				</span>
			))}
		</span>
	);
}

export function IssuesTab({ cwd }: { cwd: string | null }) {
	const t = useT();
	const [filter, setFilter] = useState<IssueFilter>("open");
	const [draft, setDraft] = useState("");
	const [search, setSearch] = useState("");
	const [answer, setAnswer] = useState<IssuesAnswer<IssueSummary[]> | null>(null);
	const [loading, setLoading] = useState(false);
	const [open, setOpen] = useState<number | null>(null);
	const seq = useRef(0);

	/** `quiet`: a look the person did not ask for (the tab refreshing itself): no spinner. */
	const load = useCallback(
		async (fresh: boolean, quiet = false) => {
			if (!cwd) return;
			const mine = ++seq.current;
			if (!quiet) setLoading(true);
			const got = await ask<IssueSummary[]>("/api/github/issues", { cwd, state: filter, search, fresh }).catch(
				(e: unknown): IssuesAnswer<IssueSummary[]> => ({ ok: false, problem: "failed", message: String(e) }),
			);
			// A later ask (another filter) has the say.
			if (mine !== seq.current) return;
			setAnswer(got);
			setLoading(false);
		},
		[cwd, filter, search],
	);
	useEffect(() => {
		void load(false);
	}, [load]);
	// Another conversation's folder is another repository.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `cwd` is the trigger.
	useEffect(() => setOpen(null), [cwd]);
	// While the list is shown it asks again by itself (#695): at a modest interval and when the window comes back, never while
	// the page is hidden. The server keeps an answer for a moment, so a quick return does not ask GitHub again.
	useEffect(() => {
		if (!cwd || open !== null) return;
		return autoRefresh(() => void load(false, true));
	}, [cwd, open, load]);
	// Back from an issue: the list is what it was before it was opened.
	const wasOpen = useRef(false);
	useEffect(() => {
		if (wasOpen.current && open === null) void load(false, true);
		wasOpen.current = open !== null;
	}, [open, load]);

	if (!cwd) {
		return (
			<ScrollPane className="min-h-0 flex-1 overflow-y-auto p-3" data-testid="issues-tab">
				<Empty icon={<CircleDot size={22} />} title={t("issues.noFolder")} />
			</ScrollPane>
		);
	}
	if (open !== null) return <IssueView cwd={cwd} number={open} onBack={() => setOpen(null)} />;

	const submit = (e: FormEvent) => {
		e.preventDefault();
		setSearch(draft.trim());
	};
	const list = answer?.ok ? answer.value : null;
	return (
		<div className="flex min-h-0 flex-1 flex-col" data-testid="issues-tab">
			<div className="flex flex-col gap-2 border-b border-border p-3">
				<div className="flex items-center gap-2">
					<fieldset className="flex rounded-lg border border-border p-0.5">
						<legend className="sr-only">{t("issues.filterLabel")}</legend>
						{FILTERS.map((f) => (
							<button
								key={f.value}
								type="button"
								aria-pressed={filter === f.value}
								data-testid={`issues-filter-${f.value}`}
								onClick={() => setFilter(f.value)}
								className={cx(
									"h-6 rounded-md px-2 text-xs text-muted hover:text-fg",
									filter === f.value && "bg-hover text-fg",
								)}
							>
								{t(f.key)}
							</button>
						))}
					</fieldset>
					<span className="flex-1" />
					{loading ? <Spinner size={14} /> : null}
					<IconButton
						label={t("issues.refresh")}
						size="sm"
						onClick={() => void load(true)}
						data-testid="issues-refresh"
					>
						<RefreshCw size={14} />
					</IconButton>
				</div>
				<form onSubmit={submit}>
					<input
						type="search"
						value={draft}
						onChange={(e) => {
							setDraft(e.target.value);
							// Clearing the box shows the whole list again without an Enter.
							if (!e.target.value.trim()) setSearch("");
						}}
						aria-label={t("issues.searchLabel")}
						placeholder={t("issues.searchPlaceholder")}
						data-testid="issues-search"
						className="h-8 w-full rounded-lg border border-border bg-bg px-2.5 text-sm outline-none focus:border-accent"
					/>
				</form>
			</div>
			<ScrollPane className="min-h-0 flex-1 overflow-y-auto">
				{answer === null ? (
					<div className="flex justify-center py-10">
						<Spinner />
					</div>
				) : !answer.ok ? (
					<div className="p-3">
						<Problem answer={answer} />
					</div>
				) : list && list.length === 0 ? (
					<Empty icon={<CircleDot size={22} />} title={t("issues.empty")}>
						{t("issues.emptyHint")}
					</Empty>
				) : (
					<ul aria-label={t("issues.listLabel")} data-testid="issues-list">
						{list?.map((issue) => (
							<li key={issue.number}>
								<button
									type="button"
									onClick={() => setOpen(issue.number)}
									data-testid="issues-row"
									data-number={issue.number}
									className="flex w-full items-start gap-2 border-b border-border px-3 py-2 text-left hover:bg-hover"
								>
									<span className="mt-0.5">
										<StateIcon state={issue.state} />
									</span>
									<span className="flex min-w-0 flex-1 flex-col gap-1">
										<span className="text-sm text-fg">{issue.title}</span>
										<span className="text-xs text-muted">
											{issue.author
												? t("issues.openedBy", {
														number: issue.number,
														when: fmtRelative(issue.createdAt),
														author: issue.author,
													})
												: t("issues.openedAnon", { number: issue.number, when: fmtRelative(issue.createdAt) })}
										</span>
										<Labels issue={issue} />
									</span>
								</button>
							</li>
						))}
					</ul>
				)}
				{list ? (
					<p className="px-3 py-2 text-xs text-muted">
						{list.length >= ISSUE_LIST_LIMIT
							? t("issues.countMax", { n: ISSUE_LIST_LIMIT })
							: t("issues.countShown", { n: list.length })}
						{" · "}
						{t("issues.readOnly")}
					</p>
				) : null}
			</ScrollPane>
		</div>
	);
}

function IssueView({ cwd, number, onBack }: { cwd: string; number: number; onBack: () => void }) {
	const t = useT();
	const toast = useApp((s) => s.toast);
	const setView = useApp((s) => s.setView);
	const sheet = useMediaQuery(PANEL_SHEET_QUERY);
	const [answer, setAnswer] = useState<IssuesAnswer<IssueDetail> | null>(null);
	const load = useCallback(
		(fresh: boolean) => {
			let live = true;
			setAnswer(null);
			void ask<IssueDetail>("/api/github/issue", { cwd, number, fresh })
				.catch((e: unknown): IssuesAnswer<IssueDetail> => ({ ok: false, problem: "failed", message: String(e) }))
				.then((got) => {
					if (live) setAnswer(got);
				});
			return () => {
				live = false;
			};
		},
		[cwd, number],
	);
	useEffect(() => load(false), [load]);

	const issue = answer?.ok ? answer.value : null;
	const toChat = () => {
		if (!issue) return;
		// On a phone the message box is behind the sheet: the text is put in, but the keyboard is not summoned.
		if (insertIntoComposer(issuePrompt(issue, t), !sheet)) toast("success", t("issues.inserted"));
		else toast("error", t("issues.noComposer"));
	};
	const toNew = () => {
		if (!issue) return;
		// New chat starts in the folder it was last given, and its message box opens with its draft: the issue is added to
		// what is there.
		setPref(PREF.cwd, cwd);
		const draft = readDraft("new");
		keepDraft("new", {
			...draft,
			images: draft?.images ?? [],
			text: appendPiece(draft?.text ?? "", issuePrompt(issue, t)),
		});
		setView({ kind: "new" });
	};
	return (
		<div className="flex min-h-0 flex-1 flex-col" data-testid="issue-view">
			<div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
				<IconButton label={t("issues.back")} size="sm" onClick={onBack} data-testid="issue-back">
					<ArrowLeft size={14} />
				</IconButton>
				<span className="flex-1 truncate text-xs text-muted">#{number}</span>
				<IconButton label={t("issues.refresh")} size="sm" onClick={() => load(true)}>
					<RefreshCw size={14} />
				</IconButton>
				{issue ? (
					<a
						href={issue.url}
						target="_blank"
						rel="noreferrer noopener"
						aria-label={t("issues.openOnGitHub")}
						title={t("issues.openOnGitHub")}
						className="inline-flex h-7 w-7 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg"
						data-testid="issue-open-github"
					>
						<ExternalLink size={14} />
					</a>
				) : null}
			</div>
			<ScrollPane className="min-h-0 flex-1 overflow-y-auto p-3">
				{answer === null ? (
					<div className="flex justify-center py-10">
						<Spinner />
					</div>
				) : !answer.ok ? (
					<Problem answer={answer} />
				) : issue ? (
					<article className="flex flex-col gap-3">
						<header className="flex flex-col gap-1.5">
							<h2 className="text-title font-semibold text-fg" data-testid="issue-title">
								{issue.title}
							</h2>
							<span className="flex flex-wrap items-center gap-2 text-xs text-muted">
								<span className="inline-flex items-center gap-1" data-testid="issue-state" data-state={issue.state}>
									<StateIcon state={issue.state} size={13} />
									{issue.state === "open" ? t("issues.stateOpen") : t("issues.stateClosed")}
								</span>
								<span>
									{issue.author
										? t("issues.openedBy", {
												number: issue.number,
												when: fmtRelative(issue.createdAt),
												author: issue.author,
											})
										: t("issues.openedAnon", { number: issue.number, when: fmtRelative(issue.createdAt) })}
								</span>
							</span>
							{issue.assignees.length ? (
								<span className="text-xs text-muted">
									{t("issues.assigned", { names: issue.assignees.join(", ") })}
								</span>
							) : null}
							<Labels issue={issue} />
						</header>
						<div className="flex flex-wrap gap-2">
							<Button
								size="sm"
								variant="primary"
								onClick={toChat}
								title={t("issues.handToChatHint")}
								data-testid="issue-to-chat"
							>
								<TextCursorInput size={13} />
								{t("issues.handToChat")}
							</Button>
							<Button size="sm" onClick={toNew} title={t("issues.handToNewHint")} data-testid="issue-to-new">
								<MessageSquarePlus size={13} />
								{t("issues.handToNew")}
							</Button>
						</div>
						<div className="text-sm" data-testid="issue-body">
							{issue.body.trim() ? <Markdown text={issue.body} /> : <p className="text-muted">{t("issues.noBody")}</p>}
						</div>
						{issue.comments.length ? (
							<section className="flex flex-col gap-2">
								<h3 className="text-xs font-semibold text-muted">
									{t("issues.commentsTitle", { n: issue.comments.length })}
								</h3>
								{issue.comments.map((c, i) => (
									<div
										// biome-ignore lint/suspicious/noArrayIndexKey: comments come in GitHub's order and are not edited here
										key={i}
										className="rounded-lg border border-border p-2.5"
										data-testid="issue-comment"
									>
										<p className="mb-1 text-xs text-muted">
											{c.author
												? t("issues.commentBy", { author: c.author, when: fmtRelative(c.createdAt) })
												: t("issues.commentAnon", { when: fmtRelative(c.createdAt) })}
										</p>
										<div className="text-sm">
											<Markdown text={c.body} />
										</div>
									</div>
								))}
							</section>
						) : null}
					</article>
				) : null}
			</ScrollPane>
		</div>
	);
}
