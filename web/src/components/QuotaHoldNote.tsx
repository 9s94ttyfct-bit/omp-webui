import type { LiveQuotaHold, QuotaHoldState } from "@shared/quota-floor.ts";
import { FastForward, Hourglass, TriangleAlert } from "lucide-react";
import { useState } from "react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { useNow } from "../lib/now.ts";
import { quotaFloorApi } from "../lib/quota-floor-api.ts";
import {
	HOLD_TITLE,
	holdDetail,
	holdWhy,
	isHoldState,
	refreshedSay,
	resumeSay,
	type Say,
	warmingSay,
} from "../lib/quota-hold.ts";
import { fmtCountdown, resetTime } from "../lib/usage-limit.ts";
import { useApp } from "../store/app.ts";
import { Button, cx, Spinner } from "./ui.tsx";

/** A countdown under this long shows its seconds, and so ticks every second; a longer one ticks every minute (as the quota pill's). */
const SECONDS_MS = 3_600_000;

const ICON = { armed: Hourglass, held: Hourglass, overridden: FastForward, unavailable: TriangleAlert } as const;

/** The states in which the conversation is, or is about to be, waiting: what is said of when it goes on and of the cache. */
const WAITING: readonly QuotaHoldState[] = ["armed", "held"];

/**
 * A conversation that reached the quota floor of its provider (#652): `LiveInfo.quotaHold`, so a page that attaches while
 * it is held shows it as well. It says why it is held, when it goes on and what happens to the prompt cache meanwhile, and
 * offers "Continue anyway" (the person's word that the floor is not for this conversation) or, once chosen, "Hold again".
 * A conversation that cannot be held says why instead of offering either.
 *
 * A chunk of its own: only a conversation that reached a floor draws it, and the first page load carries none of it.
 */
export default function QuotaHoldNote({ liveId, hold }: { liveId: string; hold: LiveQuotaHold }) {
	const t = useT();
	const toast = useApp((s) => s.toast);
	const [busy, setBusy] = useState(false);
	const waiting = isHoldState(hold.state) && WAITING.includes(hold.state);
	// Counts down while a reset is awaited; nothing ticks for a state that says no time.
	const left = typeof hold.resetsAt === "number" ? hold.resetsAt - Date.now() : null;
	const now = useNow(!waiting || left === null || left <= 0 ? null : left < SECONDS_MS ? 1000 : 60_000);
	// Only the states the page knows are drawn, whatever a newer server sends.
	if (!isHoldState(hold.state)) return null;
	const state = hold.state;
	const Icon = ICON[state];
	const say = (s: Say) => t(s.key, s.vars);
	const detail = holdDetail(hold);
	const refreshed = waiting ? refreshedSay(hold.warming) : null;
	const choose = (on: boolean) => {
		setBusy(true);
		quotaFloorApi
			.override(liveId, on)
			.catch((e: unknown) =>
				toast("error", t("chat.quotaHoldFailed", { error: e instanceof Error ? e.message : String(e) })),
			)
			.finally(() => setBusy(false));
	};
	return (
		<div
			className={cx(
				"my-2 flex items-start gap-2 rounded-xl border px-3 py-2 text-sm",
				state === "overridden" ? "border-border bg-bg-soft" : "border-warning/40 bg-warning/10",
			)}
			data-testid="quota-hold-note"
			data-state={state}
			data-provider={hold.provider}
		>
			<Icon
				size={14}
				className={cx("mt-0.5 shrink-0", state === "overridden" ? "text-muted" : "text-warning")}
				aria-hidden
			/>
			<div className="min-w-0 flex-1">
				<div className="font-medium break-words" data-testid="quota-hold-title">
					{t(HOLD_TITLE[state])}
				</div>
				<div className="mt-0.5 break-words text-xs text-muted" data-testid="quota-hold-why">
					{say(holdWhy(hold))}
				</div>
				{detail ? (
					<div className="mt-0.5 break-words text-xs text-muted" data-testid="quota-hold-detail">
						{say(detail)}
					</div>
				) : null}
				{waiting ? (
					<>
						<div className="mt-0.5 break-words text-xs text-muted" data-testid="quota-hold-resumes">
							{say(
								resumeSay(hold, {
									now,
									time: (ms) => resetTime(ms / 1000, now),
									left: fmtCountdown,
								}),
							)}
						</div>
						<div
							className="mt-0.5 break-words text-xs text-muted"
							data-testid="quota-hold-cache"
							data-warming={hold.warming.state}
							data-why={hold.warming.why ?? ""}
						>
							{say(warmingSay(hold.warming))}
						</div>
						{refreshed ? (
							<div className="mt-0.5 break-words text-xs text-muted" data-testid="quota-hold-refreshed">
								{say(refreshed)}
							</div>
						) : null}
					</>
				) : null}
				{state === "unavailable" ? null : (
					<div className="mt-2">
						{/* A surface fill: on the card's tint the bare outline read as plain text (as the retry card's buttons). */}
						<Button
							size="sm"
							className="bg-surface"
							data-testid={state === "overridden" ? "quota-hold-again" : "quota-hold-continue"}
							disabled={busy}
							onClick={() => choose(state !== "overridden")}
						>
							{busy ? <Spinner size={12} /> : null}
							{t(state === "overridden" ? "chat.quotaHoldAgain" : "chat.quotaHoldContinue")}
						</Button>
					</div>
				)}
			</div>
		</div>
	);
}
