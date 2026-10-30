import * as Popover from "@radix-ui/react-popover";
import type { CompactAt } from "@shared/compact-at.ts";
import { type CompactWhere, compactWhereOf } from "@shared/compact-queue.ts";
import { runsLocal } from "@shared/offline.ts";
import { PREF } from "@shared/prefs.ts";
import {
	type ClaudeSlowMode,
	type ConfigValue,
	matchesDefault,
	type ServiceTierFamily,
	type SessionDefault,
	type SessionSettings,
	serviceTierFamily,
	type Unreported,
} from "@shared/session-defaults.ts";
import { Archive, ChevronRight, Pause, SlidersHorizontal, Star } from "lucide-react";
import {
	lazy,
	type Ref,
	type RefObject,
	Suspense,
	useCallback,
	useEffect,
	useId,
	useImperativeHandle,
	useRef,
	useState,
} from "react";
import { en as helpEn } from "../i18n/controls-help.ts";
import "../i18n/later.ts";
import { type MessageKey, registerStrings, useT } from "../i18n/index.ts";
import { controls, type PanelConfigState } from "../lib/api.ts";
import { cancelCompact, queueCompact } from "../lib/compact-queue.ts";
import { useCompactWherePref } from "../lib/compact-where.ts";
import { setPref } from "../lib/prefs.ts";
import { type StartLive, useOpenAfterStart } from "../lib/start-live.ts";
import { STEP_UNAVAILABLE_TEXT } from "../lib/step-unavailable.ts";
import { socket } from "../lib/ws.ts";
import { continueConversation, refreshState, useApp } from "../store/app.ts";
import { setConversationCompactAt } from "../store/compact-at.ts";
import type { LiveState } from "../store/live.ts";
import { COMPACT_AT_HELP, CompactAtRow, compactAtText } from "./CompactAtRow.tsx";
import { INFO_BOX, InfoButton } from "./InfoButton.tsx";
import { Button, cx, IconButton, Select, Spinner } from "./ui.tsx";

// The explanations are opened by a click: their strings travel with this chunk, not with the first page.
registerStrings("controlsHelp", helpEn);

// The conversation's own guard ("Guard dangerous commands"): a chunk of its own, with its strings; loaded when the panel opens.
const SessionGuard = lazy(() => import("./SessionGuard.tsx"));
// Full or Light for this conversation: restarts its omp, so it is a chunk of its own, loaded with the panel.
const SessionMode = lazy(() => import("./SessionMode.tsx"));

type Choice = { value: string; label: string };

/** The providers' own names, which omp's service tiers are named after. */
const FAMILY_NAMES: Record<ServiceTierFamily, string> = { anthropic: "Anthropic", openai: "OpenAI", google: "Google" };

/**
 * What a setting's "About" disclosure says: what it does, what each choice (by its value) means, what it costs, and what
 * to pick. The text is in `i18n/controls-help.ts`.
 */
interface Help {
	what: MessageKey;
	choices: Record<string, MessageKey>;
	cost: MessageKey;
	advice: MessageKey;
}

const HELP = {
	autoCompaction: {
		what: "controlsHelp.autoCompactionWhat",
		choices: { on: "controlsHelp.autoCompactionOn", off: "controlsHelp.autoCompactionOff" },
		cost: "controlsHelp.autoCompactionCost",
		advice: "controlsHelp.autoCompactionAdvice",
	},
	autoRetry: {
		what: "controlsHelp.autoRetryWhat",
		choices: { on: "controlsHelp.autoRetryOn", off: "controlsHelp.autoRetryOff" },
		cost: "controlsHelp.autoRetryCost",
		advice: "controlsHelp.autoRetryAdvice",
	},
	steeringMode: {
		what: "controlsHelp.steeringModeWhat",
		choices: {
			"one-at-a-time": "controlsHelp.steeringModeOneAtATime",
			all: "controlsHelp.steeringModeAll",
		},
		cost: "controlsHelp.steeringModeCost",
		advice: "controlsHelp.steeringModeAdvice",
	},
	followUpMode: {
		what: "controlsHelp.followUpModeWhat",
		choices: {
			"one-at-a-time": "controlsHelp.followUpModeOneAtATime",
			all: "controlsHelp.followUpModeAll",
		},
		cost: "controlsHelp.followUpModeCost",
		advice: "controlsHelp.followUpModeAdvice",
	},
	interruptMode: {
		what: "controlsHelp.interruptModeWhat",
		choices: {
			immediate: "controlsHelp.interruptModeImmediately",
			wait: "controlsHelp.interruptModeWait",
		},
		cost: "controlsHelp.interruptModeCost",
		advice: "controlsHelp.interruptModeAdvice",
	},
	fastMode: {
		what: "controlsHelp.fastModeWhat",
		choices: { on: "controlsHelp.fastModeOn", off: "controlsHelp.fastModeOff" },
		cost: "controlsHelp.fastModeCost",
		advice: "controlsHelp.fastModeAdvice",
	},
	// Claude's slow mode as its own row, for a conversation whose active model is of another provider.
	claudeSlowMode: {
		what: "controlsHelp.slowModeLowPriorityWhat",
		choices: { on: "controlsHelp.slowModeLowPriorityOn", off: "controlsHelp.slowModeLowPriorityOff" },
		cost: "controlsHelp.slowModeLowPriorityCost",
		advice: "controlsHelp.slowModeLowPriorityAdvice",
	},
	// What a model whose slow mode is not known to be either of the two below is told; see `SLOW_HELP`.
	slowMode: {
		what: "controlsHelp.slowModeGenericWhat",
		choices: { on: "controlsHelp.slowModeGenericOn", off: "controlsHelp.slowModeGenericOff" },
		cost: "controlsHelp.slowModeGenericCost",
		advice: "controlsHelp.slowModeGenericAdvice",
	},
	cacheWarming: {
		what: "controlsHelp.cacheWarmingWhat",
		choices: {
			off: "controlsHelp.cacheWarmingOff",
			streaming: "controlsHelp.cacheWarmingStreaming",
			idle: "controlsHelp.cacheWarmingIdle",
		},
		cost: "controlsHelp.cacheWarmingCost",
		advice: "controlsHelp.cacheWarmingAdvice",
	},
	compact: {
		what: "controlsHelp.compactWhat",
		choices: {},
		cost: "controlsHelp.compactCost",
		advice: "controlsHelp.compactAdvice",
	},
	// Where omp compacts by itself ("Compact at"): omp's two settings, not an RPC command.
	compactAt: {
		what: COMPACT_AT_HELP.what,
		choices: {},
		cost: COMPACT_AT_HELP.cost,
		advice: COMPACT_AT_HELP.advice,
	},
} satisfies Record<string, Help>;

type HelpId = keyof typeof HELP;

/** Slow mode is two mechanisms, and the row explains only the one its model has (`slowModeVariant`). */
const SLOW_HELP = {
	lowPriority: HELP.claudeSlowMode,
	flex: {
		what: "controlsHelp.slowModeFlexWhat",
		choices: { on: "controlsHelp.slowModeFlexOn", off: "controlsHelp.slowModeFlexOff" },
		cost: "controlsHelp.slowModeFlexCost",
		advice: "controlsHelp.slowModeFlexAdvice",
	},
	generic: HELP.slowMode,
} satisfies Record<string, Help>;

/**
 * Which of omp's two slow modes the active model has. omp says it (`slowModeScope`): `global` is Claude's low-priority
 * lane at the plan's usage limit, which `set_slow_mode` saves in omp's `config.yml`; `session` is the provider's flex
 * tier, which belongs to the conversation. An omp that does not say falls back to the model's provider family, and
 * where that is not known either, the row claims neither.
 */
function slowModeVariant(
	scope: "global" | "session" | undefined,
	family: ServiceTierFamily | null,
): "lowPriority" | "flex" | "generic" {
	if (scope === "global") return "lowPriority";
	if (scope === "session") return "flex";
	if (family === "anthropic") return "lowPriority";
	if (family === "openai" || family === "google") return "flex";
	return "generic";
}

/** Which setting's explanation is open, and how a row opens and closes it. */
interface HelpState {
	open: HelpId | null;
	toggle: (id: HelpId) => void;
}

/** One setting's explanation. `choices`: what the row offers, in order, with the label each is shown under. */
function HelpText({
	id,
	testid,
	help,
	choices,
}: {
	id: string;
	testid: string;
	help: Help;
	choices: readonly Choice[];
}) {
	const t = useT();
	const ref = useRef<HTMLDivElement>(null);
	// It opens under the row the user pressed: where the panel scrolls, bring it into view. The panel is still being
	// filled in when that happens (a row that omp's configuration adds, a note that arrives), and what grows above the
	// explanation pushes it out of view again: it is brought back, until the user takes the scrolling over.
	useEffect(() => {
		const el = ref.current;
		if (!el) return;
		el.scrollIntoView?.({ block: "nearest" });
		let scroller: HTMLElement | null = el.parentElement;
		while (scroller && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
		if (!scroller || typeof ResizeObserver === "undefined") return;
		const panel = scroller;
		const follow = new ResizeObserver(() => el.scrollIntoView?.({ block: "nearest" }));
		for (const child of Array.from(panel.children)) follow.observe(child);
		const stop = () => follow.disconnect();
		const taken = ["wheel", "touchmove", "pointerdown", "keydown"] as const;
		for (const type of taken) panel.addEventListener(type, stop, { passive: true, once: true });
		return () => {
			follow.disconnect();
			for (const type of taken) panel.removeEventListener(type, stop);
		};
	}, []);
	return (
		<div ref={ref} id={id} data-testid={`${testid}-help`} className={INFO_BOX}>
			<p>{t(help.what)}</p>
			{choices.length > 0 ? (
				<ul className="space-y-0.5">
					{choices.map((c) =>
						help.choices[c.value] ? (
							<li key={c.value}>
								<span className="font-medium text-fg">{c.label}</span>: {t(help.choices[c.value])}
							</li>
						) : null,
					)}
				</ul>
			) : null}
			<p>
				<span className="font-medium text-fg">{t("panel.controlsHelpCost")}</span> {t(help.cost)}
			</p>
			<p>
				<span className="font-medium text-fg">{t("panel.controlsHelpAdvice")}</span> {t(help.advice)}
			</p>
		</div>
	);
}

function Segmented({
	label,
	value,
	choices,
	onChange,
	testid,
	onSetDefault,
	defaultBlocked,
	defaultName,
	isDefault,
	note,
	help,
	helpId,
	helpText,
}: {
	label: string;
	value: string | undefined;
	choices: Choice[];
	onChange: (v: string) => void;
	testid: string;
	/** Make the shown value omp's global default; with the row's label and the chosen button's label. Absent: it has no default of its own. */
	onSetDefault?: (label: string, value: string, shown: string) => void;
	/** Why the star cannot be pressed now, which is also its name. */
	defaultBlocked?: string;
	/** What the star's setting is called when that is more than the row's label. */
	defaultName?: string;
	/** The row shows what omp already starts new conversations with: the star is filled, and pressing it saves nothing. */
	isDefault?: boolean;
	/** What is different about this row (where its value lives), shown under it. Absent: nothing to say. */
	note?: string;
	/** Which explanation the row's "About" button opens, and whether it is open. */
	help: HelpState;
	helpId: Exclude<HelpId, "compact">;
	/** What the explanation says when it is not the fixed one of `helpId` (it follows the model). */
	helpText?: Help;
}) {
	const t = useT();
	const noteId = useId();
	const helpDomId = useId();
	const helpOpen = help.open === helpId;
	return (
		<fieldset
			className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 py-1.5"
			data-testid={testid}
			aria-describedby={note ? noteId : undefined}
		>
			<legend className="float-left text-sm">{label}</legend>
			<div className="flex items-center gap-1">
				<div className="flex rounded-lg border border-border p-0.5">
					{choices.map((c) => (
						<label
							key={c.value}
							className={cx(
								"cursor-pointer rounded-md px-2 py-0.5 text-xs has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
								value === c.value ? "bg-accent-soft text-accent" : "text-muted hover:text-fg",
							)}
						>
							<input
								type="radio"
								className="sr-only"
								name={testid}
								value={c.value}
								checked={value === c.value}
								onChange={() => onChange(c.value)}
							/>
							{c.label}
						</label>
					))}
				</div>
				<InfoButton
					label={label}
					testid={testid}
					open={helpOpen}
					controls={helpDomId}
					onToggle={() => help.toggle(helpId)}
				/>
				{onSetDefault ? (
					<IconButton
						size="xs"
						label={
							defaultBlocked ??
							t(isDefault ? "controlsHelp.starIsDefault" : "panel.controlsSetDefault", { label: defaultName ?? label })
						}
						data-testid={`${testid}-set-default`}
						// Filled (and said, not by colour alone) where the row already is the default: pressing it saves nothing.
						aria-pressed={isDefault === true}
						// Until the row has a value (omp's state has not arrived, or its configuration could not be read) there
						// is nothing to make the default.
						disabled={value === undefined || defaultBlocked !== undefined}
						onClick={() => {
							if (isDefault) return;
							const shown = choices.find((c) => c.value === value);
							if (value !== undefined && shown) onSetDefault(defaultName ?? label, value, shown.label);
						}}
					>
						<Star
							size={13}
							className={isDefault ? "text-accent" : undefined}
							fill={isDefault ? "currentColor" : "none"}
						/>
					</IconButton>
				) : null}
			</div>
			{note ? (
				<p className="w-full text-xs text-muted" id={noteId} data-testid={`${testid}-note`}>
					{note}
				</p>
			) : null}
			{helpOpen ? <HelpText id={helpDomId} testid={testid} help={helpText ?? HELP[helpId]} choices={choices} /> : null}
		</fieldset>
	);
}

/** What the narrow column's More menu asks of the panel once it has closed: open. */
export interface SessionControlsHandle {
	open(): void;
}

/**
 * Per-session runtime settings exposed by omp's RPC (`set_*`, `compact`).
 * They apply to this omp process only and never write config.yml; each row's star is what writes omp's global
 * default for it, as Settings does for the rest. The one exception is slow mode: omp's `set_slow_mode` writes omp's
 * own `config.yml` (omp says so: `slowModeScope` is `global`), and the provider's flex tier is the conversation's own
 * (`session`); that row says which it is, and explains only that one. Their values
 * are the process's own, so
 * without a running omp (`live` undefined: a saved conversation) the first click starts it (`start`) and the panel
 * opens once it runs.
 *
 * omp reports most of them in `get_state`. Auto-retry and cache warming it only lets a client set, so their value is the
 * server's to work out: what the process was told (`LiveInfo.sessionSettings`, which every page is told of) over what
 * omp's configuration says for this process (`controls.settings`).
 *
 * A paused conversation has no omp running, so its rows are the server's snapshot taken when it paused (`live.state`,
 * saved in the parked record and sent on attach). Changing a row briefly thaws omp (as the model picker and rename do)
 * and the conversation stays paused; only Compact resumes it. The panel says so (`session-controls-paused`).
 *
 * Each row has an "About" button that opens what the setting does, what each choice means, what it costs and what to pick.
 *
 * The narrow column's More menu has no room for the panel beside it, so it closes first and then asks for the panel
 * through `ref`: `anchor` (the menu's button, which stays) is where the panel opens, and the panel has no button of its own.
 */
export function SessionControls({
	live,
	start,
	anchor,
	ref,
}: {
	live: LiveState | undefined;
	start?: StartLive;
	anchor?: RefObject<HTMLElement | null>;
	ref?: Ref<SessionControlsHandle>;
}) {
	const t = useT();
	const titleId = useId();
	const toast = useApp((s) => s.toast);
	const id = live && !live.info.exited ? live.info.liveId : null;
	const { open, starting, request } = useOpenAfterStart(id, start);
	useImperativeHandle(ref, () => ({ open: () => request(true) }), [request]);
	const st = live?.state;
	// What omp's configuration says for this process's controls omp does not report: undefined before it was read, null when it could not be.
	// `claudeSlow`: Claude's slow mode in omp's global configuration, null where there is nothing to show.
	const [read, setRead] = useState<{
		liveId: string;
		settings: SessionSettings | null;
		claudeSlow: ClaudeSlowMode | null;
		defaults: Record<string, ConfigValue> | null;
		/** Where omp compacts as this conversation's configuration has it, and the per-model entry that decides over it. */
		compact: PanelConfigState["compact"];
	} | null>(null);
	const reading = useRef(0);
	const [instructions, setInstructions] = useState("");
	const [compacting, setCompacting] = useState(false);
	// Where a compact queued now runs: what this click picked, else what Settings says (#651).
	const prefWhere = useCompactWherePref();
	const [pickedWhere, setPickedWhere] = useState<CompactWhere | null>(null);
	const where = pickedWhere ?? prefWhere;
	const [helpOpen, setHelpOpen] = useState<HelpId | null>(null);
	/** The panel's own note (what these settings are, what the star does): under the title's info button (#716). */
	const [noteOpen, setNoteOpen] = useState(false);
	const noteId = useId();
	const help: HelpState = {
		open: helpOpen,
		toggle: (which) => setHelpOpen((now) => (now === which ? null : which)),
	};
	// The folded settings (#716): open as the person last left them.
	const advancedId = useId();
	const [advancedOpen, setAdvancedOpen] = useState(() => localStorage.getItem(PREF.controlsAdvanced) === "on");
	const toggleAdvanced = () =>
		setAdvancedOpen((was) => {
			setPref(PREF.controlsAdvanced, was ? "off" : "on");
			return !was;
		});
	const reload = useCallback(async () => {
		if (!id) return;
		const mine = ++reading.current;
		const [settings, config] = await Promise.all([
			// omp's configuration could not be read: the rows say so.
			controls.settings(id).catch(() => null),
			controls.panelConfig(id).catch(() => null),
		]);
		if (mine === reading.current)
			setRead({
				liveId: id,
				settings,
				claudeSlow: config?.claudeSlow ?? null,
				defaults: config?.defaults ?? null,
				compact: config?.compact ?? null,
			});
	}, [id]);
	// A panel that opens shows what omp says and what the files say now, not what they said when it was last open.
	useEffect(() => {
		if (!open || !id) return;
		void reload();
		void refreshState(id);
		// omp saves a change of its config a moment after it is made; the server says when the file was written.
		const off = socket.on((m) => {
			if (m.t === "model_config_changed") void reload();
		});
		return () => {
			off();
			setHelpOpen(null);
		};
	}, [open, id, reload]);
	const configured = read?.liveId === id ? read.settings : undefined;
	const claudeSlow = read?.liveId === id ? read.claudeSlow : null;
	// Where omp compacts by itself: its configuration's point, the per-model entry that decides over it, and the window.
	const compactPanel = read?.liveId === id ? read.compact : null;
	const contextWindow = st?.contextUsage?.contextWindow ?? st?.model?.contextWindow;
	const compactFile = live?.info.sessionFile ?? null;
	// What a new conversation starts with, which a row that has it shows a filled star for.
	const defaults = read?.liveId === id ? read.defaults : null;
	// What this process uses: what it was told, else what its configuration says.
	const used = (setting: Unreported): string | undefined =>
		live?.info.sessionSettings?.[setting] ?? configured?.[setting];
	const setClaudeSlow = async (enabled: boolean) => {
		if (!id) return;
		try {
			await controls.setClaudeSlow(id, enabled);
			await reload();
		} catch (e) {
			toast(
				"error",
				t("panel.controlsToastFailed", { label: t("panel.controlsToastSlowMode"), error: (e as Error).message }),
			);
		}
	};
	/**
	 * Where this conversation compacts: omp's own settings, held by the process's overlay (which omp reloads by itself,
	 * so it applies from the next turn), and kept for when the conversation is opened again.
	 */
	const setCompactAt = async (at: CompactAt | null) => {
		if (!compactFile) return;
		try {
			await setConversationCompactAt(compactFile, at);
			toast(
				"success",
				at === null
					? t("panel.controlsCompactAtSavedDefault")
					: t("panel.controlsCompactAtSaved", {
							value: compactAtText(t, at, contextWindow, compactPanel?.settings ?? null),
						}),
			);
			void reload();
		} catch (e) {
			toast("error", t("panel.controlsCompactAtFailed", { error: (e as Error).message }));
		}
	};
	const send = async (command: Record<string, unknown>, label: string) => {
		if (!id) return;
		try {
			// Each is the answer to a click: a paused conversation takes it too, and stays paused.
			await socket.act(id, command);
			await refreshState(id, true);
		} catch (e) {
			toast("error", t("panel.controlsToastFailed", { label, error: (e as Error).message }));
		}
	};
	/**
	 * Compaction asks the model and takes a while: a paused conversation is let run for it (and says so), not
	 * thawed for the whole of it, which would let everything else it holds run unannounced.
	 */
	const compact = async () => {
		if (!id) return;
		setCompacting(true);
		try {
			if (await continueConversation(id)) toast("info", t("panel.controlsResumedToCompact"));
			await send(
				{ type: "compact", ...(instructions.trim() ? { customInstructions: instructions.trim() } : {}) },
				t("panel.controlsToastCompaction"),
			);
			setInstructions("");
		} catch (e) {
			toast("error", t("chat.errPause", { error: (e as Error).message }));
		} finally {
			setCompacting(false);
		}
	};
	/**
	 * While omp works, Compact is a request for the end of the turn (#651): the server holds it, with the note, and sends omp's
	 * `compact` when the turn has ended. Every page is told what waits (`LiveInfo.compactQueued`), so this one shows it after a reload.
	 */
	const queued = live?.info.compactQueued;
	const compactState: "idle" | "queue" | "queued" | "running" =
		queued?.phase === "queued"
			? "queued"
			: queued?.phase === "running" || compacting || live?.compacting
				? "running"
				: live?.streaming
					? "queue"
					: "idle";
	const queueForTurnEnd = async () => {
		if (!id) return;
		try {
			await queueCompact(id, instructions.trim(), where);
			setInstructions("");
			setPickedWhere(null);
		} catch (e) {
			toast("error", t("panel.controlsCompactQueueFailed", { error: (e as Error).message }));
		}
	};
	const cancelQueued = async () => {
		if (!id) return;
		try {
			await cancelCompact(id);
		} catch (e) {
			toast("error", t("panel.controlsCompactCancelFailed", { error: (e as Error).message }));
		}
	};
	const compactHelpId = useId();
	const compactAtHelpId = useId();
	// Fast mode is the service tier of one provider, the one the model runs on (omp's `/fast` acts on that family only).
	const family = serviceTierFamily(st?.model);
	const local = runsLocal(live?.info);
	/**
	 * What a row needs for its star: what it does (`onSetDefault`), what it is called (`defaultName`, when the setting
	 * is not the row's alone) and why it cannot (`defaultBlocked`). A conversation on a local server runs on its own agent
	 * directory, so its settings are no default of omp's (the server refuses it).
	 */
	const asDefault = (setting: SessionDefault, extra: { name?: string; blocked?: string; shown?: string } = {}) => ({
		defaultName: extra.name,
		defaultBlocked: local ? t("panel.controlsDefaultLocal") : extra.blocked,
		// What the row shows already is what omp starts new conversations with: its star is filled.
		isDefault: !local && extra.blocked === undefined && matchesDefault(setting, extra.shown, family, defaults),
		onSetDefault: async (label: string, value: string, shown: string) => {
			if (!id) return;
			try {
				await controls.setDefault(id, setting, value);
				toast("success", t("panel.controlsDefaultSet", { label, value: shown }));
				// The configuration says something else now (a conversation that was told nothing follows it).
				void reload();
			} catch (e) {
				toast("error", t("panel.controlsDefaultFailed", { label, error: (e as Error).message }));
			}
		},
	});
	/** The star of a control omp does not report: it needs a value, and when none can be read it says why. */
	const asUnreportedDefault = (setting: Unreported) =>
		asDefault(setting, {
			blocked: configured !== undefined && used(setting) === undefined ? t("panel.controlsUnreadable") : undefined,
			shown: used(setting),
		});
	const fastValue = st?.fastModeEnabled === undefined ? undefined : st.fastModeEnabled ? "on" : "off";
	const fastDefault = {
		...(family
			? { name: t("panel.controlsFastFamily", { provider: FAMILY_NAMES[family] }) }
			: { blocked: t("panel.controlsFastNoTier") }),
		shown: fastValue,
	};
	// Slow mode's label, note and explanation follow the mechanism the active model has, so they change with the model.
	const slowVariant = slowModeVariant(st?.slowModeScope, family);
	const slows: Record<
		ReturnType<typeof slowModeVariant>,
		{ label: MessageKey; help: Help; note: MessageKey | undefined }
	> = {
		lowPriority: {
			label: "controlsHelp.slowModeLabelLowPriority",
			help: SLOW_HELP.lowPriority,
			note: st?.slowModeScope === "global" ? "controlsHelp.slowModeNoteGlobal" : undefined,
		},
		flex: {
			label: "controlsHelp.slowModeLabelFlex",
			help: SLOW_HELP.flex,
			note: st?.slowModeScope === "session" ? "controlsHelp.slowModeNoteSession" : undefined,
		},
		generic: { label: "controlsHelp.slowModeLabel", help: SLOW_HELP.generic, note: undefined },
	};
	const slow = slows[slowVariant];
	const compactionValue = st?.autoCompactionEnabled === undefined ? undefined : st.autoCompactionEnabled ? "on" : "off";
	const onOff = [
		{ value: "on", label: t("panel.controlsOn") },
		{ value: "off", label: t("panel.controlsOff") },
	];
	const delivery = [
		{ value: "one-at-a-time", label: t("panel.controlsOneAtATime") },
		{ value: "all", label: t("panel.controlsAll") },
	];
	// The folded rows' stars, worked out here as well so the fold can say one of them is not omp's default.
	const autoRetryDefault = asUnreportedDefault("autoRetry");
	const steeringDefault = asDefault("steeringMode", { shown: st?.steeringMode });
	const followUpDefault = asDefault("followUpMode", { shown: st?.followUpMode });
	const interruptDefault = asDefault("interruptMode", { shown: st?.interruptMode });
	const cacheWarmingDefault = asUnreportedDefault("cacheWarming");
	const advancedChanged =
		!local &&
		defaults !== null &&
		(
			[
				[autoRetryDefault, used("autoRetry")],
				[steeringDefault, st?.steeringMode],
				[followUpDefault, st?.followUpMode],
				[interruptDefault, st?.interruptMode],
				[cacheWarmingDefault, used("cacheWarming")],
			] as const
		).some(([d, shown]) => shown !== undefined && d.defaultBlocked === undefined && !d.isDefault);
	return (
		<Popover.Root open={open} onOpenChange={request}>
			{anchor ? (
				<Popover.Anchor virtualRef={anchor as RefObject<HTMLElement>} />
			) : (
				<Popover.Trigger asChild>
					<IconButton label={t("panel.controlsTrigger")} data-testid="session-controls" aria-busy={starting}>
						{starting ? <Spinner size={16} /> : <SlidersHorizontal size={16} />}
					</IconButton>
				</Popover.Trigger>
			)}
			<Popover.Portal>
				<Popover.Content
					align="end"
					sideOffset={6}
					collisionPadding={8}
					// What does not fit the window (the nine rows, an open explanation) scrolls inside the panel.
					className="z-50 max-h-[var(--radix-popover-content-available-height)] w-96 overflow-y-auto overscroll-contain rounded-2xl border border-border bg-surface p-4 shadow-2xl"
					data-testid="session-controls-panel"
					aria-labelledby={titleId}
					// The title's info button is the first control: focused as the panel opens, its tooltip would open with
					// the panel and take the first Esc. The first setting is focused instead, as before it was there (#716).
					onOpenAutoFocus={(e) => {
						const first = [
							...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>(
								"button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)",
							),
						].find((el) => !el.closest("[data-panel-head]"));
						if (!first) return;
						e.preventDefault();
						first.focus();
					}}
					// With no button of its own, focus goes back to the one it opened from.
					onCloseAutoFocus={
						anchor
							? (e) => {
									e.preventDefault();
									anchor.current?.querySelector("button")?.focus();
								}
							: undefined
					}
				>
					<div className="mb-2 flex items-center justify-between gap-2" data-panel-head>
						<div id={titleId} className="text-sm font-semibold">
							{t("panel.controlsTitle")}
						</div>
						<InfoButton
							label={t("panel.controlsTitle")}
							testid="session-controls-note"
							open={noteOpen}
							controls={noteId}
							onToggle={() => setNoteOpen((v) => !v)}
						/>
					</div>
					{noteOpen ? (
						<p id={noteId} className={cx(INFO_BOX, "mb-3")} data-testid="session-controls-note">
							{t("panel.controlsNote")}
						</p>
					) : null}
					{live?.info.pausedAt ? (
						// omp is frozen: the rows are what the server kept of it when it was paused (`LiveAttached.state`).
						<p
							role="note"
							data-testid="session-controls-paused"
							className="mb-3 flex items-start gap-2 rounded-lg border border-border bg-bg-soft px-2.5 py-1.5 text-xs text-muted"
						>
							<Pause size={13} aria-hidden className="mt-0.5 shrink-0 text-accent" />
							{t("controlsHelp.pausedNote")}
						</p>
					) : null}
					<div className="divide-y divide-border">
						<Segmented
							label={t("panel.controlsAutoCompaction")}
							testid="auto-compaction"
							help={help}
							helpId="autoCompaction"
							{...asDefault("autoCompaction", { shown: compactionValue })}
							value={compactionValue}
							choices={onOff}
							onChange={(v) =>
								void send({ type: "set_auto_compaction", enabled: v === "on" }, t("panel.controlsAutoCompaction"))
							}
						/>
						{/* Where omp compacts by itself: omp's own settings, which the conversation's overlay carries. */}
						<CompactAtRow
							file={compactFile}
							window={contextWindow}
							settings={compactPanel?.settings ?? null}
							modelThreshold={compactPanel?.modelThreshold ?? null}
							disabled={local || !compactFile}
							onChange={(at) => void setCompactAt(at)}
							help={{
								button: (
									<InfoButton
										label={t("panel.controlsCompactAt")}
										testid="compact-at"
										open={help.open === "compactAt"}
										controls={compactAtHelpId}
										onToggle={() => help.toggle("compactAt")}
									/>
								),
								text:
									help.open === "compactAt" ? (
										<HelpText id={compactAtHelpId} testid="compact-at" help={HELP.compactAt} choices={[]} />
									) : null,
							}}
						/>
						<Segmented
							label={t("panel.controlsFastMode")}
							testid="fast-mode"
							help={help}
							helpId="fastMode"
							{...asDefault("fastMode", fastDefault)}
							value={fastValue}
							choices={onOff}
							onChange={(v) => void send({ type: "set_fast_mode", enabled: v === "on" }, t("panel.controlsFastMode"))}
						/>
						{st?.slowModeSupported ? (
							<Segmented
								label={t(slow.label)}
								testid="slow-mode"
								help={help}
								helpId="slowMode"
								helpText={slow.help}
								// Only what omp says of where the value lives is shown (`slowModeScope`); where it does not, the
								// note is left out rather than claimed.
								note={slow.note ? t(slow.note) : undefined}
								value={st.slowModeEnabled ? "on" : "off"}
								choices={onOff}
								onChange={(v) =>
									void send({ type: "set_slow_mode", enabled: v === "on" }, t("panel.controlsToastSlowMode"))
								}
							/>
						) : null}
						{claudeSlow && !(st?.slowModeSupported && slowVariant === "lowPriority") ? (
							// The active model is not Claude, so `get_state` says nothing of Claude's slow mode: it is read from, and
							// written to, omp's configuration, where it is global.
							<Segmented
								label={t("controlsHelp.slowModeLabelClaude")}
								testid="claude-slow-mode"
								help={help}
								helpId="claudeSlowMode"
								note={t("controlsHelp.slowModeNoteGlobal")}
								value={claudeSlow}
								choices={onOff}
								onChange={(v) => void setClaudeSlow(v === "on")}
							/>
						) : null}
					</div>
					{/* The settings changed least often (#716): folded, so the panel fits without a scroll. A dot says one of
					    them is not what omp starts new conversations with; the open state is remembered. */}
					<button
						type="button"
						className="mt-1 flex w-full items-center gap-1.5 rounded-lg py-1.5 text-left text-sm text-muted hover:text-fg"
						aria-expanded={advancedOpen}
						aria-controls={advancedId}
						data-testid="session-controls-advanced"
						onClick={() => toggleAdvanced()}
					>
						<ChevronRight
							size={14}
							aria-hidden
							className={cx("shrink-0 transition-transform", advancedOpen && "rotate-90")}
						/>
						{t("panel.controlsAdvanced")}
						{advancedChanged ? (
							<span
								className="h-1.5 w-1.5 rounded-full bg-accent"
								data-testid="session-controls-advanced-changed"
								role="img"
								aria-label={t("panel.controlsAdvancedChanged")}
							/>
						) : null}
					</button>
					{advancedOpen ? (
						<div id={advancedId} className="divide-y divide-border">
							<Segmented
								label={t("panel.controlsAutoRetry")}
								testid="auto-retry"
								help={help}
								helpId="autoRetry"
								{...autoRetryDefault}
								value={used("autoRetry")}
								choices={onOff}
								onChange={(v) =>
									void send({ type: "set_auto_retry", enabled: v === "on" }, t("panel.controlsAutoRetry"))
								}
							/>
							<Segmented
								label={t("panel.controlsSteeringDelivery")}
								testid="steering-mode"
								help={help}
								helpId="steeringMode"
								{...steeringDefault}
								value={st?.steeringMode}
								choices={delivery}
								onChange={(v) =>
									void send({ type: "set_steering_mode", mode: v }, t("panel.controlsToastSteeringMode"))
								}
							/>
							<Segmented
								label={t("panel.controlsFollowUpDelivery")}
								testid="follow-up-mode"
								help={help}
								helpId="followUpMode"
								{...followUpDefault}
								value={st?.followUpMode}
								choices={delivery}
								onChange={(v) =>
									void send({ type: "set_follow_up_mode", mode: v }, t("panel.controlsToastFollowUpMode"))
								}
							/>
							<Segmented
								label={t("panel.controlsInterrupt")}
								testid="interrupt-mode"
								help={help}
								helpId="interruptMode"
								{...interruptDefault}
								value={st?.interruptMode}
								choices={[
									{ value: "immediate", label: t("panel.controlsImmediately") },
									{ value: "wait", label: t("panel.controlsWait") },
								]}
								onChange={(v) =>
									void send({ type: "set_interrupt_mode", mode: v }, t("panel.controlsToastInterruptMode"))
								}
							/>
							<Segmented
								label={t("panel.controlsCacheWarming")}
								testid="cache-warming"
								help={help}
								helpId="cacheWarming"
								{...cacheWarmingDefault}
								value={used("cacheWarming")}
								choices={[
									{ value: "off", label: t("panel.controlsOff") },
									{ value: "streaming", label: t("panel.controlsStreaming") },
									{ value: "idle", label: t("panel.controlsIdle") },
								]}
								onChange={(v) =>
									void send({ type: "set_cache_warming", mode: v }, t("panel.controlsToastCacheWarming"))
								}
							/>
						</div>
					) : null}
					{id ? (
						<Suspense fallback={null}>
							<SessionGuard liveId={id} />
						</Suspense>
					) : null}
					{id ? (
						<Suspense fallback={null}>
							<SessionMode liveId={id} />
						</Suspense>
					) : null}
					<form
						className="mt-4 border-t border-border pt-3"
						onSubmit={(e) => {
							e.preventDefault();
							if (compactState === "queue") void queueForTurnEnd();
							else if (compactState === "idle") void compact();
						}}
					>
						<div className="mb-1.5 flex items-center justify-between gap-2">
							<div className="text-sm">{t("panel.controlsCompactTitle")}</div>
							<InfoButton
								label={t("panel.controlsCompactTitle")}
								testid="compact"
								open={help.open === "compact"}
								controls={compactHelpId}
								onToggle={() => help.toggle("compact")}
							/>
						</div>
						{help.open === "compact" ? (
							<div className="mb-2">
								<HelpText id={compactHelpId} testid="compact" help={HELP.compact} choices={[]} />
							</div>
						) : null}
						{compactState === "queue" ? (
							<label className="mb-2 block text-xs text-muted">
								{t("panel.controlsCompactWhere")}
								<Select
									tone="compact"
									className="mt-1"
									aria-label={t("panel.controlsCompactWhere")}
									data-testid="compact-where-choice"
									value={where}
									onChange={(e) => setPickedWhere(compactWhereOf(e.target.value) ?? "turn")}
								>
									<option value="turn">{t("panel.controlsCompactWhereTurn")}</option>
									<option value="step">{t("panel.controlsCompactWhereStep")}</option>
								</Select>
							</label>
						) : null}
						{/* The text and the button on one line: the panel fits a 1280×800 window without a scroll (#716). */}
						<div className="flex flex-wrap items-center gap-2">
							<input
								aria-label={t("panel.controlsCompactAria")}
								placeholder={t("panel.controlsCompactPlaceholder")}
								value={instructions}
								onChange={(e) => setInstructions(e.target.value)}
								className="min-w-40 flex-1 text-ellipsis rounded-lg border border-border bg-bg-soft px-2.5 py-1.5 text-xs outline-none focus:border-faint"
							/>
							<Button
								size="sm"
								type="submit"
								disabled={compactState === "queued" || compactState === "running"}
								data-testid="compact-now"
								data-state={compactState}
							>
								<Archive size={13} />{" "}
								{compactState === "running"
									? t("panel.controlsCompacting")
									: compactState === "queued"
										? t("panel.controlsCompactQueued")
										: compactState === "queue"
											? t(where === "step" ? "panel.controlsCompactAfterStep" : "panel.controlsCompactAfterTurn")
											: t("panel.controlsCompactNow")}
							</Button>
							{compactState === "queued" ? (
								<Button size="sm" type="button" onClick={() => void cancelQueued()} data-testid="compact-cancel">
									{t("panel.controlsCompactCancel")}
								</Button>
							) : null}
						</div>
						{compactState === "queued" ? (
							<div className="mt-2 text-xs text-muted" data-testid="compact-queued-note" data-where={queued?.where}>
								<div>
									{t(
										queued?.where === "step"
											? "panel.controlsCompactQueuedNoteStep"
											: "panel.controlsCompactQueuedNote",
									)}
								</div>
								{queued?.stepUnavailable ? (
									<div className="mt-1" data-testid="compact-step-unavailable" data-reason={queued.stepUnavailable}>
										{t(STEP_UNAVAILABLE_TEXT[queued.stepUnavailable])}
									</div>
								) : null}
								{queued?.instructions ? (
									<div className="mt-1 break-words">
										{t("panel.controlsCompactQueuedInstructions", { text: queued.instructions })}
									</div>
								) : null}
							</div>
						) : null}
					</form>
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
