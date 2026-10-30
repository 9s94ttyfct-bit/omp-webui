import type { ApprovalMode } from "@shared/approval.ts";
import type { GuardOverride } from "@shared/guard.ts";
import type { LiveGuidance, SessionGuidance } from "@shared/model-guidance.ts";
import { MODEL_FLAGS, runsLocal } from "@shared/offline.ts";
import { PREF } from "@shared/prefs.ts";
import type { CliFlag } from "@shared/protocol.ts";
import { ChevronDown, FolderOpen, RotateCw, SlidersHorizontal, Target } from "lucide-react";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { type MessageKey, useT } from "../i18n/index.ts";
import { api } from "../lib/api.ts";
import { errorText } from "../lib/error-text.ts";
import { shortPath } from "../lib/format.ts";
import { createGoal, startGuidedGoal, useGoalRequest } from "../lib/goal.ts";
import { useImeGuard } from "../lib/ime.ts";
import { lazyChunk } from "../lib/lazy-chunk.ts";
import { loadStartConfig, switchPreset, useStartConfig } from "../lib/model-config.ts";
import { selectedThinking } from "../lib/models.ts";
import {
	applyPicks,
	type PickIo,
	type Picks,
	pickModel,
	pickPreset,
	pickThinking,
	withoutLost,
} from "../lib/new-chat-picks.ts";
import { selectMode, useMode } from "../lib/offline.ts";
import { setPref } from "../lib/prefs.ts";
import { ReplyError, socket } from "../lib/ws.ts";
import { closeLive, openLive, refreshState, runBash, useApp } from "../store/app.ts";
import { Composer, type ComposerHandle, type ImageAttachment } from "./Composer.tsx";
import { ErrorBoundary } from "./ErrorBoundary.tsx";
import { Button, cx, Spinner } from "./ui.tsx";

// "Guard dangerous commands" for this conversation (its own settings over the global ones): a chunk of its own, with its strings.

// The usage meter beside the folder needs the conversation's model, which is known once its omp process runs, after the
// first paint: a chunk of its own, fetched as soon as the warm-up process exists (`preloadQuota`).
const {
	Chunk: Quota,
	preload: preloadQuota,
	retry: retryQuota,
} = lazyChunk(() => import("./Quota.tsx").then((m) => ({ default: m.Quota })));
// The request cards (omp asking to run a tool, or a question) are only drawn when the warm-up process asks, after the
// first paint, and the pickers in the composer's footer only exist once it runs: chunks of their own, fetched when the
// warm-up starts.
const {
	Chunk: UIRequests,
	preload: preloadUIRequests,
	retry: retryUIRequests,
} = lazyChunk(() => import("./UIRequests.tsx").then((m) => ({ default: m.UIRequests })));
const {
	Chunk: Pickers,
	preload: preloadPickers,
	retry: retryPickers,
} = lazyChunk(() => import("./NewChatPickers.tsx").then((m) => ({ default: m.NewChatPickers })));

// The folder picker is opened a few times in a person's life: a chunk of its own, fetched when the pointer reaches its
// button or it is first opened (its "New project folder" is another, with its strings).
const {
	Chunk: DirBrowser,
	preload: preloadDirBrowser,
	retry: retryDirBrowser,
} = lazyChunk(() => import("./DirBrowser.tsx").then((m) => ({ default: m.DirBrowser })));

// A start that failed because Light's local server does not answer is mended by choosing Full (or by fixing the server): the
// pickers are not there while the process does not run, so the Full / Light chip is, beside the error. The pickers' own copy
// of it is the same chunk.
const { Chunk: ModeChip, retry: retryModeChip } = lazyChunk(() =>
	import("./ModePicker.tsx").then((m) => ({ default: m.ModePicker })),
);

/** Flags that make no sense for an interactive web session (handled elsewhere or exit immediately). */
const EXCLUDED_FLAGS: Record<string, true> = {
	"--mode": true,
	"--print": true,
	"--export": true,
	"--alias": true,
	"--resume": true,
	"--continue": true,
	"--restore": true,
	"--cwd": true,
	"--help": true,
	"--version": true,
	"--goal": true,
	"--from-claude": true,
	"--from-codex": true,
	// The conversation's own permission switcher sets these; as a flag for the whole process they would override it.
	"--approval-mode": true,
	"--auto-approve": true,
	"--yolo": true,
};

export function sessionFlags(flags: CliFlag[]): CliFlag[] {
	return flags.filter((f) => !EXCLUDED_FLAGS[f.name]);
}

function greeting(t: (key: MessageKey) => string): string {
	const h = new Date().getHours();
	return h < 5
		? t("pages.greetingLate")
		: h < 12
			? t("pages.greetingMorning")
			: h < 18
				? t("pages.greetingAfternoon")
				: t("pages.greetingEvening");
}

/** The template Settings makes the default for new chats (`ompw.guidanceDefault`), as a pick; null when there is none. */
function defaultGuidance(): SessionGuidance | null {
	const id = localStorage.getItem(PREF.guidanceDefault);
	return id ? { template: id } : null;
}

/** The warm-up process as the picks see it: what they set, and what it runs. */
function pickIo(liveId: string): PickIo {
	return {
		switchPreset: (name) => switchPreset(liveId, name),
		setModel: async ({ provider, modelId }) =>
			void (await socket.act(liveId, { type: "set_model", provider, modelId })),
		setThinking: async (level) => void (await socket.act(liveId, { type: "set_thinking_level", level })),
		running: async () => {
			const state = await refreshState(liveId);
			if (!state) return null;
			// What the process is set to, not the level `auto` resolved to (`get_state` has only that): the start config says
			// whether it started on `auto`, and is only asked when no frame has said what it is set to.
			let live = useApp.getState().lives[liveId];
			const config = live && live.thinking === undefined ? await loadStartConfig(live) : null;
			live = useApp.getState().lives[liveId];
			return { model: state.model, thinking: selectedThinking(live, undefined, config).selected };
		},
	};
}

/**
 * What the composer's footer holds while the pickers' chunk is on its way: one grey bar where each control will be, at
 * that control's width, so that the footer wraps exactly when the controls do and the composer's field above it does not
 * move as the chunk lands. `contents` puts the bars in the footer's own flex (not in a row of their own): a footer too
 * narrow for the row wraps them onto a second line just as it will the controls, and under `composer-narrow`, where the
 * controls keep only their icons, the bars become 32 px squares too; and there, as the controls do (C1), the ones behind
 * "⋯" give way to one square for it, at the end. The widths are the controls' own and depend on the labels, so they live
 * in `index.css` (one set per language, by `data-sk`), not in this chunk's JavaScript.
 */
function PickersSkeleton() {
	const more = "h-8 shrink-0 rounded-lg bg-hover composer-narrow:hidden";
	return (
		<span aria-hidden data-testid="pickers-skeleton" className="contents">
			<span data-sk="preset" className="h-8 shrink-0 rounded-lg bg-hover" />
			<span data-sk="model" className="h-8 shrink-0 rounded-lg bg-hover" />
			{/* behind "⋯" on a narrow composer: thinking level, guard, model guidance (#641), Full / Light, the goal */}
			<span data-sk="thinking" className={more} />
			<span data-sk="guard" className={more} />
			<span data-sk="guidance" className={more} />
			<span data-sk="mode" className={more} />
			<span data-sk="goal" className={more} />
			<span data-sk="approval" className="h-8 shrink-0 rounded-lg bg-hover" />
			{/* unattended mode (#646): a square, in every language and at every width */}
			<span data-sk="unattended" className="h-8 w-8 shrink-0 rounded-lg bg-hover" />
			<span
				data-sk="more"
				className="hidden h-8 shrink-0 rounded-lg bg-hover composer-narrow:order-last composer-narrow:block"
			/>
		</span>
	);
}

export function NewChat() {
	const t = useT();
	const { sessions, sessionsLoaded, meta, setView, toast } = useApp(
		useShallow((s) => ({
			sessions: s.sessions,
			sessionsLoaded: s.sessionsLoaded,
			meta: s.meta,
			setView: s.setView,
			toast: s.toast,
		})),
	);
	const recent = useMemo(() => {
		const seen = new Set<string>();
		const out: string[] = [];
		for (const s of sessions) {
			if (s.cwd && !seen.has(s.cwd)) {
				seen.add(s.cwd);
				out.push(s.cwd);
			}
		}
		return out.slice(0, 8);
	}, [sessions]);
	const [cwd, setCwd] = useState<string>(() => localStorage.getItem(PREF.cwd) ?? "");
	const [browse, setBrowse] = useState(false);
	const pickerOpened = useRef(false);
	pickerOpened.current ||= browse;
	const [showAdvanced, setShowAdvanced] = useState(false);
	const [flags, setFlags] = useState<CliFlag[]>([]);
	const [values, setValues] = useState<Record<string, string | boolean>>({});
	const [warmId, setWarmId] = useState<string | null>(null);
	const [warmError, setWarmError] = useState<string | null>(null);
	/** The warm-up failed because the connection dropped: it is asked for again once connected. */
	const warmLost = useRef(false);
	/** Bumped to start a fresh warm-up process (the previous one exited, e.g. after a server restart). */
	const [warmGen, setWarmGen] = useState(0);
	/** What the message sent from here becomes: a prompt (off), the start of a guided goal, or the goal itself. */
	const [goalMode, setGoalMode] = useState<"off" | "guided" | "direct">("off");
	/** The permission mode picked here, kept for the processes started after the folder or options change. */
	const [approval, setApproval] = useState<ApprovalMode | undefined>();
	const approvalAtStart = useRef(approval);
	approvalAtStart.current = approval;
	/** What was picked of the guard here (its own settings over the global ones), kept for the processes started after the folder or options change. */
	const [guard, setGuard] = useState<GuardOverride | null>(null);
	const guardAtStart = useRef(guard);
	guardAtStart.current = guard;
	/**
	 * What was picked of the model guidance here (#641), kept for the processes started after the folder or options change
	 * (a pick on a running process is applied to it at once, by the picker itself): a template's id and the text it stood
	 * for when it was picked, or text written here. Null: none. It starts as the template Settings makes the default for new
	 * chats (by id: the server reads its text; one deleted since carries nothing). A ref, so that a pick costs no render.
	 */
	const [startGuidance] = useState(defaultGuidance);
	const guidancePick = useRef<SessionGuidance | null>(startGuidance);
	/**
	 * Whether the conversation starts unattended (#646): Settings' default until the person flips the switch here; kept for the
	 * processes started after the folder or options change (a flip on a running process is applied to it by the switch itself).
	 */
	const unattendedPick = useRef(localStorage.getItem(PREF.unattended) === "on");
	const composer = useRef<ComposerHandle>(null);
	useGoalRequest((mode) => {
		setGoalMode(mode);
		composer.current?.focus();
	});
	const sent = useRef(false);
	/** The warm-up process runs in the mode selected when it starts (Full or Light, on Light's own models or a local server's): another needs another process. */
	const mode = useMode(selectMode);
	const local = useMode((s) => runsLocal(s.state));

	// The folder defaults to the most recent project once the sessions are known: they arrive after `meta`, so
	// defaulting earlier is what used to start omp in `~`. With no sessions the folder stays unset and omp is not
	// started until one is chosen.
	useEffect(() => {
		if (!cwd && sessionsLoaded && recent[0]) setCwd(recent[0]);
	}, [cwd, sessionsLoaded, recent]);
	const needsFolder = !cwd && sessionsLoaded;

	useEffect(() => {
		api
			.cli()
			.then((inv) => setFlags(sessionFlags(inv.flags)))
			.catch(() => {});
	}, []);

	// A process on a local server runs on its models only: a flag that picks another model would override that.
	const shownFlags = useMemo(
		() => (local ? flags.filter((f) => !MODEL_FLAGS.includes(f.name)) : flags),
		[flags, local],
	);
	const args = useMemo(() => {
		const out: string[] = [];
		for (const f of shownFlags) {
			const v = values[f.name];
			if (v === true) out.push(f.name);
			else if (typeof v === "string" && v.trim()) out.push(`${f.name}=${v.trim()}`);
		}
		return out;
	}, [shownFlags, values]);
	const argsKey = args.join("\u0000");

	/**
	 * The pickers' choices, per kind of models (the person's own, which Full and Light share, or a local server's): put on
	 * the process warmed up after the one they were made on (folder or options changed).
	 */
	const picks = useRef<Record<"own" | "local", Picks>>({ own: {}, local: {} });
	const remember = (liveId: string, change: (before: Picks) => Picks) => {
		// The models the process was started on, which is what the choice belongs to: not the ones the page shows by now.
		const on = runsLocal(useApp.getState().lives[liveId]?.info ?? useMode.getState().state) ? "local" : "own";
		picks.current[on] = change(picks.current[on]);
	};

	// Pre-start omp for the chosen directory so commands, models and thinking levels are live. The process is shown
	// (`warmId`) once it runs with the pickers' choices on it, so a message is never sent to the defaults.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `warmGen`, `mode` and `local` restart the warm-up process.
	useEffect(() => {
		if (!cwd) return;
		let cancelled = false;
		let started: string | null = null;
		setWarmId(null);
		setWarmError(null);
		const timer = setTimeout(() => {
			// Asked for with the process, not with the page: they are here by the time it runs (the pickers) or asks for
			// something (the cards), and the fetch does not compete with the conversation list's first paint.
			preloadPickers();
			preloadUIRequests();
			void (async () => {
				let id: string;
				try {
					id = await openLive({
						kind: "new",
						cwd,
						args: argsKey ? argsKey.split("\u0000") : [],
						// The server's own default until it has told the page which it is: a start that names a mode would guess.
						...(useMode.getState().state ? { mode } : {}),
						approvalMode: approvalAtStart.current,
						...(guardAtStart.current ? { guard: guardAtStart.current } : {}),
						...(guidancePick.current ? { guidance: guidancePick.current } : {}),
						unattended: unattendedPick.current,
					});
				} catch (e) {
					if (cancelled) return;
					setWarmError(errorText(e));
					warmLost.current = e instanceof ReplyError && e.code === "connection-lost";
					return;
				}
				started = id;
				if (cancelled) {
					closeLive(id);
					return;
				}
				// The process's own kind of models: what the choices belong to (the page's may have moved on while it started).
				const on = runsLocal(useApp.getState().lives[id]?.info ?? useMode.getState().state) ? "local" : "own";
				const lost = await applyPicks(picks.current[on], pickIo(id), () => !cancelled);
				if (cancelled) return;
				if (lost.length > 0) {
					picks.current[on] = withoutLost(picks.current[on], lost);
					for (const l of lost) toast("warning", t("pages.newPickLost", { what: l.what, error: l.error }));
				}
				setWarmId(id);
			})();
		}, 250);
		return () => {
			cancelled = true;
			clearTimeout(timer);
			if (started && !sent.current) closeLive(started);
		};
	}, [cwd, argsKey, warmGen, mode, local]);

	// Only the warm-up process's own record: a frame of another conversation streaming is none of this page's business.
	const live = useApp((s) => (warmId ? s.lives[warmId] : undefined));
	useEffect(() => {
		if (warmId) preloadQuota();
	}, [warmId]);
	const thinking = selectedThinking(live, undefined, useStartConfig(live));
	/**
	 * What the picker shows of the guidance: the warm-up process's own, which is what the next message carries (a pick on it
	 * is applied by the picker at once, so this follows within a frame).
	 */
	const guidanceLive: LiveGuidance | null = live?.info.guidance ?? null;
	const warmExited = Boolean(live?.info.exited);
	const connected = useApp((s) => s.connected);
	/** Start the warm-up again: the process exited, the start failed, or what made it fail has changed. */
	const restartWarmUp = useCallback(() => setWarmGen((g) => g + 1), []);
	// Replace a warm-up process that exited, or one that failed to start because the
	// connection dropped (server restart) — once connected, so the request is not lost.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-evaluated on (re)connect and exit only; retrying on every warmError would loop on genuine errors.
	useEffect(() => {
		if (!connected || sent.current) return;
		if (warmExited || (warmError && warmLost.current)) restartWarmUp();
	}, [connected, warmExited]);
	// A start that failed on a setting (an offline backend that did not answer, a changed address) is tried again when
	// the settings change, without a click: the user fixed what was wrong somewhere else. What counts is what the
	// settings say, not the server's revision, which counts every read. Not on every error: one that stands (a folder
	// that does not exist) is retried by the button.
	const settings = useMode((s) => {
		if (!s.state) return "";
		const { boot: _boot, rev: _rev, ...said } = s.state;
		return JSON.stringify(said);
	});
	const failed = useRef(false);
	failed.current = warmError !== null;
	// biome-ignore lint/correctness/useExhaustiveDependencies: `settings` is the trigger; whether the start failed is read when it changes.
	useEffect(() => {
		if (failed.current && !sent.current) restartWarmUp();
	}, [settings]);

	const send = async (text: string, images: ImageAttachment[]) => {
		if (!cwd) {
			// No folder, so no omp is running yet: ask for one and keep the draft.
			setBrowse(true);
			return false;
		}
		if (!warmId) {
			if (warmError) {
				// Not starting at all: say why, and try again, rather than claim it is on its way.
				toast("error", warmError);
				restartWarmUp();
			} else {
				toast("warning", t("pages.newStarting"));
			}
			return false;
		}
		const imgs = images.map(({ type, data, mimeType }) => ({ type, data, mimeType }));
		const command = text.startsWith("!");
		// A `!command` with attached text files is a message, as with pictures. The message format is loaded only when
		// the text could carry files: this module is part of the first page load, and it is not.
		const withFiles =
			command && text.includes("<file name=") && (await import("@shared/attachment.ts")).hasTextFiles(text);
		// A goal that starts at once has no way to carry a picture (omp's `goal` takes an objective and a budget):
		// refused with the draft kept, rather than started without them.
		if (goalMode === "direct" && !command && imgs.length > 0) {
			toast("warning", t("pages.newGoalNoImages"));
			return false;
		}
		setPref(PREF.cwd, cwd);
		const open = () => {
			sent.current = true;
			// omp may have named the conversation's file already, as the warmed-up process started: the address is then its own.
			setView({ kind: "chat", file: useApp.getState().lives[warmId]?.info.sessionFile ?? null, liveId: warmId });
		};
		try {
			if (command && imgs.length === 0 && !withFiles) {
				// Runs in the background (omp replies when it exits); the chat shows it with a Stop.
				open();
				runBash(warmId, text.slice(1).trim());
				return true;
			}
			// Prompts are acknowledged as soon as omp accepts them: switch only then, so a
			// failure keeps the draft and attachments here. A !command with pictures or files is a message, as in a
			// conversation (omp's bash takes no images), and never a goal.
			if (!command && goalMode === "guided") await startGuidedGoal(warmId, text, { images: imgs });
			else if (!command && goalMode === "direct") await createGoal(warmId, text);
			else await socket.rpc(warmId, { type: "prompt", message: text, images: imgs });
			open();
			return true;
		} catch (e) {
			toast("error", (e as Error).message);
			return sent.current;
		}
	};

	// The goal and its "skip the questions" go together: one group that wraps as one (C2), never a line of its own. It is
	// New chat's own, not the pickers' chunk's: it goes behind "⋯" with them where the chunk is there, and stands alone
	// in the footer where that chunk is gone (a toast says so), so a goal can still be started.
	const goalSwitches = (
		<span className="inline-flex shrink-0 items-center gap-1" data-testid="goal-switches">
			<button
				type="button"
				aria-pressed={goalMode !== "off"}
				data-testid="goal-mode"
				title={t("pages.newGoalTitle")}
				className={cx(
					"inline-flex h-8 items-center gap-1 rounded-lg px-2 text-xs",
					goalMode !== "off" ? "bg-accent-soft text-accent" : "text-muted hover:bg-hover hover:text-fg",
				)}
				onClick={() => setGoalMode((g) => (g === "off" ? "guided" : "off"))}
			>
				<Target size={14} /> {t("pages.newGoal")}
			</button>
			{goalMode !== "off" ? (
				<button
					type="button"
					aria-pressed={goalMode === "direct"}
					data-testid="goal-direct"
					title={t("pages.newGoalDirectTitle")}
					className={cx(
						"inline-flex h-8 items-center rounded-lg px-2 text-xs",
						goalMode === "direct" ? "bg-accent-soft text-accent" : "border border-border text-fg hover:bg-hover",
					)}
					onClick={() => setGoalMode((g) => (g === "direct" ? "guided" : "direct"))}
				>
					{t("pages.newGoalDirect")}
				</button>
			) : null}
		</span>
	);

	return (
		<div className="flex h-full flex-1 flex-col items-center overflow-y-auto px-4">
			<div className="flex w-full max-w-3xl flex-1 flex-col justify-center py-10">
				<h1 className="mb-8 text-center font-serif text-3xl tracking-tight sm:text-4xl">
					<span className="text-accent">✻</span> {greeting(t)}
				</h1>
				{/* The folder (a long path) and the recent ones wrap among themselves; the meter and Options keep the first row, at
				    its right, however long the path is. The group is as tall as the folder button, so they line up with it. */}
				<div className="mb-3 flex items-start gap-2">
					<div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
						<button
							type="button"
							data-testid="cwd-picker"
							title={cwd || undefined}
							className={cx(
								"inline-flex max-w-full items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs",
								needsFolder
									? "border-accent/50 bg-accent-soft font-medium text-accent hover:bg-accent/20"
									: "border-border bg-surface hover:bg-hover",
							)}
							onPointerEnter={preloadDirBrowser}
							onClick={() => setBrowse(true)}
						>
							<FolderOpen size={14} className="shrink-0 text-accent" />
							<span className="truncate">{cwd ? shortPath(cwd, meta?.home) : t("pages.newChooseFolder")}</span>
							<ChevronDown size={12} className="shrink-0" />
						</button>
						{recent
							.filter((r) => r !== cwd)
							.slice(0, 4)
							.map((r) => (
								<button
									type="button"
									key={r}
									className="truncate rounded-lg px-2 py-1 text-xs text-muted hover:bg-hover hover:text-fg"
									onClick={() => setCwd(r)}
								>
									{shortPath(r, meta?.home).split("/").pop() || r}
								</button>
							))}
					</div>
					<div className="flex h-[1.875rem] shrink-0 items-center gap-2">
						{live?.state?.model?.provider ? (
							// A chunk that is gone is a toast, not the Reload screen: the page stays, without the meter.
							<ErrorBoundary
								fallback={() => null}
								onError={() => {
									retryQuota();
									toast("error", t("shell.errorQuotaLoad"));
								}}
							>
								<Suspense fallback={null}>
									<Quota provider={live.state.model.provider} active={false} model={live.state.model.id} />
								</Suspense>
							</ErrorBoundary>
						) : null}
						<button
							type="button"
							className={cx(
								"inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs",
								showAdvanced ? "bg-hover text-fg" : "text-muted hover:bg-hover",
							)}
							onClick={() => setShowAdvanced((s) => !s)}
							aria-expanded={showAdvanced}
						>
							<SlidersHorizontal size={13} />{" "}
							{args.length ? t("pages.newOptionsCount", { n: args.length }) : t("pages.newOptions")}
						</button>
					</div>
				</div>
				{showAdvanced ? <FlagForm flags={shownFlags} values={values} onChange={setValues} /> : null}
				{live ? (
					// A chunk that is gone is a toast, not the Reload screen: the page stays, without the cards.
					<ErrorBoundary
						fallback={() => null}
						resetKey={warmId}
						onError={() => {
							retryUIRequests();
							toast("error", t("shell.errorRequestsLoad"));
						}}
					>
						<Suspense fallback={null}>
							<UIRequests live={live} />
						</Suspense>
					</ErrorBoundary>
				) : null}
				<Composer
					ref={composer}
					draftKey="new"
					commands={live?.commands ?? []}
					cwd={cwd}
					predictLive={warmId}
					uploadScope={warmId ? { live: warmId, file: null } : null}
					streaming={false}
					onSend={(text, imgs) => send(text, imgs)}
					placeholder={
						goalMode === "guided"
							? t("pages.newGoalPlaceholder")
							: goalMode === "direct"
								? t("pages.newGoalDirectPlaceholder")
								: t("pages.newPlaceholder")
					}
					footer={
						warmId ? (
							<ErrorBoundary
								fallback={() => goalSwitches}
								resetKey={warmId}
								onError={() => {
									retryPickers();
									toast("error", t("shell.errorPickersLoad"));
								}}
							>
								<Suspense fallback={<PickersSkeleton />}>
									<Pickers
										liveId={warmId}
										model={live?.state?.model}
										thinking={thinking}
										onPreset={(preset) => remember(warmId, (b) => pickPreset(b, preset))}
										onModel={(model) => remember(warmId, (b) => pickModel(b, model))}
										onThinking={(level) => remember(warmId, (b) => pickThinking(b, level))}
										onApproval={setApproval}
										onGuard={setGuard}
										guidance={guidanceLive}
										onGuidance={(pick) => {
											guidancePick.current = pick;
										}}
										guidanceDisabled={local}
										unattended={unattendedPick}
										more={goalSwitches}
									/>
								</Suspense>
							</ErrorBoundary>
						) : !cwd ? (
							<span className="truncate px-2 text-xs text-muted">{t("pages.newPickFolder")}</span>
						) : warmError ? (
							<>
								<ErrorBoundary fallback={() => null} onError={retryModeChip}>
									<Suspense fallback={null}>
										<ModeChip />
									</Suspense>
								</ErrorBoundary>
								<span className="min-w-0 break-words px-2 text-xs text-danger" data-testid="new-chat-error">
									{warmError}
								</span>
								<Button size="sm" variant="ghost" onClick={restartWarmUp}>
									<RotateCw size={13} /> {t("common.retry")}
								</Button>
							</>
						) : (
							<span className="inline-flex items-center gap-1.5 px-2 text-xs text-faint">
								<Spinner size={12} /> {t("pages.newStartingOmp")}
							</span>
						)
					}
				/>
			</div>
			{/* Mounted when the picker is first opened, and kept: it is a chunk of its own (see `DirBrowser.tsx`). */}
			{pickerOpened.current ? (
				<ErrorBoundary fallback={() => null} onError={retryDirBrowser}>
					<Suspense fallback={null}>
						<DirBrowser
							open={browse}
							onOpenChange={setBrowse}
							start={cwd || meta?.home || ""}
							onPick={(p) => setCwd(p)}
							creatable
						/>
					</Suspense>
				</ErrorBoundary>
			) : null}
		</div>
	);
}

function FlagForm({
	flags,
	values,
	onChange,
}: {
	flags: CliFlag[];
	values: Record<string, string | boolean>;
	onChange: (v: Record<string, string | boolean>) => void;
}) {
	const t = useT();
	const [q, setQ] = useState("");
	const shown = flags.filter((f) => !q || f.name.includes(q) || f.description.toLowerCase().includes(q.toLowerCase()));
	const ime = useImeGuard();
	/** What is typed in a value field and not applied yet. Applying it replaces the warm-up process, so it waits for the field to be left or Enter. */
	const [drafts, setDrafts] = useState<Record<string, string>>({});
	const commit = (name: string) => {
		const draft = drafts[name];
		if (draft === undefined) return;
		setDrafts(({ [name]: _, ...rest }) => rest);
		if (draft !== (values[name] ?? "")) onChange({ ...values, [name]: draft });
	};
	return (
		<div className="mb-3 rounded-2xl border border-border bg-surface p-3" data-testid="flag-form">
			{/* Wraps: on a phone the filter takes a row of its own rather than squeezing the note into a column beside it. */}
			<div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1.5">
				<span className="shrink-0 text-xs font-medium">{t("pages.newSessionOptions")}</span>
				<span className="min-w-0 flex-1 basis-48 text-xs text-faint">
					{t("pages.newOptionsFrom")} <code>omp --help</code>
					{t("pages.newOptionsApplied")}
				</span>
				<input
					aria-label={t("pages.newFilterAria")}
					placeholder={t("pages.newFilter")}
					value={q}
					onChange={(e) => setQ(e.target.value)}
					className="ml-auto w-36 rounded-md border border-border bg-bg-soft px-2 py-1 text-xs outline-none focus:border-faint"
				/>
			</div>
			{/* `minmax(0, 1fr)`: a column no wider than the card, which a value field's own width would otherwise push past it. */}
			<div className="grid max-h-72 grid-cols-[minmax(0,1fr)] gap-x-4 gap-y-1 overflow-y-auto sm:grid-cols-[repeat(2,minmax(0,1fr))]">
				{shown.map((f) =>
					f.value ? (
						<label
							key={f.name}
							className="flex items-center gap-2 rounded-md px-1 py-1 text-xs hover:bg-hover"
							title={f.description}
						>
							<span className="w-32 shrink-0 truncate font-mono text-muted">{f.name}</span>
							<input
								aria-label={f.name}
								data-flag={f.name}
								placeholder={f.value.replace(/[<>]/g, "")}
								value={drafts[f.name] ?? (typeof values[f.name] === "string" ? (values[f.name] as string) : "")}
								onChange={(e) => setDrafts({ ...drafts, [f.name]: e.target.value })}
								onCompositionEnd={ime.onCompositionEnd}
								onBlur={() => commit(f.name)}
								onKeyDown={(e) => {
									// Enter that confirms an input method's word is not the user applying the option.
									if (e.key === "Enter" && !ime.imeKey(e)) commit(f.name);
								}}
								className="min-w-0 flex-1 rounded border border-border bg-bg-soft px-1.5 py-0.5 font-mono outline-none focus:border-faint"
							/>
						</label>
					) : (
						<label
							key={f.name}
							className="flex items-center gap-2 rounded-md px-1 py-1 text-xs hover:bg-hover"
							title={f.description}
						>
							<input
								type="checkbox"
								data-flag={f.name}
								checked={values[f.name] === true}
								onChange={(e) => onChange({ ...values, [f.name]: e.target.checked })}
							/>
							<span className="truncate font-mono text-muted">{f.name}</span>
						</label>
					),
				)}
			</div>
		</div>
	);
}
