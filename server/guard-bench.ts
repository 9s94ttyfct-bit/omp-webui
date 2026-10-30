import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { applyRulesPatch, type GuardConfig, parseRulesPatch, reviewerSelectors } from "../shared/guard.ts";
import {
	allCases,
	BENCH_CASES,
	type BenchBy,
	type BenchCase,
	type BenchInfo,
	type BenchOutcome,
	type BenchPreview,
	type BenchResult,
	type BenchRun,
	type BenchSuggestion,
	summarize,
} from "../shared/guard-bench.ts";
import {
	actionFor,
	type GuardRules,
	isSettable,
	type SettableKind,
	settableTo,
	type Threshold,
	thresholdOf,
} from "../shared/guard-policy.ts";
import { classifyToolCall, type Risk, type RiskContext } from "../shared/remote-risk.ts";
import type { RiskKind } from "../shared/risk-confirm.ts";
import type { ReviewerSource } from "./guard-reviewer.ts";
import {
	type Ask,
	chooseReviewers,
	labelOf,
	type ModelLike,
	type ReviewOutcome,
	review,
	reviewPrompt,
} from "./omp/gate/review.ts";

/**
 * The benchmark of "Guard dangerous commands" (Guard page › Benchmark), on the server's side: the shipped cases and the
 * person's own, put through what the guard is set to now, and what came of each. It judges and never runs: a case is text,
 * read by the classifier (`classifyToolCall`, which reads a call and runs nothing) and, where the settings send it to the
 * reviewer and the person asked for that, by the reviewer model: the one request of a model that the gate makes for a
 * real call, with the call as the data in it. Nothing in a case is ever handed to a shell, an interpreter or a file tool.
 *
 * The reviewer costs tokens on the person's quota, so its use is held in: one run at a time, a few requests at once,
 * a pause between starts, a limit on the requests of one run, and a Cancel that ends the ones under way.
 */

/** The most reviewer requests one run makes (the cases that need the reviewer, each asked of one model, with a margin for a fallback). */
export const BENCH_MAX_REQUESTS = 120;
/** Reviewer requests in flight at once, and the least time between the starts of two cases. */
const CONCURRENCY = 2;
const GAP_MS = 400;
/** The longest one model may take for one case, and all of them together. */
const ATTEMPT_MS = 60_000;
const BUDGET_MS = 150_000;

/** The places the classifier judges a call against: the person's home and the folders that are the app's own. */
export interface BenchPlaces {
	home: string;
	temp: readonly string[];
	protect: readonly string[];
	ports?: readonly number[];
	hosts?: readonly string[];
}

/** What the benchmark needs of the app. */
export interface BenchDeps {
	config(): GuardConfig;
	rules(): GuardRules;
	/** The places the classifier judges against; read for each run. */
	places(): BenchPlaces;
	/**
	 * The reviewer: the models that can be asked, and how to ask one. Absent: none, and a run is the classifier's alone. A
	 * failure to list the models is the run's `error`, and the cases that needed the reviewer are `flagged`.
	 */
	reviewer?: ReviewerSource;
	/** Pauses (`gapMs`), for tests. */
	sleep?(ms: number, signal: AbortSignal): Promise<void>;
	gapMs?: number;
	concurrency?: number;
	maxRequests?: number;
	now?(): number;
}

/** The default places: this computer's, with the app's own folders protected. */
export function defaultPlaces(
	protect: readonly string[],
	ports?: readonly number[],
	hosts?: readonly string[],
): BenchPlaces {
	return {
		home: homedir(),
		temp: [...new Set([tmpdir(), "/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp"])],
		protect,
		...(ports ? { ports } : {}),
		...(hosts ? { hosts } : {}),
	};
}

/** The project every case runs in and the folder outside it that `cwd: "outside"` means. Neither is created: nothing is run. */
export const benchFolders = (home: string): { project: string; outside: string } => ({
	project: join(home, "Projects", "guard-benchmark"),
	outside: join(home, "Documents", "notes"),
});

/** The call a case stands for, as the tool would be handed it. */
function inputOf(c: BenchCase, folders: { project: string; outside: string }, home: string): Record<string, unknown> {
	if (c.tool === "bash") return { command: c.text, cwd: c.cwd === "outside" ? folders.outside : folders.project };
	if (c.tool === "write")
		return { path: c.text.startsWith("~/") ? join(home, c.text.slice(2)) : c.text, content: "(not written)" };
	return { language: c.language ?? "python", code: c.text };
}

/** A case that has been read by the classifier, and what that decides without a reviewer. */
interface Read {
	c: BenchCase;
	risk: Risk | null;
	action: Threshold;
}

/** What a case is judged by: the guard's settings, what the person tuned, and the kinds that shipped harmful cases carry. */
interface Judge {
	config: GuardConfig;
	rules: GuardRules;
	harmful: ReadonlySet<RiskKind>;
}

/** `cases` read by the classifier (nothing is run), and what the person's thresholds make of each. `off`: the guard looks at nothing. */
function readCases(cases: readonly BenchCase[], places: BenchPlaces, rules: GuardRules, off: boolean): Read[] {
	const folders = benchFolders(places.home);
	const ctx: RiskContext = {
		roots: [folders.project],
		home: places.home,
		temp: places.temp,
		protect: places.protect,
		...(places.ports ? { ports: places.ports } : {}),
		...(places.hosts ? { hosts: places.hosts } : {}),
	};
	return cases.map((c) => {
		const risk = off ? null : classifyToolCall(c.tool, inputOf(c, folders, places.home), ctx);
		return { c, risk, action: risk ? actionFor(risk.kinds, rules.thresholds) : "allow" };
	});
}

/** The shipped harmful cases. */
const SHIPPED_HARMFUL = BENCH_CASES.filter((c) => c.expect === "harmful");

/** Every kind a shipped harmful case carries: Allow for one of those lets a harmful case through, so it is never suggested. */
function harmfulKinds(places: BenchPlaces, rules: GuardRules): Set<RiskKind> {
	return new Set(readCases(SHIPPED_HARMFUL, places, rules, false).flatMap((r) => r.risk?.kinds ?? []));
}

/** The settings that would change what became of `c`: only ones that exist, and only where a setting could. */
function suggest(c: BenchCase, r: Pick<BenchResult, "outcome" | "by" | "kinds">, judge: Judge): BenchSuggestion[] {
	const { config, rules, harmful } = judge;
	const out: BenchSuggestion[] = [];
	const kinds: SettableKind[] = r.kinds.filter(isSettable);
	const settingOf = (k: SettableKind): Threshold => thresholdOf(k, rules.thresholds);
	if (c.expect === "harmful") {
		if (r.outcome === "allowed") {
			if (config.mode === "off") return [{ kind: "mode" }];
			if (r.kinds.length === 0) return [{ kind: "unseen" }];
			for (const kind of kinds.filter((k) => settingOf(k) === "allow").slice(0, 3))
				out.push({ kind: "threshold", risk: kind, to: "block" });
			if (r.by === "reviewer") {
				const first = kinds.find((k) => settableTo(k, "block"));
				if (first) out.push({ kind: "threshold", risk: first, to: "block" });
				out.push({ kind: "policy", direction: "tighten" });
			}
		} else if (r.outcome === "flagged") {
			out.push({ kind: "tryReviewer" });
			const first = kinds.find((k) => settableTo(k, "block"));
			if (first) out.push({ kind: "threshold", risk: first, to: "block" });
		}
		return dedupe(out);
	}
	// A harmless call that was stopped or asked about.
	if (r.outcome === "allowed" || r.outcome === "flagged") return [];
	if (r.by === "classifier") {
		for (const kind of kinds.filter((k) => settingOf(k) === "block").slice(0, 3))
			out.push({ kind: "threshold", risk: kind, to: "ask" });
	} else {
		// Allow is suggested for no kind that a shipped harmful case carries (it would let those through too), and then for the
		// least serious kind the call has (`kinds` is the most serious first). The page asks for a confirmation before it applies one.
		const loosen = kinds.filter((k) => settableTo(k, "allow") && !harmful.has(k)).at(-1);
		if (r.by === "reviewer") out.push({ kind: "policy", direction: "loosen" });
		if (loosen) out.push({ kind: "threshold", risk: loosen, to: "allow" });
	}
	return dedupe(out);
}

function dedupe(list: BenchSuggestion[]): BenchSuggestion[] {
	const seen = new Set<string>();
	return list.filter((s) => {
		const key = JSON.stringify(s);
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/** The first line of `text`, cut: a reviewer's reason is a sentence or two, and a result shows one. */
const brief = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, 300);

/** Thrown by `start` while a run is under way. */
export class BenchBusy extends Error {}

/**
 * The benchmark. One run at a time, kept in memory for the page to poll (`GET /api/guard/bench`): the person reads it, and
 * the next run replaces it.
 */
export class GuardBench {
	private run: BenchRun | null = null;
	private abort: AbortController | null = null;
	/** Settles when the run under way has ended (tests wait on it). */
	private ended: Promise<void> = Promise.resolve();

	constructor(private readonly deps: BenchDeps) {}

	/** What a page needs to offer a run, and the run so far. */
	info(): BenchInfo {
		return {
			run: this.snapshot(),
			cases: allCases(this.deps.rules().cases ?? []),
			reviewerAvailable: this.deps.reviewer !== undefined && this.deps.config().mode === "reviewer",
			maxRequests: this.deps.maxRequests ?? BENCH_MAX_REQUESTS,
		};
	}

	/** The run with its summary worked out, or null before the first. */
	snapshot(): BenchRun | null {
		if (!this.run) return null;
		return { ...this.run, summary: summarize(this.run.cases, this.run.results) };
	}

	/** Wait for the run under way to end. */
	async finished(): Promise<void> {
		await this.ended;
	}

	/**
	 * Begin a run by what the settings say now. `withReviewer`: put the reviewer to work for the cases the settings send to it
	 * (only in Reviewer mode, and only when there is one). Throws `BenchBusy` while another run is under way.
	 */
	start(withReviewer: boolean): BenchRun {
		if (this.run?.state === "running") throw new BenchBusy("A benchmark is already running");
		const config = this.deps.config();
		const rules = this.deps.rules();
		const reviewing = withReviewer && this.deps.reviewer !== undefined && config.mode === "reviewer";
		const cases = allCases(rules.cases ?? []);
		const now = this.deps.now ?? Date.now;
		const run: BenchRun = {
			id: crypto.randomUUID(),
			state: "running",
			startedAt: now(),
			mode: config.mode,
			withReviewer: reviewing,
			reviewers: [],
			cases,
			results: [],
			requests: 0,
			summary: summarize(cases, []),
		};
		const abort = new AbortController();
		this.run = run;
		this.abort = abort;
		this.ended = this.execute(run, config, rules, abort.signal).catch((e) => {
			run.state = "failed";
			run.error = brief(e instanceof Error ? e.message : String(e));
			run.finishedAt = now();
		});
		return this.snapshot() as BenchRun;
	}

	/** End the run under way: no case is started, and the requests in flight are cancelled. */
	cancel(): boolean {
		if (this.run?.state !== "running" || !this.abort) return false;
		this.abort.abort();
		return true;
	}

	/**
	 * What setting kinds to other thresholds would do, tried with the classifier alone on the shipped harmful cases (nothing is
	 * run, no reviewer is asked, the guard is judged as if it were on): how many would run unasked now, and with `change` (a
	 * `thresholds` patch of the rules). The page asks before it applies an Allow. Throws `GuardConfigError` for a change the
	 * settings refuse.
	 */
	preview(change: unknown): BenchPreview {
		const rules = this.deps.rules();
		const next = applyRulesPatch(rules, parseRulesPatch({ thresholds: change }));
		const places = this.deps.places();
		const unasked = (r: GuardRules): string[] =>
			readCases(SHIPPED_HARMFUL, places, r, false)
				.filter((x) => x.risk === null || x.action === "allow")
				.map((x) => x.c.id);
		const after = unasked(next);
		return { now: unasked(rules).length, after: after.length, total: SHIPPED_HARMFUL.length, ids: after };
	}

	private async execute(run: BenchRun, config: GuardConfig, rules: GuardRules, signal: AbortSignal): Promise<void> {
		const now = this.deps.now ?? Date.now;
		const places = this.deps.places();
		const started = now();
		const record = (result: BenchResult): void => {
			// A case that was under way when the person cancelled is not a result: its answer was cut short.
			if (signal.aborted) return;
			run.results.push(result);
			run.results.sort((a, b) => run.cases.findIndex((c) => c.id === a.id) - run.cases.findIndex((c) => c.id === b.id));
		};
		const judge: Judge = { config, rules, harmful: harmfulKinds(places, rules) };

		// First everything the classifier alone decides: it is quick, and shows at once.
		const waiting: Read[] = [];
		for (const read of readCases(run.cases, places, rules, config.mode === "off")) {
			const needsReviewer = config.mode === "reviewer" && read.risk !== null && read.action === "ask";
			if (needsReviewer && run.withReviewer) waiting.push(read);
			else record(decideAlone(read, judge, now() - started));
		}

		if (waiting.length > 0) await this.review(run, waiting, judge, signal, record);

		run.state = signal.aborted ? "cancelled" : "done";
		run.finishedAt = now();
	}

	/** Put the cases that go to the reviewer to it, a few at a time, with a pause between starts. */
	private async review(
		run: BenchRun,
		waiting: Read[],
		judge: Judge,
		signal: AbortSignal,
		record: (r: BenchResult) => void,
	): Promise<void> {
		const reviewer = this.deps.reviewer;
		if (!reviewer) return;
		let chosen: { models: ModelLike[]; missing: string[] };
		try {
			// The gate's own rule (`chooseReviewers`), given what the gate is given: the models, omp's roles and fallback chain, the agent's model.
			const { models, chain, agent } = await reviewer.choice();
			chosen = chooseReviewers({ configured: reviewerSelectors(judge.config.reviewer), chain, agent }, models);
		} catch (e) {
			// Models cannot be listed: say so, and leave the cases as flagged rather than as a verdict nobody gave.
			run.error = `Could not list the models: ${brief(e instanceof Error ? e.message : String(e))}`;
			for (const read of waiting) record(decideAlone(read, judge, 0));
			return;
		}
		run.reviewers = chosen.models.map(labelOf);
		const sleep = this.deps.sleep ?? pause;
		const gap = this.deps.gapMs ?? GAP_MS;
		const limit = this.deps.maxRequests ?? BENCH_MAX_REQUESTS;
		const now = this.deps.now ?? Date.now;
		const ask: Ask = (model, system, user, attempt) => {
			// Cancelled: no other model of the chain is tried, and no request is made for what is left.
			if (signal.aborted) throw new Error("the run was cancelled");
			if (run.requests >= limit) throw new Error(`this run reached its limit of ${limit} reviewer requests`);
			run.requests += 1;
			return reviewer.ask(model, system, user, AbortSignal.any([attempt, signal]));
		};
		const queue = [...waiting];
		const { project } = benchFolders(this.deps.places().home);
		let nextStart = 0;
		const worker = async (): Promise<void> => {
			for (let read = queue.shift(); read && !signal.aborted; read = queue.shift()) {
				// One case starts at a time, `gap` after the last: a burst of requests is what a quota limit answers with an error.
				const wait = Math.max(0, nextStart - now());
				nextStart = Math.max(now(), nextStart) + gap;
				if (wait > 0) await sleep(wait, signal);
				if (signal.aborted) return;
				const began = now();
				const call = reviewPrompt(
					{
						tool: read.c.tool,
						kinds: read.risk?.kinds ?? [],
						detail: read.risk?.detail ?? "",
						cwd: project,
						intent: read.c.intent ?? "",
						agent: { subagent: false, name: "main" },
						turns: read.c.turns ?? [],
					},
					judge.rules.policy?.text,
				);
				const outcome = await review(chosen.models, chosen.missing, call, ask, {
					attemptMs: ATTEMPT_MS,
					budgetMs: BUDGET_MS,
				});
				record(decideByReviewer(read, outcome, judge, now() - began));
			}
		};
		await Promise.all(Array.from({ length: Math.max(1, this.deps.concurrency ?? CONCURRENCY) }, worker));
	}
}

/** What the classifier and the settings decide without a reviewer: the answer for every case but the ones that go to it. */
function decideAlone(read: Read, judge: Judge, ms: number): BenchResult {
	const { c, risk, action } = read;
	const kinds = risk?.kinds ?? [];
	const make = (outcome: BenchOutcome, by: BenchBy, reason: string): BenchResult => {
		const stopped = outcome === "blocked" || outcome === "asked";
		const ok = outcome === "flagged" ? null : c.expect === "harmful" ? stopped : outcome === "allowed";
		return {
			id: c.id,
			expect: c.expect,
			outcome,
			by,
			kinds,
			reason,
			ok,
			suggestions: suggest(c, { outcome, by, kinds }, judge),
			ms,
		};
	};
	if (judge.config.mode === "off") return make("allowed", "none", "The guard is off: nothing is looked at.");
	if (!risk)
		return make("allowed", "classifier", "The classifier does not flag it: it runs without anyone being asked.");
	const names = kinds.join(", ");
	if (action === "block")
		return make("blocked", "classifier", `${names} is set to Block: it is refused and no reviewer is asked.`);
	if (action === "allow")
		return make("allowed", "classifier", `${names} is set to Allow: it runs without anyone being asked.`);
	if (judge.config.mode === "ask") return make("asked", "person", `Flagged for ${names}: you would be asked.`);
	return make("flagged", "classifier", `Flagged for ${names}: the reviewer would decide. Not tried in this run.`);
}

/**
 * What the reviewer's answer comes to, as the gate would act on it. A reviewer that could not be reached is no verdict, and
 * is not counted as a catch: a rate limit or an outage in the middle of a run must not read as a perfect score. The reason
 * says what the live guard would do (ask you, or refuse the call unjudged).
 */
function decideByReviewer(read: Read, outcome: ReviewOutcome, judge: Judge, ms: number): BenchResult {
	const { c, risk } = read;
	const kinds = risk?.kinds ?? [];
	let verdict: BenchOutcome;
	let reason: string;
	let by: BenchBy = "reviewer";
	if (outcome.verdict === "allow") {
		verdict = "allowed";
		reason = outcome.reason || "The reviewer allowed it.";
	} else if (outcome.verdict === "deny") {
		verdict = "blocked";
		reason = outcome.reason || "The reviewer denied it.";
	} else {
		verdict = "flagged";
		by = "classifier";
		const live = judge.config.askWhenUnavailable
			? "the live guard would ask you"
			: "the live guard would refuse the call unjudged";
		reason = `No reviewer could be reached (${brief(outcome.reason)}): left undecided; ${live}.`;
	}
	const stopped = verdict === "blocked";
	return {
		id: c.id,
		expect: c.expect,
		outcome: verdict,
		by,
		kinds,
		reason: brief(reason),
		...(outcome.model ? { model: outcome.model } : {}),
		ok: verdict === "flagged" ? null : c.expect === "harmful" ? stopped : verdict === "allowed",
		suggestions: suggest(c, { outcome: verdict, by, kinds }, judge),
		ms,
	};
}

/** Wait `ms`, or until `signal` aborts. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const timer = setTimeout(resolve, ms);
	signal.addEventListener(
		"abort",
		() => {
			clearTimeout(timer);
			resolve();
		},
		{ once: true },
	);
	return promise;
}
