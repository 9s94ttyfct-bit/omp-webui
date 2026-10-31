import type { SettingsChange, SettingsGrant, SettingsRequest } from "@shared/settings-help.ts";
import { ArrowRight, MessageCircleQuestion, ShieldAlert, Undo2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { type MessageKey, t as translate, useT } from "../i18n/index.ts";
import { fmtClock } from "../lib/format.ts";
import { askAgentForHelp, loadSettingsHelp, settingsHelpApi } from "../lib/settings-help.ts";
import { useSettingsHelpStrings } from "../lib/settings-help-strings.ts";
import { attachLive, useApp } from "../store/app.ts";
import { useSettingsHelp } from "../store/settings-help.ts";
import { Button, CardHeader, cx } from "./ui.tsx";

/**
 * Ask agent for help (Settings, v0.13.0), as the page shows it: Settings' card (the button, the conversations that can
 * change settings now, the changes waiting for an Allow, and the log of what the agent changed with Undo), and the strip
 * under the header of a dedicated conversation (its badge, the time its access has left with Revoke now, and its waiting
 * changes). Both are for a page on this computer only: the routes behind them refuse any other.
 */

/** The time now, again every second while `on`: what counts down redraws, nothing else does. */
function useNow(on: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!on) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [on]);
	return now;
}

/** `29:41`: what is left of `ms`, as a countdown reads in every language. */
function fmtLeft(ms: number): string {
	const total = Math.max(0, Math.ceil(ms / 1000));
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function Value({ value }: { value: unknown }) {
	const t = useT();
	if (value === null || value === undefined)
		return <span className="italic text-muted">{t("settingsHelp.unset")}</span>;
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return (
		<code className="line-clamp-3 break-all rounded bg-bg-soft px-1 font-mono text-xs" title={text}>
			{text}
		</code>
	);
}

/** What a failed request shows: a toast that says what could not be done, and why. */
function toastError(key: MessageKey) {
	return (e: unknown) => useApp.getState().toast("error", translate(key, { error: (e as Error).message }));
}

/** A security-sensitive change the agent asked for: the old and new value, with Allow and Deny. */
function RequestCard({ request, now }: { request: SettingsRequest; now: number }) {
	const t = useT();
	const [busy, setBusy] = useState(false);
	const answer = (allow: boolean) => {
		setBusy(true);
		void settingsHelpApi
			.answer(request.id, allow)
			.catch(toastError("settingsHelp.answerFailed"))
			.finally(() => setBusy(false));
	};
	const titleId = `settings-request-${request.id}`;
	return (
		<section
			aria-labelledby={titleId}
			className="rounded-xl border border-warning/60 bg-warning/10 p-3 text-sm"
			data-testid="settings-request"
			data-key={request.key}
		>
			<h3 id={titleId} className="flex items-center gap-2 font-medium">
				<ShieldAlert size={15} className="shrink-0 text-warning" aria-hidden />
				{t("settingsHelp.requestTitle")}
			</h3>
			<p className="mt-1 break-all font-mono text-xs" data-testid="settings-request-key">
				{request.key}
			</p>
			<dl className="mt-2 grid grid-cols-[auto_1fr] items-baseline gap-x-2 gap-y-1">
				<dt className="text-xs text-muted">{t("settingsHelp.requestNow")}</dt>
				<dd className="min-w-0" data-testid="settings-request-old">
					<Value value={request.old} />
				</dd>
				<dt className="text-xs text-muted">{t("settingsHelp.requestNew")}</dt>
				<dd className="min-w-0" data-testid="settings-request-new">
					<Value value={request.new} />
				</dd>
			</dl>
			<div className="mt-3 flex flex-wrap items-center gap-2">
				<Button variant="primary" disabled={busy} onClick={() => answer(true)} data-testid="settings-request-allow">
					{t("settingsHelp.allow")}
				</Button>
				<Button disabled={busy} onClick={() => answer(false)} data-testid="settings-request-deny">
					{t("settingsHelp.deny")}
				</Button>
				<span className="text-xs text-muted">
					{t("settingsHelp.requestExpires", { time: fmtLeft(request.expiresAt - now) })}
				</span>
			</div>
		</section>
	);
}

function Requests({ requests, now }: { requests: SettingsRequest[]; now: number }) {
	// Polite: a card that appears is announced, without taking the reader's place away from them.
	return (
		<div aria-live="polite" className="flex flex-col gap-2 empty:hidden">
			{requests.map((r) => (
				<RequestCard key={r.id} request={r} now={now} />
			))}
		</div>
	);
}

function RevokeButton({ liveId }: { liveId: string }) {
	const t = useT();
	const [busy, setBusy] = useState(false);
	return (
		<Button
			size="sm"
			variant="danger"
			disabled={busy}
			data-testid="settings-help-revoke"
			onClick={() => {
				setBusy(true);
				void settingsHelpApi
					.revoke(liveId)
					.catch(toastError("settingsHelp.revokeFailed"))
					.finally(() => setBusy(false));
			}}
		>
			{t("settingsHelp.revoke")}
		</Button>
	);
}

/** Before the state is read: one empty list for every field, so that the selector answers the same thing each time. */
const NONE: never[] = [];

/** The pieces of state the page shows, read once each (the store holds the server's latest). */
function useHelpState() {
	return useSettingsHelp(
		useShallow((s) => ({
			grants: s.state?.grants ?? NONE,
			ended: s.state?.ended ?? NONE,
			requests: s.state?.requests ?? NONE,
			changes: s.state?.changes ?? NONE,
		})),
	);
}

// ------------------------------------------------------------------ the strip of the dedicated conversation

/** Under the header of a dedicated conversation: its badge, the time its access has left with Revoke now, and its waiting changes. */
export function SettingsHelpBar({ liveId }: { liveId: string | null }) {
	const t = useT();
	const ready = useSettingsHelpStrings();
	useEffect(() => {
		void loadSettingsHelp();
	}, []);
	const { grants, ended, requests } = useHelpState();
	const grant = liveId ? grants.find((g) => g.liveId === liveId) : undefined;
	const end = liveId ? ended.find((e) => e.liveId === liveId) : undefined;
	const mine = useMemo(() => requests.filter((r) => r.liveId === liveId), [requests, liveId]);
	const now = useNow(grant !== undefined || mine.length > 0);
	if (!ready) return null;
	const left = grant ? fmtLeft(grant.expiresAt - now) : "";
	return (
		<div className="border-b border-border bg-bg-soft px-4 py-2" data-testid="settings-help-bar">
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
				<span
					className="inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 font-medium text-accent"
					data-testid="settings-help-badge"
				>
					<MessageCircleQuestion size={12} aria-hidden />
					{t("settingsHelp.badge")}
				</span>
				{grant ? (
					<>
						<span
							role="timer"
							className="tabular-nums text-muted"
							data-testid="settings-help-countdown"
							aria-label={t("settingsHelp.activeLabel", { time: left })}
						>
							{t("settingsHelp.activeLeft", { time: left })}
						</span>
						<span className="flex-1" />
						<RevokeButton liveId={grant.liveId} />
					</>
				) : (
					<span className="text-muted" data-testid="settings-help-ended">
						{end
							? t(
									end.reason === "expired"
										? "settingsHelp.endedExpired"
										: end.reason === "revoked"
											? "settingsHelp.endedRevoked"
											: "settingsHelp.endedEnded",
								)
							: t("settingsHelp.endedNone")}
					</span>
				)}
			</div>
			{mine.length > 0 ? (
				<div className="mt-2">
					<Requests requests={mine} now={now} />
				</div>
			) : null}
		</div>
	);
}

// ------------------------------------------------------------------ Settings' card

/** One conversation's changes in the log, newest first, with Undo all of what still stands. */
function ChangeGroup({
	liveId,
	changes,
	grant,
	now,
}: {
	liveId: string;
	changes: SettingsChange[];
	grant?: SettingsGrant;
	now: number;
}) {
	const t = useT();
	const [busy, setBusy] = useState<string | null>(null);
	const standing = changes.filter((c) => c.undoneAt === null);
	const first = changes[changes.length - 1]?.at ?? Date.now();
	const time = fmtClock(grant?.startedAt ?? first, now);
	const undo = (id: string) => {
		setBusy(id);
		void settingsHelpApi
			.undo(id)
			.catch(toastError("settingsHelp.undoFailed"))
			.finally(() => setBusy(null));
	};
	const undoAll = () => {
		setBusy("all");
		void settingsHelpApi
			.undoAll(liveId)
			.then(({ undone, failed }) => {
				const { toast } = useApp.getState();
				if (failed.length === 0) toast("info", t("settingsHelp.undoAllDone", { n: undone }));
				else
					toast(
						"error",
						t("settingsHelp.undoAllPartial", { n: undone, failed: failed.length, error: failed[0]?.error ?? "" }),
					);
			})
			.catch(toastError("settingsHelp.undoFailed"))
			.finally(() => setBusy(null));
	};
	return (
		<li className="py-2" data-testid="settings-help-group">
			<div className="flex flex-wrap items-center gap-2">
				<span className="min-w-0 flex-1 text-xs font-medium text-muted">
					{grant
						? t("settingsHelp.sessionActive", { time, left: fmtLeft(grant.expiresAt - now) })
						: t("settingsHelp.session", { time })}
				</span>
				{standing.length > 1 ? (
					<Button
						size="sm"
						disabled={busy !== null}
						onClick={undoAll}
						aria-label={t("settingsHelp.undoAllLabel", { time })}
						data-testid="settings-help-undo-all"
					>
						<Undo2 size={13} aria-hidden />
						{t("settingsHelp.undoAll")}
					</Button>
				) : null}
			</div>
			<ul className="mt-1 flex flex-col gap-1.5">
				{changes.map((c) => (
					<li
						key={c.id}
						className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm"
						data-testid="settings-help-change"
						data-key={c.key}
						data-undone={c.undoneAt !== null ? "true" : undefined}
					>
						<span className="break-all font-mono text-xs">{c.key}</span>
						<span className="flex min-w-0 items-center gap-1">
							<Value value={c.old} />
							<ArrowRight size={12} className="shrink-0 text-muted" aria-label="→" />
							<Value value={c.new} />
						</span>
						<span className="text-xs text-faint">
							{fmtClock(c.at, now)} · {t(c.confirmedBy === "person" ? "settingsHelp.byPerson" : "settingsHelp.byAgent")}
						</span>
						<span className="flex-1" />
						{c.undoneAt === null ? (
							<Button
								size="sm"
								disabled={busy !== null}
								onClick={() => undo(c.id)}
								aria-label={t("settingsHelp.undoLabel", { key: c.key })}
								data-testid="settings-help-undo"
							>
								{t("settingsHelp.undo")}
							</Button>
						) : (
							<span className="text-xs text-muted">{t("settingsHelp.undone")}</span>
						)}
					</li>
				))}
			</ul>
		</li>
	);
}

/** The card at the top of Settings. `where`: the name of the page shown, said in the conversation's first message. */
export function SettingsHelpCard({ where }: { where: string }) {
	const t = useT();
	const ready = useSettingsHelpStrings();
	useEffect(() => {
		void loadSettingsHelp();
	}, []);
	const setView = useApp((s) => s.setView);
	const { grants, requests, changes } = useHelpState();
	const now = useNow(grants.length > 0 || requests.length > 0);
	const [starting, setStarting] = useState(false);
	// The log by conversation, the one with the newest change first (the log comes newest first).
	const groups = useMemo(() => {
		const by = new Map<string, SettingsChange[]>();
		for (const c of changes) by.set(c.liveId, [...(by.get(c.liveId) ?? []), c]);
		return [...by.entries()];
	}, [changes]);
	if (!ready) return null;
	const open = (liveId: string) => {
		void attachLive(liveId).then((ok) => {
			if (ok) setView({ kind: "chat", file: null, liveId });
		});
	};
	return (
		<section className="rounded-2xl border border-border bg-surface p-4" data-testid="settings-help">
			<CardHeader
				title={t("settingsHelp.title")}
				icon={<MessageCircleQuestion size={16} className="text-accent" aria-hidden />}
				hint={t("settingsHelp.intro")}
				action={
					<Button
						variant="primary"
						disabled={starting}
						data-testid="settings-help-start"
						onClick={() => {
							setStarting(true);
							void askAgentForHelp(where).finally(() => setStarting(false));
						}}
					>
						{starting ? t("settingsHelp.starting") : t("settingsHelp.start")}
					</Button>
				}
			/>
			{grants.length > 0 ? (
				<ul className="mb-3 flex flex-col gap-1.5">
					{grants.map((g) => (
						<li key={g.liveId} className="flex flex-wrap items-center gap-2 text-sm" data-testid="settings-help-active">
							<span className="min-w-0 flex-1 tabular-nums">
								{t("settingsHelp.activeLeft", { time: fmtLeft(g.expiresAt - now) })}
							</span>
							<Button size="sm" onClick={() => open(g.liveId)}>
								{t("settingsHelp.open")}
							</Button>
							<RevokeButton liveId={g.liveId} />
						</li>
					))}
				</ul>
			) : null}
			<Requests requests={requests} now={now} />
			<div className={cx(requests.length > 0 && "mt-3")} data-testid="settings-help-changes">
				<h3 className="text-sm font-medium">{t("settingsHelp.changesTitle")}</h3>
				{groups.length === 0 ? (
					<p className="mt-1 text-xs text-muted">{t("settingsHelp.changesEmpty")}</p>
				) : (
					<ul className="divide-y divide-border">
						{groups.map(([liveId, list]) => (
							<ChangeGroup
								key={liveId}
								liveId={liveId}
								changes={list}
								grant={grants.find((g) => g.liveId === liveId)}
								now={now}
							/>
						))}
					</ul>
				)}
			</div>
		</section>
	);
}
