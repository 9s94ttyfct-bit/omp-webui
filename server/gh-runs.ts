import {
	CI_ACTIVE_MS,
	CI_RUN_LIMIT,
	type CiAnswer,
	type CiJob,
	type CiProblem,
	type CiRun,
	type CiRuns,
	type CiScope,
	type CiState,
	ciPollMs,
	isActive,
} from "../shared/ci.ts";
import { isRecord } from "../shared/guards.ts";
import { type GhRun, ghEnv, problemOf, spawnGh } from "./gh-issues.ts";
import type { Run } from "./git.ts";
import { vetRepository } from "./git-vet.ts";

/**
 * The GitHub Actions runs of a conversation's folder, for the side panel's CI tab: `gh run list` and `gh run view --json
 * jobs`, run with the person's own GitHub CLI in the repository, as the Issues tab runs `gh` (`server/gh-issues.ts`), and
 * only in a repository that names no command (`vetRepository`). Read only.
 *
 * The server does not poll on its own: a list is looked at when a page asks for it and the last look is older than its
 * interval (`ciPollMs`: 10 s while a run is queued or running, 60 s when every run is finished, longer after failures).
 * Every page that asks within the interval gets the same look, and a look already under way is waited for, not repeated: so
 * one repository's runs cost one `gh` per interval, however many pages watch them, and a folder nobody looks at costs
 * nothing. Each answer says when the page may ask again (`nextMs`).
 */

/** `gh` talks to GitHub. */
const GH_TIMEOUT_MS = 15_000;
/** git, to vet the folder and read its branch. */
const GIT_TIMEOUT_MS = 3000;
/** How long the folder's repository and branch are kept: a checkout of another branch is seen within this. */
const WHERE_TTL_MS = 5000;
/** A finished run's jobs do not change. */
const DONE_JOBS_TTL_MS = 10 * 60_000;
/** A page asks a little after a look is due, so that it finds the next one and not the last one again. */
const SLACK_MS = 250;
/** The shortest wait a page is told. */
const MIN_NEXT_MS = 1000;
/** How many lists, folders and job lists are kept; the oldest goes first. */
const KEPT = 50;

const RUN_FIELDS =
	"databaseId,workflowName,displayTitle,headBranch,headSha,event,status,conclusion,createdAt,startedAt,updatedAt,url";

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const web = (v: unknown): string | undefined => (typeof v === "string" && /^https?:\/\//i.test(v) ? v : undefined);
const id = (v: unknown): number | undefined =>
	typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : undefined;

/** GitHub's `status` and `conclusion` as one state (see `CiState`). */
export function stateOf(status: unknown, conclusion: unknown): CiState {
	const s = String(status ?? "").toLowerCase();
	if (s === "in_progress") return "running";
	if (s !== "completed") return "queued";
	switch (String(conclusion ?? "").toLowerCase()) {
		case "success":
			return "success";
		case "cancelled":
			return "cancelled";
		case "skipped":
		case "neutral":
		case "stale":
			return "skipped";
		default:
			// failure, timed_out, startup_failure, action_required, or a word GitHub adds later: not a pass.
			return "failure";
	}
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function runOf(raw: unknown): CiRun | null {
	if (!isRecord(raw)) return null;
	const runId = id(raw.databaseId);
	const url = web(raw.url);
	if (runId === undefined || url === undefined) return null;
	const state = stateOf(raw.status, raw.conclusion);
	const conclusion = str(raw.conclusion);
	const startedAt = str(raw.startedAt);
	return {
		id: runId,
		workflow: str(raw.workflowName) ?? "",
		title: str(raw.displayTitle) ?? "",
		branch: str(raw.headBranch) ?? "",
		event: str(raw.event) ?? "",
		sha: str(raw.headSha) ?? "",
		state,
		...(conclusion && !isActive(state) ? { conclusion: conclusion.toLowerCase() } : {}),
		createdAt: str(raw.createdAt) ?? "",
		...(startedAt ? { startedAt } : {}),
		updatedAt: str(raw.updatedAt) ?? "",
		url,
	};
}

/** `gh run list --json …`: the runs it names, in its order (newest first); null when the text is not that list. */
export function parseRunList(text: string): CiRun[] | null {
	const raw = parseJson(text);
	if (!Array.isArray(raw)) return null;
	return raw
		.map(runOf)
		.filter((r): r is CiRun => r !== null)
		.slice(0, CI_RUN_LIMIT);
}

/** `gh run view N --json jobs`: the run's jobs, each with the first step that failed; null when the text is not that. */
export function parseJobs(text: string): CiJob[] | null {
	const raw = parseJson(text);
	if (!isRecord(raw) || !Array.isArray(raw.jobs)) return null;
	const out: CiJob[] = [];
	for (const j of raw.jobs) {
		if (!isRecord(j)) continue;
		const jobId = id(j.databaseId);
		const url = web(j.url);
		if (jobId === undefined || url === undefined) continue;
		const state = stateOf(j.status, j.conclusion);
		const startedAt = str(j.startedAt);
		const completedAt = str(j.completedAt);
		let failedStep: string | undefined;
		if (state === "failure" && Array.isArray(j.steps)) {
			const step = j.steps.find(
				(s) => isRecord(s) && stateOf(s.status, s.conclusion) === "failure" && typeof s.name === "string",
			) as Record<string, unknown> | undefined;
			failedStep = str(step?.name);
		}
		out.push({
			id: jobId,
			name: str(j.name) ?? "",
			state,
			...(startedAt ? { startedAt } : {}),
			...(completedAt && !isActive(state) ? { completedAt } : {}),
			url,
			...(failedStep ? { failedStep } : {}),
		});
	}
	return out;
}

/** What looks like a GitHub token, whatever printed it: never passed on to a page. */
const TOKEN = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g;

/** What `gh` said on a failure, as one of the problems the tab explains: GitHub's rate limit, or what the Issues tab reads. */
export function ciProblemOf(stderr: string): { problem: CiProblem; message?: string } {
	if (/rate limit/i.test(stderr)) return { problem: "rate-limited" };
	const read = problemOf(stderr);
	return read.message ? { problem: read.problem, message: read.message.replace(TOKEN, "[token]") } : read;
}

type Answer<T> = { ok: true; value: T } | { ok: false; problem: CiProblem; message?: string };

/** The folder's repository (its top folder, which is what the runs are shared by) and its branch (null: detached HEAD). */
interface Where {
	top: string;
	branch: string | null;
}

/** One list's last look, shared by every page that asks for it. */
interface Watch {
	answer: Answer<CiRuns> | null;
	/** When the last look was taken (`now`). */
	at: number;
	/** How long it is good for (`ciPollMs`). */
	interval: number;
	/** Looks that failed in a row. */
	failures: number;
	/** The look under way, which a second ask waits for. */
	pending: Promise<void> | null;
}

interface KeptJobs {
	at: number;
	ttl: number;
	promise: Promise<Answer<CiJob[]>>;
}

export interface GhRunsOptions {
	run?: GhRun;
	env?: Record<string, string | undefined>;
	now?: () => number;
}

/** Keep `map` to `KEPT` entries: the least recently set goes first (a get that matters sets again). */
function bound<K, V>(map: Map<K, V>): void {
	for (const old of map.keys()) {
		if (map.size <= KEPT) break;
		map.delete(old);
	}
}

export class GhRuns {
	readonly #run: GhRun;
	readonly #env: Record<string, string | undefined>;
	readonly #now: () => number;
	readonly #where = new Map<string, { at: number; promise: Promise<Answer<Where>> }>();
	readonly #watches = new Map<string, Watch>();
	readonly #jobs = new Map<string, KeptJobs>();

	constructor(opts: GhRunsOptions = {}) {
		this.#run = opts.run ?? spawnGh;
		this.#now = opts.now ?? Date.now;
		this.#env = ghEnv(opts.env);
	}

	/**
	 * The folder's runs: of its current branch (`branch`), or of every branch (`all`). `dir` is a folder as `directoryOf`
	 * returns it. `fresh` looks again now (the Refresh button), whatever the last look's age.
	 */
	async runs(dir: string, scope: CiScope, opts: { fresh?: boolean } = {}): Promise<CiAnswer<CiRuns>> {
		const where = await this.#locate(dir);
		// A folder that cannot be looked at is asked about again as after a failed look.
		if (!where.ok) return { ...where, nextMs: ciPollMs(where, 1) };
		const { top, branch } = where.value;
		// A detached HEAD has no branch to list: its list is every branch's.
		const listed: CiScope = branch === null ? "all" : scope;
		const key = `${top}\0${listed === "all" ? "" : `branch:${branch}`}`;
		let watch = this.#watches.get(key);
		if (!watch) watch = { answer: null, at: 0, interval: 0, failures: 0, pending: null };
		// Asked for: it is the most recent, and the last to be dropped.
		this.#watches.delete(key);
		this.#watches.set(key, watch);
		bound(this.#watches);
		const due = watch.answer === null || opts.fresh === true || this.#now() - watch.at >= watch.interval;
		if (due && watch.pending === null) watch.pending = this.#look(watch, top, listed, branch);
		if (watch.pending) await watch.pending;
		const answer = watch.answer ?? { ok: false, problem: "failed" };
		const nextMs = Math.max(MIN_NEXT_MS, watch.at + watch.interval - this.#now() + SLACK_MS);
		if (!answer.ok) return { ...answer, nextMs };
		// What the page asked for, though a detached HEAD lists every branch.
		return { ok: true, value: { ...answer.value, scope: listed }, nextMs };
	}

	/** One run's jobs. Kept 10 s while one is queued or running, 10 minutes once all are finished. */
	async jobs(dir: string, runId: number, opts: { fresh?: boolean } = {}): Promise<CiAnswer<CiJob[]>> {
		if (!Number.isSafeInteger(runId) || runId < 1)
			return { ok: false, problem: "failed", message: "Not a run id", nextMs: CI_ACTIVE_MS };
		const where = await this.#locate(dir);
		if (!where.ok) return { ...where, nextMs: ciPollMs(where, 1) };
		const key = `${where.value.top}\0${runId}`;
		const now = this.#now();
		let kept = this.#jobs.get(key);
		if (!kept || opts.fresh === true || now - kept.at >= kept.ttl) {
			const entry: KeptJobs = {
				at: now,
				ttl: CI_ACTIVE_MS,
				promise: Promise.resolve({ ok: false, problem: "failed" }),
			};
			entry.promise = this.#gh(where.value.top, ["gh", "run", "view", String(runId), "--json", "jobs"], parseJobs).then(
				(answer) => {
					if (answer.ok && answer.value.length > 0 && !answer.value.some((j) => isActive(j.state)))
						entry.ttl = DONE_JOBS_TTL_MS;
					// A problem may be fixed before the next ask: only a list is kept.
					if (!answer.ok && this.#jobs.get(key) === entry) this.#jobs.delete(key);
					return answer;
				},
			);
			kept = entry;
		}
		this.#jobs.delete(key);
		this.#jobs.set(key, kept);
		bound(this.#jobs);
		const answer = await kept.promise;
		const nextMs = Math.max(MIN_NEXT_MS, kept.at + kept.ttl - this.#now() + SLACK_MS);
		return { ...answer, nextMs };
	}

	async #look(watch: Watch, top: string, scope: CiScope, branch: string | null): Promise<void> {
		const argv = ["gh", "run", "list", "--json", RUN_FIELDS, "--limit", String(CI_RUN_LIMIT)];
		if (scope === "branch" && branch !== null) argv.push("--branch", branch);
		try {
			const got = await this.#gh(top, argv, parseRunList);
			const answer: Answer<CiRuns> = got.ok ? { ok: true, value: { scope, branch, runs: got.value } } : got;
			watch.failures = answer.ok ? 0 : watch.failures + 1;
			watch.answer = answer;
			watch.at = this.#now();
			watch.interval = ciPollMs(answer, watch.failures);
		} finally {
			watch.pending = null;
		}
	}

	/** The folder's repository and branch, vetted first; kept for a few seconds (and shared while it is asked). */
	#locate(dir: string): Promise<Answer<Where>> {
		const now = this.#now();
		const kept = this.#where.get(dir);
		if (kept && now - kept.at < WHERE_TTL_MS) return kept.promise;
		const promise = this.#find(dir);
		this.#where.delete(dir);
		this.#where.set(dir, { at: now, promise });
		bound(this.#where);
		return promise;
	}

	async #find(dir: string): Promise<Answer<Where>> {
		const git: Run = async (cmd, cwd, timeoutMs, env) => {
			const ran = await this.#run(cmd, cwd, timeoutMs, env);
			return typeof ran === "string" ? null : { code: ran.code, stdout: ran.stdout };
		};
		// `gh` runs git in the folder: one whose repository names a command is not looked at, as for the Issues tab.
		const vetting = await vetRepository(git, dir, GIT_TIMEOUT_MS, this.#env);
		if (!vetting.ok) {
			if (vetting.slow) return { ok: false, problem: "slow" };
			return vetting.refused
				? { ok: false, problem: "unsafe", message: vetting.refused }
				: { ok: false, problem: "no-repo" };
		}
		const top = await git(["git", "rev-parse", "--show-toplevel"], dir, GIT_TIMEOUT_MS, this.#env);
		if (top === null) return { ok: false, problem: "slow" };
		const topDir = top.stdout.trim();
		if (top.code !== 0 || !topDir) return { ok: false, problem: "no-repo" };
		// `--show-current` also names a branch with no commit yet, and prints nothing on a detached HEAD.
		const head = await git(["git", "branch", "--show-current"], dir, GIT_TIMEOUT_MS, this.#env);
		if (head === null) return { ok: false, problem: "slow" };
		const branch = head.code === 0 ? head.stdout.trim() || null : null;
		return { ok: true, value: { top: topDir, branch } };
	}

	async #gh<T>(cwd: string, argv: string[], parse: (text: string) => T | null): Promise<Answer<T>> {
		const ran = await this.#run(argv, cwd, GH_TIMEOUT_MS, this.#env);
		if (ran === "missing") return { ok: false, problem: "no-gh" };
		if (ran === "slow") return { ok: false, problem: "slow" };
		if (ran.code !== 0) return { ok: false, ...ciProblemOf(ran.stderr) };
		const value = parse(ran.stdout);
		return value === null
			? { ok: false, problem: "failed", message: "gh gave an answer that is not what was asked for" }
			: { ok: true, value };
	}
}
