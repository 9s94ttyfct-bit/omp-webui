import * as Popover from "@radix-ui/react-popover";
import {
	GUARD_MODES,
	type GuardConfig,
	type GuardMode,
	type GuardOverride,
	type GuardOverridePatch,
	type LiveGuard,
} from "@shared/guard.ts";
import { EyeOff, ScanEye } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useT } from "../i18n/index.ts";
import { guardApi } from "../lib/guard-api.ts";
import { MODE_TEXT } from "../lib/guard-format.ts";
import { useGuardStrings } from "../lib/guard-strings.ts";
import { useModelCatalog } from "../lib/model-config.ts";
import { useApp } from "../store/app.ts";
import { useGuard } from "../store/guard.ts";
import { INFO_BOX, InfoButton } from "./InfoButton.tsx";
import { ModelSelect } from "./ModelSelect.tsx";
import { Switch } from "./Switch.tsx";
import { Button, cx } from "./ui.tsx";

/**
 * "Guard dangerous commands" for one conversation (`LiveInfo.guard`): what the guard does for it now, whether that is the
 * global setting (Settings › Safety) or its own, and, on the computer the server runs on, the choice to make it its own.
 * A conversation that chose nothing follows the global settings, also when they change. A page that is not that
 * computer's sees the same words and changes nothing (the server refuses it, and the controls are not drawn).
 * Its own chunk with the strings of the guard: opened with the session panel, or the picker of a new chat.
 */

const isOwn = (guard: LiveGuard): boolean => guard.own !== undefined && Object.keys(guard.own).length > 0;

/** `guard` with a change that was asked for and not answered yet on it: what the person has just chosen is what they see. */
function withPending(guard: LiveGuard, pending: GuardOverridePatch | null, settings: GuardConfig | null): LiveGuard {
	if (!pending) return guard;
	const config: GuardConfig = { ...guard.config };
	const own: Record<string, unknown> = { ...guard.own };
	for (const key of ["mode", "reviewer", "askWhenUnavailable", "askWhenDenied"] as const) {
		if (!(key in pending)) continue;
		const value = pending[key];
		if (value === null || value === undefined) {
			delete own[key];
			if (settings) (config as unknown as Record<string, unknown>)[key] = settings[key];
		} else {
			own[key] = value;
			(config as unknown as Record<string, unknown>)[key] = value;
		}
	}
	return Object.keys(own).length > 0 ? { config, own: own as GuardOverride } : { config };
}

/** What a field says of where it comes from, and the button that gives it back to Settings. */
function Origin({
	own,
	onUseSettings,
	busy,
	editable,
	testid,
}: {
	own: boolean;
	onUseSettings: () => void;
	busy: boolean;
	editable: boolean;
	testid: string;
}) {
	const t = useT();
	return (
		<p
			className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted"
			data-testid={`${testid}-origin`}
			data-own={own}
		>
			{own ? t("guard.sessionSetHere") : t("guard.sessionFromSettings")}
			{own && editable ? (
				<Button
					size="sm"
					variant="ghost"
					disabled={busy}
					data-testid={`${testid}-use-settings`}
					onClick={onUseSettings}
				>
					{t("guard.sessionUseSettings")}
				</Button>
			) : null}
		</p>
	);
}

/** The reviewer, "ask when no reviewer can be reached" and "ask when the reviewer denies": what `reviewer` mode has more to say. */
function ReviewerFields({
	guard,
	editable,
	busy,
	send,
}: {
	guard: LiveGuard;
	editable: boolean;
	busy: boolean;
	send: (patch: GuardOverridePatch) => Promise<void>;
}) {
	const t = useT();
	const models = useModelCatalog(editable, "omp");
	const { reviewer, askWhenUnavailable, askWhenDenied } = guard.config;
	const ownReviewer = guard.own?.reviewer !== undefined;
	const ownAsk = guard.own?.askWhenUnavailable !== undefined;
	const ownDenied = guard.own?.askWhenDenied !== undefined;
	return (
		<div className="mt-3 space-y-3" data-testid="session-guard-reviewer-fields">
			<div>
				<div className="mb-1 text-sm">{t("guard.reviewerLabel")}</div>
				{editable ? (
					<ModelSelect
						value={reviewer}
						models={models}
						label={t("guard.reviewerLabel")}
						testid="session-guard-reviewer"
						blank={t("guard.reviewerBlank")}
						onChange={(selector) => void send({ reviewer: selector })}
					/>
				) : (
					<p className="break-words text-sm" data-testid="session-guard-reviewer">
						{reviewer || t("guard.reviewerBlank")}
					</p>
				)}
				<Origin
					own={ownReviewer}
					busy={busy}
					editable={editable}
					testid="session-guard-reviewer"
					onUseSettings={() => void send({ reviewer: null })}
				/>
			</div>
			<div>
				{editable ? (
					<div className="flex items-start gap-3">
						<Switch
							checked={askWhenUnavailable}
							label={t("guard.askUnavailable")}
							busy={busy}
							data-testid="session-guard-ask-unavailable"
							onCheckedChange={(on) => void send({ askWhenUnavailable: on })}
						/>
						<div className="min-w-0 flex-1 text-sm">{t("guard.askUnavailable")}</div>
					</div>
				) : (
					<p className="text-sm" data-testid="session-guard-ask-unavailable" data-on={askWhenUnavailable}>
						{t(askWhenUnavailable ? "guard.sessionAskOn" : "guard.sessionAskOff")}
					</p>
				)}
				<Origin
					own={ownAsk}
					busy={busy}
					editable={editable}
					testid="session-guard-ask"
					onUseSettings={() => void send({ askWhenUnavailable: null })}
				/>
			</div>
			<div>
				{editable ? (
					<div className="flex items-start gap-3">
						<Switch
							checked={askWhenDenied}
							label={t("guard.askDenied")}
							busy={busy}
							data-testid="session-guard-ask-denied"
							onCheckedChange={(on) => void send({ askWhenDenied: on })}
						/>
						<div className="min-w-0 flex-1 text-sm">{t("guard.askDenied")}</div>
					</div>
				) : (
					<p className="text-sm" data-testid="session-guard-ask-denied" data-on={askWhenDenied}>
						{t(askWhenDenied ? "guard.sessionDeniedOn" : "guard.sessionDeniedOff")}
					</p>
				)}
				<Origin
					own={ownDenied}
					busy={busy}
					editable={editable}
					testid="session-guard-denied"
					onUseSettings={() => void send({ askWhenDenied: null })}
				/>
			</div>
		</div>
	);
}

/**
 * The guard of the conversation `liveId`: its mode (follow Settings, Off, Reviewer model, Ask me), and in Reviewer mode its
 * reviewer and what to do when none can be reached, each with where it comes from. `onChange` hears what the conversation
 * chose of its own after each change (New chat keeps it for the process it starts next). `compact` (the session panel,
 * #716): what the section is for and what each mode does are under an info button, so the panel fits without a scroll.
 */
export function GuardControls({
	liveId,
	onChange,
	compact = false,
}: {
	liveId: string;
	onChange?: (own: GuardOverride | null) => void;
	compact?: boolean;
}) {
	const t = useT();
	const ready = useGuardStrings();
	const toast = useApp((s) => s.toast);
	const stored = useApp((s) => s.lives[liveId]?.info.guard);
	// Only the page on the computer the server runs on changes it; the server refuses any other (see `isLocalOnlyRoute`).
	const editable = useApp((s) => s.meta?.local === true);
	const settings = useGuard((s) => s.config);
	const [busy, setBusy] = useState(false);
	// What was asked and the server has not answered yet: shown at once, and given up if the server refuses it.
	const [pending, setPending] = useState<GuardOverridePatch | null>(null);
	const guard = stored && withPending(stored, pending, settings);
	const group = useId();
	const infoId = useId();
	const [infoOpen, setInfoOpen] = useState(false);
	/** The changes asked for that the server has not answered: what was asked stays shown until the last is answered. */
	const inflight = useRef(0);

	// What the settings say now, for "Follow Settings (now: …)": asked once by a page that may read them.
	useEffect(() => {
		if (editable && !settings) void guardApi.config().catch(() => {});
	}, [editable, settings]);

	if (!ready || !guard) return null;
	const own = guard.own ?? {};
	const chosen = isOwn(guard);

	const send = async (patch: GuardOverridePatch | null) => {
		setBusy(true);
		inflight.current += 1;
		if (patch) setPending((before) => ({ ...before, ...patch }));
		try {
			const now = await guardApi.conversation(liveId, patch);
			onChange?.(now?.own ?? null);
		} catch (e) {
			toast("error", t("guard.sessionFailed", { error: e instanceof Error ? e.message : String(e) }));
		} finally {
			inflight.current -= 1;
			if (inflight.current === 0) {
				setPending(null);
				setBusy(false);
			}
		}
	};

	const mode = guard.config.mode;
	const choices: { value: GuardMode | "follow"; label: string; hint?: string }[] = [
		{
			value: "follow",
			label: settings
				? t("guard.sessionFollowNow", { mode: t(MODE_TEXT[settings.mode].label) })
				: t("guard.sessionFollow"),
		},
		...GUARD_MODES.map((m) => ({ value: m, label: t(MODE_TEXT[m].label), hint: t(MODE_TEXT[m].hint) })),
	];
	// A conversation whose kept record was damaged is under a mode that none of the radios names: none is selected.
	const current = guard.damaged ? null : (own.mode ?? "follow");

	return (
		<section data-testid="session-guard" data-own={chosen} data-mode={mode} aria-label={t("guard.guardTitle")}>
			<div className="flex flex-wrap items-center justify-between gap-2">
				<div className="flex items-center gap-1">
					<div className="text-sm font-semibold">{t("guard.guardTitle")}</div>
					{compact ? (
						<InfoButton
							label={t("guard.guardTitle")}
							testid="session-guard"
							open={infoOpen}
							controls={infoId}
							onToggle={() => setInfoOpen((v) => !v)}
						/>
					) : null}
				</div>
				{/* Only an own choice is marked: "Follow Settings (now: …)", the first choice, already says when it follows (C7). */}
				{chosen ? (
					<span
						className="rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent"
						data-testid="session-guard-badge"
					>
						{t("guard.sessionBadgeOwn")}
					</span>
				) : null}
			</div>
			{!compact ? (
				<p className="mt-1 text-xs text-muted">{t("guard.sessionIntro")}</p>
			) : infoOpen ? (
				<div id={infoId} className={cx(INFO_BOX, "mt-1.5")} data-testid="session-guard-help">
					<p>{t("guard.sessionIntro")}</p>
					<ul className="space-y-0.5">
						{GUARD_MODES.map((m) => (
							<li key={m}>
								<span className="font-medium text-fg">{t(MODE_TEXT[m].label)}</span>: {t(MODE_TEXT[m].hint)}
							</li>
						))}
					</ul>
				</div>
			) : null}
			{guard.damaged ? (
				<p className="mt-1 text-xs text-warning" data-testid="session-guard-damaged">
					{t("guard.sessionDamaged")}
				</p>
			) : null}
			{editable ? (
				<fieldset className="mt-2 space-y-0.5" disabled={busy} data-testid="session-guard-modes">
					<legend className="sr-only">{t("guard.guardTitle")}</legend>
					{choices.map((c) => (
						<label
							key={c.value}
							className={cx(
								"flex cursor-pointer items-start gap-2 rounded-md px-1.5 py-1 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
								current === c.value ? "bg-accent-soft text-accent" : "text-muted hover:text-fg",
								c.value === "off" && current === "off" && "bg-warning/10 text-warning",
							)}
						>
							<input
								type="radio"
								className="mt-1 accent-[var(--accent)]"
								name={`session-guard-${group}`}
								value={c.value}
								checked={current === c.value}
								data-testid={`session-guard-mode-${c.value}`}
								onChange={() => void send({ mode: c.value === "follow" ? null : c.value })}
							/>
							<span>
								{c.label}
								{c.hint && !compact ? <span className="block text-xs text-muted">{c.hint}</span> : null}
							</span>
						</label>
					))}
				</fieldset>
			) : (
				<>
					<p className="mt-2 text-sm" data-testid="session-guard-effective" data-mode={mode}>
						{t(MODE_TEXT[mode].label)}
						{compact ? null : <span className="block text-xs text-muted">{t(MODE_TEXT[mode].hint)}</span>}
					</p>
					<p className="mt-1 text-xs text-muted" data-testid="session-guard-readonly">
						{t("guard.sessionReadOnly")}
					</p>
				</>
			)}
			{mode === "reviewer" ? <ReviewerFields guard={guard} editable={editable} busy={busy} send={send} /> : null}
		</section>
	);
}

/** The section of the session panel (`SessionControls`): the conversation's guard, set apart from the runtime settings above it. */
export default function SessionGuard({ liveId }: { liveId: string }) {
	return (
		<div className="mt-4 border-t border-border pt-3">
			<GuardControls liveId={liveId} compact />
		</div>
	);
}

/**
 * The guard of a new chat, in the composer's footer next to the permission mode: what the warmed-up process is under, and
 * the same controls to change it before the first message. `onChange` keeps the choice for the next process the page starts.
 */
export function GuardPicker({ liveId, onChange }: { liveId: string; onChange?: (own: GuardOverride | null) => void }) {
	const t = useT();
	const ready = useGuardStrings();
	const guard = useApp((s) => s.lives[liveId]?.info.guard);
	if (!ready || !guard) return null;
	const mode = guard.config.mode;
	const name = t(MODE_TEXT[mode].label);
	// An eye, not a shield: the permission mode beside it is the shield, and two amber shields could not be told apart (C1).
	const Icon = mode === "off" ? EyeOff : ScanEye;
	return (
		<Popover.Root>
			<Popover.Trigger asChild>
				<button
					type="button"
					data-testid="guard-picker"
					data-mode={mode}
					data-own={isOwn(guard)}
					title={t("guard.pickerTitle")}
					className={cx(
						"inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs composer-narrow:w-8 composer-narrow:justify-center composer-narrow:px-0",
						// A hover rings the warning tint rather than deepening it: a deeper tint under the same text falls under 4.5:1.
						mode === "off"
							? "bg-warning/15 text-warning hover:ring-1 hover:ring-warning/40"
							: "text-muted hover:bg-hover hover:text-fg",
					)}
				>
					<Icon size={14} className="shrink-0" />
					<span className="composer-narrow:sr-only">{t("guard.pickerLabel", { mode: name })}</span>
				</button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					align="start"
					side="top"
					sideOffset={6}
					collisionPadding={8}
					className="z-50 max-h-[var(--radix-popover-content-available-height)] w-96 max-w-[calc(100vw-1rem)] overflow-y-auto overscroll-contain rounded-2xl border border-border bg-surface p-4 shadow-2xl"
					data-testid="guard-picker-panel"
				>
					<GuardControls liveId={liveId} onChange={onChange} />
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
