import type { SessionEntry } from "@shared/protocol.ts";
import { useMemo } from "react";
import "../i18n/later.ts";
import { useLang, useT } from "../i18n/index.ts";
import { fmtCost, fmtCostExact, fmtDuration, fmtTime, fmtTokens } from "../lib/format.ts";
import type { AgentMessage } from "../lib/messages.ts";
import { useNow } from "../lib/now.ts";
import { fmtElapsed, fmtFinished, fmtRate } from "../lib/stat-format.ts";
import { liveTurn, stepStats, type TurnStats, turnStats, unsavedSteps } from "../lib/turn-stats.ts";
import type { LiveState } from "../store/live.ts";
import { useTurnClocks } from "../store/turn-clock.ts";
import { Tip } from "./ui.tsx";

/**
 * What the TUI prints after a turn: when it finished, how long it took, the tokens sent, written and read from the
 * cache, how soon the first token came and how fast the output flowed. A figure omp did not record is not shown.
 */

const ITEM = "whitespace-nowrap";
const ROW = "flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs tabular-nums text-muted";

/** The figures a finished and a running turn have in common; each is left out when there is none. */
function Figures({
	tokens,
	ttftMs,
	tokensPerSecond,
}: {
	tokens?: Pick<TurnStats, "input" | "output" | "cacheRead" | "cacheWrite">;
	ttftMs?: number;
	tokensPerSecond?: number;
}) {
	const t = useT();
	return (
		<>
			{tokens ? (
				<>
					{/* The TUI's "in": what was sent and not read from the cache. */}
					<span className={ITEM} data-stat="in">
						{t("chat.statInput", { n: fmtTokens(tokens.input + tokens.cacheWrite) })}
					</span>
					<span className={ITEM} data-stat="out">
						{t("chat.statOutput", { n: fmtTokens(tokens.output) })}
					</span>
					{tokens.cacheRead > 0 ? (
						<span className={ITEM} data-stat="cache">
							{t("chat.statCache", { n: fmtTokens(tokens.cacheRead) })}
						</span>
					) : null}
				</>
			) : null}
			{ttftMs !== undefined ? (
				<span className={ITEM} data-stat="ttft">
					{t("chat.statFirstToken", { value: fmtDuration(ttftMs) })}
				</span>
			) : null}
			{tokensPerSecond !== undefined ? (
				<span className={ITEM} data-stat="speed">
					{t("chat.statSpeed", { n: fmtRate(tokensPerSecond) })}
				</span>
			) : null}
		</>
	);
}

/**
 * Each request's figures, in the tooltip of a turn's stats line. A component of its own, so that a turn of thousands of
 * steps costs nothing until the tooltip is opened: it is not drawn before, and the line is drawn for every frame.
 */
function TurnDetail({ stats }: { stats: TurnStats }) {
	const t = useT();
	return (
		<div className="space-y-1 font-mono">
			<div>
				{t("chat.usageSummary", {
					requests: t(stats.requests === 1 ? "chat.usageRequest" : "chat.usageRequests", { n: stats.requests }),
					input: stats.input.toLocaleString(),
					output: stats.output.toLocaleString(),
					cacheRead: stats.cacheRead.toLocaleString(),
					cacheWrite: stats.cacheWrite.toLocaleString(),
					cost: fmtCostExact(stats.cost),
				})}
			</div>
			{stats.requests > 1
				? stats.steps.map((s, i) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: steps are an immutable ordered list
						<div key={i} className="text-faint">
							{t("chat.usageStep", {
								n: i + 1,
								input: s.input.toLocaleString(),
								output: s.output.toLocaleString(),
								cacheRead: s.cacheRead.toLocaleString(),
								cacheWrite: s.cacheWrite.toLocaleString(),
								cost: fmtCostExact(s.cost),
							})}
							{/* How long the request took, when its first token came and its speed: whatever omp recorded of them. */}
							{[
								s.durationMs !== undefined ? fmtDuration(s.durationMs) : "",
								s.ttftMs !== undefined ? t("chat.statFirstToken", { value: fmtDuration(s.ttftMs) }) : "",
								s.tokensPerSecond !== undefined ? t("chat.statSpeed", { n: fmtRate(s.tokensPerSecond) }) : "",
							]
								.filter(Boolean)
								.map((part) => ` · ${part}`)
								.join("")}
						</div>
					))
				: null}
			{stats.finishedAt ? <div className="text-faint">{fmtTime(stats.finishedAt)}</div> : null}
		</div>
	);
}

/**
 * The stats line of a finished agent turn (all its model requests between two prompts); each request's figures are in
 * the tooltip. `entries` are the turn's assistant entries, one for each of `messages`.
 */
export function TurnStatsLine({ entries, messages }: { entries: SessionEntry[]; messages: AgentMessage[] }) {
	const t = useT();
	const lang = useLang((s) => s.lang);
	const stats = useMemo(
		() => turnStats(messages.flatMap((m, i) => stepStats(m, entries[i]?.timestamp) ?? [])),
		[entries, messages],
	);
	if (!stats) return null;
	const detail = <TurnDetail stats={stats} />;
	return (
		// Under the line, not over it: the line ends the message, and a tip that flipped up covered the reply it describes.
		<Tip label={detail} wide keepSide>
			<span
				className={`${ROW} cursor-default`}
				data-testid="msg-usage"
				data-cost={stats.cost}
				data-requests={stats.requests}
			>
				{stats.models.length ? (
					<span className={ITEM} data-stat="model">
						{stats.models.join(", ")}
					</span>
				) : null}
				{stats.finishedAt ? (
					<time className={ITEM} data-stat="finished" dateTime={new Date(stats.finishedAt).toISOString()}>
						{fmtFinished(stats.finishedAt, Date.now(), lang)}
					</time>
				) : null}
				{stats.elapsedMs !== undefined ? (
					<span className={ITEM} data-stat="took">
						{t("chat.statTook", { value: fmtDuration(stats.elapsedMs) })}
					</span>
				) : null}
				<Figures tokens={stats} ttftMs={stats.ttftMs} tokensPerSecond={stats.tokensPerSecond} />
				<span className={ITEM} data-stat="cost">
					{fmtCost(stats.cost)}
				</span>
			</span>
		</Tip>
	);
}

/**
 * The same figures for the turn that is still running, at the end of its messages: how long it has run, on the page's
 * own clock so it ticks (a page that opened mid-turn never saw it begin, and says nothing), and what its finished
 * requests have used so far. A request in flight has no figures until omp reports them with its end; the one thing the
 * page saw of it is when its first token arrived.
 */
export function LiveTurnStats({ live }: { live: LiveState }) {
	const t = useT();
	const now = useNow(1000);
	const clock = useTurnClocks((s) => s[live.info.liveId]);
	// What the saved requests of the turn add up to, kept as entries are added: a turn of a goal run has thousands.
	const saved = useMemo(() => liveTurn(live.entries, live.leafId), [live.entries, live.leafId]);
	const stats = saved.tally.figures(unsavedSteps(saved.tally.started, live.overlay, saved.promptAt));
	const inFlight = clock?.step;
	const firstToken = inFlight?.firstTokenAt !== undefined ? inFlight.firstTokenAt - inFlight.startedAt : undefined;
	// With a finished request, the first token is the first request's; without one, the request in flight is the first.
	const ttftMs = stats ? stats.ttftMs : firstToken;
	if (!clock && !stats) return null;
	return (
		<div className={ROW} data-testid="turn-stats-live">
			{clock ? (
				<span className={ITEM} data-stat="running">
					{t("chat.statRunning", { value: fmtElapsed(now - clock.startedAt) })}
				</span>
			) : null}
			<Figures tokens={stats ?? undefined} ttftMs={ttftMs} tokensPerSecond={stats?.tokensPerSecond} />
		</div>
	);
}
