import * as Popover from "@radix-ui/react-popover";
import type { UsageReport } from "@shared/protocol.ts";
import { exhaustion, QUOTA_IDLE_REFRESH_MS, QUOTA_REFRESH_MS } from "@shared/quota.ts";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useT } from "../i18n/index.ts";
import { api } from "../lib/api.ts";
import { useNow } from "../lib/now.ts";
import { usePageVisible } from "../lib/page-visible.ts";
import { accountQuotas, type QuotaLevel, ringShare } from "../lib/quota.ts";
import { fmtCountdown } from "../lib/usage-limit.ts";
import { UsageWaitChoice } from "./UsageWaitChoice.tsx";
import { Badge, cx } from "./ui.tsx";

/** Once a reset is due the usage is asked for again after this long, and every this long while the provider has not lifted it. */
const RESET_LOOK_MS = 15_000;
/** The provider is given this long past the stated reset time before it is asked about. */
const RESET_GRACE_MS = 3_000;
/** The longest delay a timer takes: a longer one (a monthly window) is clamped to 1 ms, and fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** A countdown under this long shows its seconds, and so ticks every second; a longer one shows its minutes, and ticks every minute. */
const COUNTDOWN_SECONDS_MS = 3_600_000;

/**
 * What is left of the window as a ring the height of the pill's text: the arc from twelve o'clock, clockwise, is the
 * share left, in the pill's own tone, over the track the bar's meter had. Drawn in whole pixels (14 of them, a 2 px
 * stroke on a 6 px radius) so it is as crisp at 1x as at 2x. The pill's label says the same, so the ring is hidden
 * from assistive technology; an arc change jumps, nothing is animated.
 */
function QuotaRing({ share, level }: { share: number; level: QuotaLevel }) {
	const left = ringShare(share);
	return (
		<svg
			viewBox="0 0 14 14"
			width={14}
			height={14}
			className="shrink-0"
			aria-hidden
			focusable="false"
			data-testid="quota-meter"
			data-left={left}
		>
			<circle cx={7} cy={7} r={6} fill="none" strokeWidth={2} className="stroke-hover" />
			{left > 0 ? (
				<circle
					cx={7}
					cy={7}
					r={6}
					fill="none"
					strokeWidth={2}
					pathLength={100}
					strokeDasharray={`${left} 100`}
					transform="rotate(-90 7 7)"
					className={level === "critical" ? "stroke-danger" : level === "low" ? "stroke-warning" : "stroke-accent"}
					data-testid="quota-ring-arc"
				/>
			) : null}
		</svg>
	);
}

/**
 * One provider's remaining quota (from `omp usage`): the account with the most capacity left, every account's
 * windows in a popover that opens with a click, a tap or the keyboard. Refreshes periodically and after each turn or
 * command. A provider whose every account is used up says when it resets instead, as a countdown that ticks, and looks
 * again once that time has come. Providers without usage data render nothing. A look that fails keeps the last known
 * figures, underlined with a dotted line and said to be out of date, until a look succeeds. A page nobody sees (a
 * background tab, a window behind others) asks for nothing; shown again, it looks at once if its figures are older than a
 * refresh.
 *
 * `active`: the provider's quota is being spent right now (the conversation works on that provider). The figures are
 * then looked at every {@link QUOTA_REFRESH_MS} rather than every {@link QUOTA_IDLE_REFRESH_MS}, and once more when the
 * work ends (#458).
 * `variant`: `pill` is the figure on its own; `bar` is the same figure behind a meter of what is left, with the
 * window's reset beside it — what a conversation's own model gets in the chat header (#454).
 * `showName`: the provider's name leads the figure (a conversation that mixes providers shows one for each).
 * `terse`: only the figure (`40%`, `1h 13m`), for a header too narrow for words next to the other providers'; the
 * provider is named by the tooltip, the accessible name and the popover.
 * `model`: the bare id of the model that spends the quota. Windows scoped to other models (an Opus-only weekly cap
 * while a Sonnet model works) neither make the figure "used up" nor its share.
 * `file`: the conversation the figure is shown for, whose own choice about waiting out the usage limit the popover offers.
 */
export function Quota({
	provider,
	active,
	variant = "pill",
	showName = false,
	terse = false,
	model = null,
	file = null,
}: {
	provider: string;
	active: boolean;
	variant?: "pill" | "bar";
	showName?: boolean;
	terse?: boolean;
	model?: string | null;
	file?: string | null;
}) {
	const t = useT();
	const titleId = useId();
	const describedId = useId();
	const [reports, setReports] = useState<UsageReport[] | null>(null);
	/** The last look failed: `reports` are the last known ones, or none. */
	const [stale, setStale] = useState(false);
	const wasActive = useRef(active);
	const visible = usePageVisible();
	/** When the last look for this provider was asked for; 0 before the first. */
	const lastLook = useRef(0);

	// A failed look keeps what is known (nothing known yet: no data, so no figure); the next successful one replaces it.
	const look = useCallback((load: Promise<UsageReport[]>, alive: () => boolean = () => true) => {
		lastLook.current = Date.now();
		return load
			.then((r) => {
				if (!alive()) return;
				setReports(r);
				setStale(false);
			})
			.catch(() => {
				if (!alive()) return;
				setReports((known) => known ?? []);
				setStale(true);
			});
	}, []);

	// Another provider starts from nothing known.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the provider changing is what resets what is known.
	useEffect(() => {
		setReports(null);
		setStale(false);
		lastLook.current = 0;
	}, [provider]);

	// Finished work may have spent quota: refetch (bypassing the server's short cache). A page nobody sees asks for
	// nothing: its figures are looked at when it is shown again, and they are older by then, which is what it wants.
	// This runs before the periodic look below, so that the look it makes is the one the periodic timer counts from.
	useEffect(() => {
		if (wasActive.current && !active && visible) void look(api.usage(provider, true));
		wasActive.current = active;
	}, [active, provider, look, visible]);

	// Looks every interval while the page is on screen, and at once when it is not known yet or is older than that (a
	// page shown again after a while). Each look is a process the server starts and a call to the provider: none for a
	// page nobody sees. A conversation that works looks every {@link QUOTA_REFRESH_MS}, an idle one every
	// {@link QUOTA_IDLE_REFRESH_MS}.
	const interval = active ? QUOTA_REFRESH_MS : QUOTA_IDLE_REFRESH_MS;
	useEffect(() => {
		if (!visible) return;
		let live = true;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const tick = () => {
			void look(api.usage(provider), () => live);
			timer = setTimeout(tick, interval);
		};
		const wait = lastLook.current + interval - Date.now();
		if (wait <= 0) tick();
		else timer = setTimeout(tick, wait);
		return () => {
			live = false;
			clearTimeout(timer);
		};
	}, [provider, look, visible, interval]);

	const accounts = reports ? accountQuotas(reports, provider, model) : [];
	const used = reports ? exhaustion(reports, provider, model) : null;
	const resetsAt = used?.resetsAt ?? null;
	const best = accounts[0];
	// The window the figure is from, and when it frees up again. A used-up provider says that in its figure already.
	const headlineAt = used ? null : (best?.headline.limit.window?.resetsAt ?? null);
	// The one reset that is counted down: the used-up provider's own, or the window the figure is from.
	const resetAt = resetsAt ?? headlineAt;
	// The clock ticks at the precision the countdown shows: every second while it shows seconds, every minute while it
	// shows hours. A page nobody sees counts nothing down.
	const now = useNow(resetAt === null || !visible ? null : resetAt - Date.now() < COUNTDOWN_SECONDS_MS ? 1000 : 60_000);

	// The reset has come: ask again, and again until the provider says it is back. Each answer starts the wait afresh.
	// A reset further off than a timer can wait (a monthly window) is waited for in the longest step there is.
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new report is what restarts the timer.
	useEffect(() => {
		if (resetsAt === null || !visible) return;
		const id = setTimeout(
			() => void look(api.usage(provider, true)),
			Math.min(MAX_TIMER_MS, Math.max(RESET_LOOK_MS, resetsAt + RESET_GRACE_MS - Date.now())),
		);
		return () => clearTimeout(id);
	}, [reports, resetsAt, provider, look, visible]);

	const pct = (f: number) => Math.round(f * 100);
	let level: QuotaLevel;
	let text: string;
	let aria: string;
	if (used) {
		const left = resetsAt === null ? null : resetsAt - now;
		const when =
			left === null
				? null
				: left > 0
					? t("chat.quotaResetsIn", { time: fmtCountdown(left) })
					: t("chat.quotaResetting");
		level = "critical";
		text = terse && left !== null && left > 0 ? fmtCountdown(left) : (when ?? t("chat.quotaExhausted"));
		aria = when ? t("chat.quotaAriaUsedUp", { provider, when }) : t("chat.quotaAriaUsedUpOpen", { provider });
	} else if (best) {
		const { headline } = best;
		const args = { provider, pct: pct(headline.fraction), label: headline.limit.label };
		level = headline.level;
		text = terse ? `${args.pct}%` : t("chat.quotaLeft", { pct: args.pct });
		aria = best.name ? t("chat.quotaAriaAccount", { ...args, account: best.name }) : t("chat.quotaAria", args);
	} else {
		return null;
	}
	// How much of the window is left, as the meter's share of its track.
	const share = best?.headline.fraction ?? 0;
	// Same colours as fresh figures (their contrast is what the palettes are checked for); only a dotted underline, the
	// tooltip and the accessible name say the figure may be out of date.
	const staleText = stale ? t("chat.quotaStale") : null;
	const resetText =
		variant === "bar" && headlineAt !== null ? t("chat.quotaResetsIn", { time: fmtCountdown(headlineAt - now) }) : null;
	const named = resetText ? `${aria} · ${resetText}` : aria;
	const title = staleText ? (terse ? `${aria} · ${staleText}` : staleText) : terse ? aria : undefined;
	// The button is named by what it shows (a voice user says what they see); the rest — provider, window, account,
	// whether the figure is old — is its description.
	const described = staleText ? t("chat.quotaAriaStale", { aria: named }) : named;
	const button = (
		<>
			<Popover.Trigger asChild>
				<button
					type="button"
					className={cx(
						"flex items-center gap-1.5 whitespace-nowrap rounded-md px-2 py-1 text-xs tabular-nums",
						// A hover rings the pill rather than deepening its tint: a deeper tint under the same text falls under 4.5:1.
						level === "critical"
							? "bg-danger/15 text-danger hover:ring-1 hover:ring-danger/40"
							: level === "low"
								? "bg-warning/15 text-warning hover:ring-1 hover:ring-warning/40"
								: "bg-bg-soft text-muted hover:bg-hover hover:text-fg",
						stale && "underline decoration-dotted underline-offset-2",
					)}
					data-testid="quota"
					data-provider={provider}
					data-variant={variant}
					data-level={level}
					data-exhausted={used ? "true" : undefined}
					data-stale={stale ? "true" : undefined}
					aria-describedby={describedId}
					title={title}
				>
					<QuotaRing share={share} level={level} />
					<span data-testid="quota-figure">{showName ? t("chat.quotaNamed", { provider, text }) : text}</span>
					{resetText ? (
						// The window's reset, inside the pill it belongs to: with several providers in the header a reset
						// between two pills read as the next one's.
						// The spaces keep the figure and the reset apart in the button's name (the flex gap does it for the eye).
						<>
							{" "}
							<span className="opacity-50" aria-hidden="true">
								·
							</span>{" "}
							<span data-testid="quota-reset">{resetText}</span>
						</>
					) : null}
				</button>
			</Popover.Trigger>
			<span id={describedId} className="sr-only">
				{described}
			</span>
		</>
	);
	return (
		<Popover.Root>
			{variant === "bar" ? (
				<div className="flex shrink-0 items-center" data-testid="quota-bar">
					{button}
				</div>
			) : (
				button
			)}
			<Popover.Portal>
				<Popover.Content
					align="end"
					sideOffset={6}
					collisionPadding={8}
					className="z-50 max-w-[calc(100vw-1rem)] space-y-2 rounded-xl border border-border bg-surface p-3 text-xs shadow-2xl"
					data-testid="quota-popover"
					aria-labelledby={titleId}
				>
					<div id={titleId} className="font-medium">
						{t("chat.quotaTitle", { provider })}
					</div>
					{accounts.map((a, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: unnamed accounts have no id, and the list is only replaced as a whole.
						<section key={i} className="space-y-0.5" data-testid="quota-account">
							{a.name || accounts.length > 1 ? (
								<div className="flex items-center gap-1.5 pt-1 font-medium text-muted">
									<span className="min-w-0 truncate">{a.name ?? t("chat.quotaAccountN", { n: i + 1 })}</span>
									{i === 0 && accounts.length > 1 ? <Badge tone="success">{t("chat.quotaBest")}</Badge> : null}
								</div>
							) : null}
							{a.windows.map((w) => {
								const at = w.limit.window?.resetsAt;
								return (
									<div key={w.limit.id} className="whitespace-nowrap tabular-nums" data-testid="quota-window">
										{at
											? t("chat.quotaWindow", {
													label: w.limit.label,
													pct: pct(w.fraction),
													time: fmtCountdown(at - Date.now()),
												})
											: t("chat.quotaWindowNoReset", { label: w.limit.label, pct: pct(w.fraction) })}
									</div>
								);
							})}
						</section>
					))}
					{file ? <UsageWaitChoice file={file} /> : null}
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
