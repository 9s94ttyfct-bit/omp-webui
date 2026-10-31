import type {
	IssueComment,
	IssueDetail,
	IssueFilter,
	IssueLabel,
	IssueState,
	IssueSummary,
	IssuesAnswer,
	IssuesProblem,
} from "../shared/github.ts";
import { ISSUE_LIST_LIMIT, ISSUE_SEARCH_MAX } from "../shared/github.ts";
import { isRecord } from "../shared/guards.ts";
import { childEnv } from "./env.ts";
import type { Run } from "./git.ts";
import { vetRepository } from "./git-vet.ts";
import { RunTimeout, run } from "./omp/run.ts";

/**
 * The GitHub issues of a conversation's folder (#653), read with the person's own GitHub CLI: `gh issue list` and
 * `gh issue view`, run in that folder, so `gh` picks the repository from its remotes as it does in a terminal. Read only.
 *
 * As with the status line's pull request (`server/git.ts`), a folder is looked at only when its repository names no
 * command (`vetRepository`): `gh` runs git there. Every call has a time limit and its answer is kept for a moment, so a
 * second tab or a quick refilter asks GitHub once.
 */

/** `gh` talks to GitHub. */
const GH_TIMEOUT_MS = 15_000;
/** git, to vet the folder. */
const VET_TIMEOUT_MS = 3000;
const LIST_TTL_MS = 30_000;
const VIEW_TTL_MS = 30_000;
/** What one answer of `gh` may print: a hundred issues, or one with long comments. */
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const CACHED = 50;

const LIST_FIELDS = "number,title,state,labels,author,assignees,createdAt,updatedAt,url";
const VIEW_FIELDS = `${LIST_FIELDS},body,comments`;

/** What a command answered, or why it gave no answer. */
export type GhRan = { code: number; stdout: string; stderr: string } | "missing" | "slow";
export type GhRun = (
	argv: string[],
	cwd: string,
	timeoutMs: number,
	env: Record<string, string | undefined>,
) => Promise<GhRan>;

/** `gh` itself, with a time limit and a cap on what it may print (also the CI tab's, `server/gh-runs.ts`). */
export const spawnGh: GhRun = async (argv, cwd, timeoutMs, env) => {
	try {
		const ran = await run(argv, { cwd, base: env, timeoutMs, maxBytes: MAX_OUTPUT_BYTES });
		return { code: ran.code, stdout: ran.stdout, stderr: ran.stderr };
	} catch (e) {
		return e instanceof RunTimeout ? "slow" : "missing";
	}
};

/** The environment `gh` (and the git it runs) is given: nothing may wait for an answer, a pager or an update check. */
export function ghEnv(base: Record<string, string | undefined> = childEnv()): Record<string, string | undefined> {
	return {
		...base,
		// A tool that asks a question would wait for an answer nobody gives.
		GIT_TERMINAL_PROMPT: "0",
		GH_PROMPT_DISABLED: "1",
		GH_NO_UPDATE_NOTIFIER: "1",
		GH_PAGER: "cat",
		NO_COLOR: "1",
	};
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const loginOf = (v: unknown): string | undefined => (isRecord(v) ? str(v.login) || undefined : undefined);

function labelsOf(v: unknown): IssueLabel[] {
	if (!Array.isArray(v)) return [];
	const out: IssueLabel[] = [];
	for (const l of v) {
		const name = isRecord(l) ? str(l.name) : undefined;
		if (!name) continue;
		const color = str((l as Record<string, unknown>).color);
		out.push(color && /^[0-9a-f]{6}$/i.test(color) ? { name, color } : { name });
	}
	return out;
}

/** One issue of `gh`'s JSON as the page gets it; null for anything that is not an issue with a web address. */
function summaryOf(raw: unknown): IssueSummary | null {
	if (!isRecord(raw)) return null;
	const { number, title, url } = raw;
	if (typeof number !== "number" || !Number.isInteger(number) || number < 1) return null;
	if (typeof title !== "string") return null;
	// The page links to it: only a web address may be.
	if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return null;
	const state: IssueState = String(raw.state).toLowerCase() === "closed" ? "closed" : "open";
	const author = loginOf(raw.author);
	return {
		number,
		title,
		state,
		labels: labelsOf(raw.labels),
		...(author ? { author } : {}),
		assignees: Array.isArray(raw.assignees) ? raw.assignees.map(loginOf).filter((a): a is string => !!a) : [],
		createdAt: str(raw.createdAt) ?? "",
		updatedAt: str(raw.updatedAt) ?? "",
		url,
	};
}

/** `gh issue list --json …`: the issues it names, in its order; null when the text is not that list. */
export function parseIssueList(text: string): IssueSummary[] | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (!Array.isArray(raw)) return null;
	return raw.map(summaryOf).filter((i): i is IssueSummary => i !== null);
}

/** `gh issue view N --json …`: the issue with its body and comments; null when the text is not that. */
export function parseIssue(text: string): IssueDetail | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	const summary = summaryOf(raw);
	if (!summary || !isRecord(raw)) return null;
	const comments: IssueComment[] = [];
	if (Array.isArray(raw.comments)) {
		for (const c of raw.comments) {
			if (!isRecord(c) || typeof c.body !== "string") continue;
			const author = loginOf(c.author);
			comments.push({ ...(author ? { author } : {}), body: c.body, createdAt: str(c.createdAt) ?? "" });
		}
	}
	return { ...summary, body: str(raw.body) ?? "", comments };
}

/** What `gh` said on a failure, read as one of the problems the page explains. */
export function problemOf(stderr: string): { problem: IssuesProblem; message?: string } {
	if (/gh auth login|not logged in|authentication required|GH_TOKEN/i.test(stderr)) return { problem: "signed-out" };
	if (
		/no git remotes|none of the git remotes|not a git repository|could not determine (the )?(base )?repo|could not resolve to a repository/i.test(
			stderr,
		)
	) {
		return { problem: "no-repo" };
	}
	const line = stderr
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l.length > 0);
	return line ? { problem: "failed", message: line.slice(0, 300) } : { problem: "failed" };
}

export interface ListOptions {
	state: IssueFilter;
	/** GitHub's search syntax, as `gh issue list --search` takes it. */
	search?: string;
	/** Skip the kept answer (the Refresh button). */
	fresh?: boolean;
}

interface Kept<T> {
	at: number;
	promise: Promise<IssuesAnswer<T>>;
	ttl: number;
}

export interface GhIssuesOptions {
	run?: GhRun;
	env?: Record<string, string | undefined>;
	now?: () => number;
}

export class GhIssues {
	readonly #run: GhRun;
	readonly #env: Record<string, string | undefined>;
	readonly #now: () => number;
	readonly #kept = new Map<string, Kept<unknown>>();

	constructor(opts: GhIssuesOptions = {}) {
		this.#run = opts.run ?? spawnGh;
		this.#now = opts.now ?? Date.now;
		this.#env = ghEnv(opts.env);
	}

	/** The folder's issues. `dir` is a folder as `directoryOf` returns it. */
	list(dir: string, opts: ListOptions): Promise<IssuesAnswer<IssueSummary[]>> {
		const search = (opts.search ?? "").trim().slice(0, ISSUE_SEARCH_MAX);
		const argv = [
			"gh",
			"issue",
			"list",
			"--json",
			LIST_FIELDS,
			"--limit",
			String(ISSUE_LIST_LIMIT),
			"--state",
			opts.state,
		];
		if (search) argv.push("--search", search);
		return this.#keep(`list\0${dir}\0${opts.state}\0${search}`, opts.fresh === true, LIST_TTL_MS, () =>
			this.#ask(dir, argv, parseIssueList),
		);
	}

	/** One issue with its body and comments. */
	view(dir: string, number: number, opts: { fresh?: boolean } = {}): Promise<IssuesAnswer<IssueDetail>> {
		if (!Number.isInteger(number) || number < 1)
			return Promise.resolve({ ok: false, problem: "failed", message: "Not an issue number" });
		const argv = ["gh", "issue", "view", String(number), "--json", VIEW_FIELDS];
		return this.#keep(`view\0${dir}\0${number}`, opts.fresh === true, VIEW_TTL_MS, () =>
			this.#ask(dir, argv, parseIssue),
		);
	}

	async #ask<T>(dir: string, argv: string[], parse: (text: string) => T | null): Promise<IssuesAnswer<T>> {
		// `gh` runs git in the folder: one whose repository names a command is not looked at, as for the status line.
		const vetRun: Run = async (cmd, cwd, timeoutMs, env) => {
			const ran = await this.#run(cmd, cwd, timeoutMs, env);
			return typeof ran === "string" ? null : { code: ran.code, stdout: ran.stdout };
		};
		const vetting = await vetRepository(vetRun, dir, VET_TIMEOUT_MS, this.#env);
		if (!vetting.ok) {
			if (vetting.slow) return { ok: false, problem: "slow" };
			return vetting.refused
				? { ok: false, problem: "unsafe", message: vetting.refused }
				: { ok: false, problem: "no-repo" };
		}
		const ran = await this.#run(argv, dir, GH_TIMEOUT_MS, this.#env);
		if (ran === "missing") return { ok: false, problem: "no-gh" };
		if (ran === "slow") return { ok: false, problem: "slow" };
		if (ran.code !== 0) return { ok: false, ...problemOf(ran.stderr) };
		const value = parse(ran.stdout);
		return value === null
			? { ok: false, problem: "failed", message: "gh gave an answer that is not what was asked for" }
			: { ok: true, value };
	}

	/** An answer asked for a moment ago (or still awaited) serves this ask too; a failure is kept only while awaited. */
	#keep<T>(key: string, fresh: boolean, ttl: number, load: () => Promise<IssuesAnswer<T>>): Promise<IssuesAnswer<T>> {
		const now = this.#now();
		const hit = this.#kept.get(key) as Kept<T> | undefined;
		if (hit && !fresh && now - hit.at < hit.ttl) return hit.promise;
		const kept: Kept<T> = { at: now, ttl, promise: Promise.resolve({ ok: false, problem: "failed" }) };
		kept.promise = load().then(
			(answer) => {
				// Only a list or an issue is worth keeping: a problem may be fixed (a `gh auth login`) before the next look.
				if (!answer.ok && this.#kept.get(key) === kept) this.#kept.delete(key);
				return answer;
			},
			(error) => {
				if (this.#kept.get(key) === kept) this.#kept.delete(key);
				throw error;
			},
		);
		this.#kept.delete(key);
		this.#kept.set(key, kept as Kept<unknown>);
		for (const old of this.#kept.keys()) {
			if (this.#kept.size <= CACHED) break;
			this.#kept.delete(old);
		}
		return kept.promise;
	}
}
