import { working } from "@shared/attention.ts";
import type { ChangedFile, ChangeState, FolderChanges } from "@shared/changes.ts";
import type { SessionEntry } from "@shared/protocol.ts";
import {
	ChevronLeft,
	Columns2,
	Expand,
	FileDiff as FileDiffIcon,
	FileText,
	GitBranch,
	Hourglass,
	RefreshCw,
	Rows3,
	ShieldAlert,
	TriangleAlert,
} from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../../i18n/index.ts";
import { splitPath } from "../../lib/diff.ts";
import { languageOf } from "../../lib/files-rows.ts";
import { type FolderScope, folder } from "../../lib/folder-api.ts";
import { useNarrowerThan } from "../../lib/media.ts";
import type { ToolResults } from "../../lib/messages.ts";
import { relativeIn, turnEdits } from "../../lib/turn-changes.ts";
import { socket } from "../../lib/ws.ts";
import { useApp } from "../../store/app.ts";
import { openBig } from "../../store/big.ts";
import { patchChanges, setDiffMode, uiOf, useChanges } from "../../store/changes.ts";
import { keyOf, select } from "../../store/files.ts";
import { cx, Empty, IconButton, Spinner } from "../ui.tsx";
import { DiffBody, DiffNote } from "./DiffBody.tsx";
import { SPLIT_MIN_PX, useDiff, versionOf } from "./use-diff.ts";

/** What the conversation's own turns hold, read when the view needs it (see `FilesTab`): its path and the saved results of its tool calls. */
export interface TurnSource {
	entries: readonly SessionEntry[];
	results: ToolResults;
	/** The folder as omp knows it (a link on the way makes it differ from the server's real path). */
	cwds: string[];
}

/** A burst of changes is read once, this long after the last of them. */
const REFRESH_MS = 60;
/** Never more often than this: a turn that writes files all the time is followed at this pace, and git is asked each time. */
const MIN_GAP_MS = 800;
/** Turns listed: the newest. */
const TURNS_SHOWN = 100;

function pause(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

const STATE_MARK: Record<ChangeState, { letter: string; word: string; tone: string }> = {
	modified: { letter: "M", word: "files.stateModified", tone: "text-accent" },
	added: { letter: "A", word: "files.stateAdded", tone: "text-success" },
	deleted: { letter: "D", word: "files.stateDeleted", tone: "text-danger" },
	renamed: { letter: "R", word: "files.stateRenamed", tone: "text-accent" },
	typechange: { letter: "T", word: "files.stateTypechange", tone: "text-warning" },
	untracked: { letter: "U", word: "files.stateUntracked", tone: "text-success" },
	conflict: { letter: "!", word: "files.stateConflict", tone: "text-danger" },
};

function StateMark({ state }: { state: ChangeState }) {
	const t = useT();
	const mark = STATE_MARK[state];
	return (
		<span
			className={cx("w-4 shrink-0 text-center text-xs font-semibold", mark.tone)}
			data-testid="change-state"
			data-state={state}
			title={t(mark.word as "files.stateModified")}
		>
			<span aria-hidden>{mark.letter}</span>
			<span className="sr-only">{t(mark.word as "files.stateModified")}</span>
		</span>
	);
}

/** A path with its folder dimmed and cut first, so that the file's name always stays readable. */
function PathText({ path }: { path: string }) {
	const { dir, name } = splitPath(path);
	return (
		<span className="flex min-w-0 items-baseline font-mono text-xs" title={path}>
			{dir ? <span className="min-w-0 truncate text-faint">{dir}</span> : null}
			<span className="max-w-[75%] shrink-0 truncate font-medium text-fg">{name}</span>
		</span>
	);
}

function Counts({ file }: { file: ChangedFile }) {
	if (file.binary) return <span className="shrink-0 text-xs text-faint">bin</span>;
	if (file.added === undefined || file.removed === undefined) return null;
	return (
		<span className="shrink-0 font-mono text-xs tabular-nums" aria-hidden>
			<span className="text-success">+{file.added}</span> <span className="text-danger">−{file.removed}</span>
		</span>
	);
}

/** The list as the server last said it, read while the view is shown and when something may have changed. */
function useChangesSync(scope: FolderScope, key: string) {
	const connected = useApp((s) => s.connected);
	const busy = useApp((s) => (scope.live && s.lives[scope.live] ? working(s.lives[scope.live]) : false));
	const [error, setError] = useState<Error | null>(null);
	const [loading, setLoading] = useState(false);
	const scopeRef = useRef(scope);
	scopeRef.current = scope;
	const reading = useRef(false);
	const again = useRef(false);
	const last = useRef(0);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const alive = useRef(true);
	const ctl = useRef<AbortController | undefined>(undefined);

	const read = useCallback(async (fresh: boolean) => {
		ctl.current = new AbortController();
		setLoading(true);
		try {
			const data = await folder.changes(scopeRef.current, fresh, ctl.current.signal);
			if (!alive.current) return;
			patchChanges(keyOf(scopeRef.current), { data });
			setError(null);
		} catch (e) {
			if (alive.current && !ctl.current.signal.aborted) setError(e instanceof Error ? e : new Error(String(e)));
		} finally {
			if (alive.current) setLoading(false);
		}
	}, []);

	// Read again, one at a time and not in a hurry: a change that comes while the list is being read is read for once more afterwards.
	const refresh = useCallback(
		(fresh = true) => {
			clearTimeout(timer.current);
			const wait = Math.max(REFRESH_MS, last.current + MIN_GAP_MS - Date.now());
			timer.current = setTimeout(async () => {
				if (reading.current) {
					again.current = true;
					return;
				}
				reading.current = true;
				try {
					do {
						again.current = false;
						last.current = Date.now();
						await read(fresh);
						if (again.current) await pause(Math.max(0, last.current + MIN_GAP_MS - Date.now()));
					} while (again.current);
				} finally {
					reading.current = false;
				}
			}, wait);
		},
		[read],
	);

	// What was kept is on screen at once, and is read again when the conversation changes.
	useEffect(() => {
		alive.current = true;
		if (key) refresh(false);
		return () => {
			alive.current = false;
			clearTimeout(timer.current);
			ctl.current?.abort();
		};
	}, [key, refresh]);
	const wasBusy = useRef(busy);
	useEffect(() => {
		if (wasBusy.current && !busy) refresh();
		wasBusy.current = busy;
	}, [busy, refresh]);
	useEffect(() => {
		if (connected) refresh();
	}, [connected, refresh]);
	// The server tells of changes in the folders the tree watches (the top one, at least): not every file of a deep change, but a good moment to look.
	useEffect(
		() =>
			socket.on((msg) => {
				if (msg.t === "folder_changed") refresh();
			}),
		[refresh],
	);
	useEffect(() => {
		const onShow = () => {
			if (document.visibilityState === "visible") refresh();
		};
		document.addEventListener("visibilitychange", onShow);
		window.addEventListener("focus", onShow);
		return () => {
			document.removeEventListener("visibilitychange", onShow);
			window.removeEventListener("focus", onShow);
		};
	}, [refresh]);
	return { error, loading, refresh };
}

function ListRow({
	file,
	onOpen,
	children,
}: {
	file: ChangedFile;
	onOpen: (path: string) => void;
	children?: ReactNode;
}) {
	const t = useT();
	return (
		<li>
			<button
				type="button"
				className="flex min-h-9 w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-hover max-lg:min-h-11"
				data-testid="change-row"
				data-path={file.path}
				data-state={file.state}
				onClick={() => onOpen(file.path)}
			>
				<StateMark state={file.state} />
				<span className="flex min-w-0 flex-1 flex-col">
					<PathText path={file.path} />
					{file.from ? (
						<span className="truncate text-xs text-faint">{t("files.changesFrom", { from: file.from })}</span>
					) : null}
					{children}
				</span>
				{file.staged ? (
					<span className="shrink-0 rounded border border-border px-1 text-xs text-faint" data-testid="change-staged">
						{t("files.changesStaged")}
					</span>
				) : null}
				<Counts file={file} />
			</button>
		</li>
	);
}

/** The list a state that is not `ok` says instead: no repository, one that is not looked at, one that did not answer. */
function Unavailable({ changes }: { changes: FolderChanges }) {
	const t = useT();
	if (changes.state === "unsafe") {
		return (
			<Empty icon={<ShieldAlert size={22} />} title={t("files.changesUnsafeTitle")}>
				{t("files.changesUnsafeBody")}
			</Empty>
		);
	}
	if (changes.state === "unreadable") {
		return (
			<Empty icon={<TriangleAlert size={22} />} title={t("files.changesUnreadableTitle")}>
				{t("files.changesUnreadableBody")}
			</Empty>
		);
	}
	if (changes.state === "slow") {
		return (
			<Empty icon={<Hourglass size={22} />} title={t("files.changesSlowTitle")}>
				{t("files.changesSlowBody")}
			</Empty>
		);
	}
	return (
		<Empty icon={<GitBranch size={22} />} title={t("files.changesNoRepoTitle")}>
			{t("files.changesNoRepoBody")}
		</Empty>
	);
}

/** The files of the conversation's turns that still differ, newest turn first, each linking to its change. */
function Turns({
	changes,
	source,
	onOpen,
}: {
	changes: FolderChanges;
	source: TurnSource;
	onOpen: (path: string) => void;
}) {
	const t = useT();
	const turns = useMemo(() => turnEdits(source.entries, source.results), [source.entries, source.results]);
	const roots = [changes.root, ...source.cwds];
	const byPath = new Map(changes.files.map((f) => [f.path, f]));
	const shown = turns
		.map((turn) => ({
			turn,
			files: turn.files.flatMap((f) => {
				const rel = relativeIn(roots, f.path);
				return rel === null
					? []
					: [{ rel, from: f.from === undefined ? undefined : relativeIn(roots, f.from), file: byPath.get(rel) }];
			}),
		}))
		.filter((x) => x.files.length > 0)
		.reverse()
		.slice(0, TURNS_SHOWN);
	if (shown.length === 0) {
		return (
			<Empty icon={<FileDiffIcon size={22} />} title={t("files.turnsEmpty")}>
				{t("files.turnsNote")}
			</Empty>
		);
	}
	return (
		<fieldset className="min-w-0 px-1 py-1" aria-label={t("files.turnsLabel")}>
			<p className="px-2 py-1 text-xs text-faint">{t("files.turnsNote")}</p>
			{shown.map(({ turn, files }) => (
				<section key={turn.id} className="mb-2" data-testid="change-turn" data-turn={turn.id}>
					<h3 className="truncate px-2 pt-1 text-xs font-semibold text-muted" title={turn.label}>
						{turn.label ? `${t("files.turnNumber", { n: turn.number })} · ${turn.label}` : t("files.turnStart")}
					</h3>
					<ul>
						{files.map(({ rel, from, file }) =>
							file ? (
								<ListRow key={rel} file={{ ...file, ...(from ? { from } : {}) }} onOpen={onOpen} />
							) : (
								<li
									key={rel}
									className="flex min-h-9 items-center gap-2 px-2 py-1 opacity-70"
									data-testid="change-gone"
									data-path={rel}
								>
									<span className="w-4 shrink-0" />
									<PathText path={rel} />
									<span className="shrink-0 text-xs text-faint">{t("files.turnGone")}</span>
								</li>
							),
						)}
					</ul>
				</section>
			))}
		</fieldset>
	);
}

/** One of two buttons of which one is on, as the panel's other switches are drawn. */
function Choice({
	on,
	label,
	onPick,
	testid,
	children,
}: {
	on: boolean;
	label: string;
	onPick: () => void;
	testid: string;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			aria-pressed={on}
			aria-label={label}
			title={label}
			data-testid={testid}
			className={cx(
				"inline-flex h-7 items-center gap-1 rounded-md px-2 text-xs max-lg:min-h-9",
				on ? "bg-hover font-medium text-fg" : "text-muted hover:bg-hover hover:text-fg",
			)}
			onClick={onPick}
		>
			{children}
		</button>
	);
}

/** The open file's change, with a way back to the list. */
function Opened({ scope, file, onBack }: { scope: FolderScope; file: ChangedFile | undefined; onBack: () => void }) {
	const t = useT();
	const key = keyOf(scope);
	const path = useChanges((s) => uiOf(s, key).selected) as string;
	const mode = useChanges((s) => s.mode);
	const opened = useDiff(scope, path, versionOf(file));
	const [box, setBox] = useState<HTMLDivElement | null>(null);
	const roomy = !useNarrowerThan(box, SPLIT_MIN_PX);
	const split = roomy && mode === "split";
	const name = path.slice(path.lastIndexOf("/") + 1);
	const diff = opened.state === "ok" ? opened.diff : null;
	const shown = file?.state ?? diff?.state;
	return (
		<div className="flex min-h-0 flex-1 flex-col" data-testid="change-diff" data-path={path} ref={setBox}>
			<div className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
				<IconButton label={t("files.changesBack")} size="sm" data-testid="change-back" onClick={onBack}>
					<ChevronLeft size={15} />
				</IconButton>
				<div className="min-w-0 flex-1">
					<div className="truncate text-sm font-semibold" title={path} data-testid="change-name">
						{name}
					</div>
					<div className="flex min-w-0 items-center gap-1.5 truncate text-xs text-faint">
						{shown ? <StateMark state={shown} /> : null}
						{file ? <Counts file={file} /> : null}
						{diff?.mode ? <span>{t("files.diffMode", diff.mode)}</span> : null}
						{diff?.from ? <span className="truncate">{t("files.changesFrom", { from: diff.from })}</span> : null}
					</div>
				</div>
				{roomy ? (
					<fieldset
						className="flex shrink-0 items-center rounded-lg border border-border p-0.5"
						aria-label={t("files.diffModeLabel")}
					>
						<Choice
							on={!split}
							label={t("files.diffUnified")}
							onPick={() => setDiffMode("unified")}
							testid="diff-unified"
						>
							<Rows3 size={13} />
						</Choice>
						<Choice on={split} label={t("files.diffSplit")} onPick={() => setDiffMode("split")} testid="diff-split">
							<Columns2 size={13} />
						</Choice>
					</fieldset>
				) : null}
				{shown && shown !== "deleted" && !path.endsWith("/") ? (
					<IconButton
						label={t("files.diffOpenFile")}
						size="sm"
						data-testid="change-open-file"
						onClick={() => {
							patchChanges(key, { view: "files" });
							select(scope, path);
						}}
					>
						<FileText size={14} />
					</IconButton>
				) : null}
				<IconButton
					label={t("files.openLarge")}
					size="sm"
					data-testid="change-open-large"
					onClick={(e) => openBig(key, { kind: "diff", path }, e.currentTarget)}
				>
					<Expand size={14} />
				</IconButton>
			</div>
			<section
				className="min-h-0 flex-1 overflow-auto"
				aria-label={t("files.diffLabel", { name })}
				// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling box must take the focus to be scrolled by keys
				tabIndex={0}
			>
				{opened.state === "loading" ? (
					<div className="flex justify-center py-10">
						<Spinner />
					</div>
				) : opened.state === "error" ? (
					<Empty
						icon={<FileDiffIcon size={22} />}
						title={opened.gone ? t("files.diffGone") : t("files.diffError", { error: opened.message })}
					/>
				) : opened.diff.view === "text" ? (
					<DiffBody diff={opened.diff} split={split} lang={languageOf(name)} />
				) : (
					<DiffNote diff={opened.diff} />
				)}
			</section>
		</div>
	);
}

/**
 * The Changes view of the Files tab: how the folder the conversation works in differs from its repository's last commit
 * (every file that does, or the files each turn changed), and the change of one file, unified or split, coloured by its
 * language. Read only: there is nothing here that stages, commits or throws a change away.
 */
export default function ChangesView({ scope, getTurns }: { scope: FolderScope; getTurns: () => TurnSource }) {
	const t = useT();
	const key = keyOf(scope);
	const ui = useChanges((s) => uiOf(s, key));
	const { error, loading, refresh } = useChangesSync(scope, key);
	const { data, selected, source } = ui;
	const file = data?.files.find((f) => f.path === selected);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a list read again is the moment to ask for the turns again
	const turns = useMemo(() => (source === "turns" ? getTurns() : null), [source, getTurns, data]);
	const open = useCallback((path: string) => patchChanges(key, { selected: path }), [key]);

	if (selected !== null) {
		return <Opened scope={scope} file={file} onBack={() => patchChanges(key, { selected: null })} />;
	}
	return (
		<div className="flex min-h-0 flex-1 flex-col" data-testid="changes-view">
			<div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border p-2">
				<fieldset
					className="flex items-center rounded-lg border border-border p-0.5"
					aria-label={t("files.changesSourceLabel")}
				>
					<Choice
						on={source === "tree"}
						label={t("files.changesSourceTree")}
						onPick={() => patchChanges(key, { source: "tree" })}
						testid="changes-source-tree"
					>
						{t("files.changesSourceTree")}
					</Choice>
					<Choice
						on={source === "turns"}
						label={t("files.changesSourceTurns")}
						onPick={() => patchChanges(key, { source: "turns" })}
						testid="changes-source-turns"
					>
						{t("files.changesSourceTurns")}
					</Choice>
				</fieldset>
				<span
					className="ml-auto flex min-w-0 items-center gap-1 truncate text-xs text-faint"
					data-testid="changes-branch"
				>
					{data?.state === "ok" ? (
						<>
							<GitBranch size={12} className="shrink-0" />
							<span className="truncate">{data.branch || "—"}</span>
						</>
					) : null}
				</span>
				<IconButton label={t("files.refresh")} size="sm" data-testid="changes-refresh" onClick={() => refresh()}>
					<RefreshCw size={14} className={cx(loading && "animate-spin")} />
				</IconButton>
			</div>
			<div className="min-h-0 flex-1 overflow-y-auto">
				{!data ? (
					error ? (
						<Empty icon={<FileDiffIcon size={22} />} title={t("files.changesLoadError", { error: error.message })}>
							<button
								type="button"
								className="mt-2 rounded-md border border-border px-2 py-1 text-xs hover:bg-hover"
								onClick={() => refresh()}
							>
								{t("files.retry")}
							</button>
						</Empty>
					) : (
						<div className="flex justify-center py-10">
							<Spinner />
						</div>
					)
				) : data.state !== "ok" ? (
					<Unavailable changes={data} />
				) : source === "turns" && turns ? (
					<Turns changes={data} source={turns} onOpen={open} />
				) : data.files.length === 0 ? (
					<Empty icon={<FileDiffIcon size={22} />} title={t("files.changesEmptyTitle")}>
						{t("files.changesEmptyBody")}
					</Empty>
				) : (
					<ul className="px-1 py-1" aria-label={t("files.changesListLabel")} data-testid="changes-list">
						{data.files.map((f) => (
							<ListRow key={f.path} file={f} onOpen={open} />
						))}
					</ul>
				)}
				{data?.state === "ok" && data.omitted > 0 ? (
					<p className="px-3 py-2 text-xs text-faint" data-testid="changes-omitted">
						{t("files.changesOmitted", { n: data.omitted })}
					</p>
				) : null}
				{data?.state === "ok" && data.truncated ? (
					<p className="px-3 py-2 text-xs text-faint" data-testid="changes-cut">
						{t("files.changesTruncated", { n: data.files.length })}
					</p>
				) : null}
			</div>
		</div>
	);
}
