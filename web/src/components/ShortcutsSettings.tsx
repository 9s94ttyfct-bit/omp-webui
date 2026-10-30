import "../i18n/later.ts";
import { type KeyboardEvent, useState } from "react";
import { registerStrings, useT } from "../i18n/index.ts";
import { en as quickPromptStrings } from "../i18n/quick-prompts.ts";
import { keyLabel, shortcutLabel } from "../lib/platform.ts";
import { promptName, useQuickPrompts } from "../lib/quick-prompts.ts";
import {
	type Check,
	checkBinding,
	chordFromEvent,
	defaultChord,
	type EditScope,
	type Entry,
	resetAllBindings,
	resetBinding,
	setBinding,
	shortcutEntries,
	swapBinding,
} from "../lib/shortcut-edit.ts";
import { SCOPE_KEYS, SHORTCUTS, type ShortcutScope } from "../lib/shortcut-list.ts";
import {
	chordKeys,
	QUICK_PROMPT_PREFIX,
	type ShortcutId,
	shortcutOverrides,
	useShortcutVersion,
} from "../lib/shortcuts.ts";
import { useApp } from "../store/app.ts";
import { Button, CardHeader, Kbd } from "./ui.tsx";

// The quick prompts' names (the built-in Soft stop's in the page's language) are that chunk's strings.
registerStrings("quickPrompts", quickPromptStrings);

const SCOPES = Object.keys(SCOPE_KEYS) as ShortcutScope[];

const keysText = (chord: string | null) => shortcutLabel(chordKeys(chord));

type RowState =
	| { kind: "idle" }
	| { kind: "recording"; message: string | null }
	| { kind: "pending"; chord: string; check: Check };

/**
 * Settings › Keyboard shortcuts (#639, #661): every binding of the app, grouped by the surface it acts on, and the way to
 * change one. It lists `SHORTCUTS` (`shortcut-list.ts`), which names every binding the key handlers match through, so what the page says and what the keys do
 * cannot drift apart; `?` and `/hotkeys` open this card (`lib/shortcut-view.ts`), and the card is a chunk of its own.
 *
 * A binding is changed by pressing the new keys (`shortcut-edit.ts` says what they make and what is in the way): a key
 * another action has where this one acts is refused, or swapped when the other can take this one's keys; a key the
 * browser or macOS keeps for itself is warned about. What the person chooses is kept on this device. The keys of the
 * surfaces themselves (Esc, the arrows of a list, Shift+Enter) are listed and in the way, but not changed. A quick prompt
 * can have a key too: it sends the prompt to the conversation on screen.
 */
export function ShortcutsSettings() {
	const t = useT();
	const set = useApp((s) => s.set);
	useShortcutVersion();
	const prompts = useQuickPrompts();
	const entries = shortcutEntries(prompts.map((p) => p.id));
	const labelOf = (e: Entry): string => {
		if (e.id.startsWith(QUICK_PROMPT_PREFIX)) {
			const p = prompts.find((q) => QUICK_PROMPT_PREFIX + q.id === e.id);
			return p ? promptName(p, t) : e.id;
		}
		return t(SHORTCUTS[e.id as ShortcutId].labelKey);
	};
	const scopeOf = (scope: EditScope): string =>
		scope === "Quick prompts" ? t("pages.shortcutQuickPrompts") : t(SCOPE_KEYS[scope]);
	const changed = Object.keys(shortcutOverrides()).length > 0;
	const group = (title: string, rows: Entry[], hint?: string) =>
		rows.length ? (
			<section key={title}>
				<h3 className="mb-1.5 text-xs font-medium tracking-wide text-faint uppercase">{title}</h3>
				{hint ? <p className="mb-1.5 text-xs text-muted">{hint}</p> : null}
				<ul className="divide-y divide-border">
					{rows.map((e) => (
						<Row key={e.id} entry={e} entries={entries} labelOf={labelOf} scopeOf={scopeOf} />
					))}
				</ul>
			</section>
		) : null;
	return (
		<section className="rounded-2xl border border-border bg-surface p-4" data-testid="shortcuts-settings">
			<CardHeader title={t("shell.shortcutsTitle")} hint={t("pages.settingsShortcutsHint")} />
			<div className="space-y-4" data-testid="shortcuts">
				{SCOPES.map((scope) =>
					group(
						t(SCOPE_KEYS[scope]),
						entries.filter((e) => e.scope === scope),
					),
				)}
				{group(
					t("pages.shortcutQuickPrompts"),
					entries.filter((e) => e.scope === "Quick prompts"),
					t("pages.shortcutQuickPromptsHint"),
				)}
			</div>
			{changed ? (
				<div className="mt-3 flex justify-end">
					<Button size="sm" data-testid="shortcuts-reset-all" onClick={resetAllBindings}>
						{t("pages.shortcutResetAll")}
					</Button>
				</div>
			) : null}
			<div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3 text-sm text-muted">
				{t("feedback.helpPrompt")}
				<Button size="sm" data-testid="help-feedback" onClick={() => set({ feedbackOpen: true })}>
					{t("feedback.navFeedback")}
				</Button>
			</div>
		</section>
	);
}

function Row({
	entry,
	entries,
	labelOf,
	scopeOf,
}: {
	entry: Entry;
	entries: Entry[];
	labelOf: (e: Entry) => string;
	scopeOf: (scope: EditScope) => string;
}) {
	const t = useT();
	const [state, setState] = useState<RowState>({ kind: "idle" });
	const label = labelOf(entry);
	const shipped = defaultChord(entry.id);
	const overridden = entry.id in shortcutOverrides();
	const keys = chordKeys(entry.chord);

	const take = (chord: string) => {
		if (chord === entry.chord) return setState({ kind: "idle" });
		const check = checkBinding(entries, entry.id, chord);
		if (check.bare) {
			return setState({
				kind: "recording",
				message: t("pages.shortcutBare", { mod: keyLabel("Mod"), alt: keyLabel("Alt") }),
			});
		}
		if (check.conflicts.length || check.reserved) return setState({ kind: "pending", chord, check });
		setBinding(entry.id, chord);
		setState({ kind: "idle" });
	};

	const onRecordKey = (e: KeyboardEvent<HTMLButtonElement>) => {
		// The keys pressed here are the new binding's: no other handler of the page acts on them.
		e.preventDefault();
		e.stopPropagation();
		const native = e.nativeEvent;
		if (native.key === "Escape" && !native.metaKey && !native.ctrlKey && !native.altKey && !native.shiftKey) {
			return setState({ kind: "idle" });
		}
		const made = chordFromEvent(native);
		if ("chord" in made) return take(made.chord);
		if (made.error === "composing") setState({ kind: "recording", message: t("pages.shortcutComposing") });
		else if (made.error === "unsupported") setState({ kind: "recording", message: t("pages.shortcutUnsupported") });
	};

	const other = state.kind === "pending" ? state.check.conflicts[0] : undefined;
	return (
		<li className="py-1.5 text-sm" data-testid={`shortcut-${entry.id}`}>
			{/* In a narrow column every row puts its name above its keys, so long and short names line up the same way. */}
			<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
				<span className="min-w-0 basis-full @min-[36rem]:basis-auto">{label}</span>
				<span className="flex shrink-0 flex-wrap items-center gap-1">
					{state.kind === "recording" ? (
						<button
							type="button"
							// biome-ignore lint/a11y/noAutofocus: the recorder takes the keys pressed right after Change.
							autoFocus
							data-testid="shortcut-record"
							className="rounded-md border border-accent px-2 py-0.5 text-xs text-accent outline-none"
							onKeyDown={onRecordKey}
							onBlur={() => setState((s) => (s.kind === "recording" ? { kind: "idle" } : s))}
						>
							{t("pages.shortcutRecording")}
						</button>
					) : keys.length ? (
						<span
							className="flex gap-1"
							data-testid="shortcut-keys"
							title={entry.fixed ? t("pages.shortcutFixed") : undefined}
						>
							{keys.map((k) => (
								<Kbd key={k}>{keyLabel(k)}</Kbd>
							))}
						</span>
					) : (
						<span className="text-xs text-faint" data-testid="shortcut-keys">
							{t("pages.shortcutNone")}
						</span>
					)}
					{entry.fixed ? null : (
						<>
							{state.kind === "idle" ? (
								<Button
									size="sm"
									variant="ghost"
									className="pointer-coarse:h-9"
									data-testid="shortcut-change"
									aria-label={t("pages.shortcutChangeAria", { action: label })}
									onClick={() => setState({ kind: "recording", message: null })}
								>
									{t("pages.shortcutChange")}
								</Button>
							) : null}
							{state.kind === "idle" && entry.chord !== null ? (
								<Button
									size="sm"
									variant="ghost"
									className="pointer-coarse:h-9"
									data-testid="shortcut-clear"
									aria-label={t("pages.shortcutClearAria", { action: label })}
									onClick={() => setBinding(entry.id, null)}
								>
									{t("pages.shortcutClear")}
								</Button>
							) : null}
							{state.kind === "idle" && overridden && shipped !== null ? (
								<Button
									size="sm"
									variant="ghost"
									className="pointer-coarse:h-9"
									data-testid="shortcut-reset"
									aria-label={t("pages.shortcutResetAria", { action: label, keys: keysText(shipped) })}
									onClick={() => resetBinding(entry.id)}
								>
									{t("pages.shortcutReset")}
								</Button>
							) : null}
						</>
					)}
				</span>
			</div>
			{entry.fixed ? null : state.kind === "recording" && state.message ? (
				<p className="mt-1 text-xs text-danger" role="alert" data-testid="shortcut-message">
					{state.message}
				</p>
			) : state.kind === "pending" ? (
				<div className="mt-1 space-y-1 text-xs" role="alert" data-testid="shortcut-message">
					{other ? (
						<p className="text-danger">
							{t("pages.shortcutConflict", {
								keys: keysText(state.chord),
								action: labelOf(other),
								scope: scopeOf(other.scope),
							})}{" "}
							{state.check.swappable
								? entry.chord === null
									? t("pages.shortcutSwapHintNone", { action: labelOf(other) })
									: t("pages.shortcutSwapHint", { action: labelOf(other), keys: keysText(entry.chord) })
								: t("pages.shortcutConflictRefused")}
						</p>
					) : null}
					{state.check.reserved ? (
						<p className="text-warning">{t("pages.shortcutReserved", { keys: keysText(state.chord) })}</p>
					) : null}
					<div className="flex gap-2">
						{other && state.check.swappable ? (
							<Button
								size="sm"
								data-testid="shortcut-swap"
								onClick={() => {
									swapBinding(entry.id, state.chord, other.id);
									setState({ kind: "idle" });
								}}
							>
								{t("pages.shortcutSwap")}
							</Button>
						) : null}
						{!other ? (
							<Button
								size="sm"
								data-testid="shortcut-use-anyway"
								onClick={() => {
									setBinding(entry.id, state.chord);
									setState({ kind: "idle" });
								}}
							>
								{t("pages.shortcutUseAnyway")}
							</Button>
						) : null}
						<Button size="sm" variant="ghost" data-testid="shortcut-cancel" onClick={() => setState({ kind: "idle" })}>
							{t("common.cancel")}
						</Button>
					</div>
				</div>
			) : null}
		</li>
	);
}
