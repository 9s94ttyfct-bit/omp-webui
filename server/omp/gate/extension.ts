import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname } from "node:path";
import {
	GUARD_DETAIL_MAX,
	GUARD_UNAVAILABLE,
	GUARD_WORD_FALLBACK,
	type GuardBy,
	type GuardDecision,
	type GuardVerdict,
	type GuardWord,
	newDecisionId,
	parseGuardWord,
} from "../../../shared/guard.ts";
import { actionFor } from "../../../shared/guard-policy.ts";
import { classifyToolCall, type Risk, type RiskContext } from "../../../shared/remote-risk.ts";
import {
	RISK_ALLOW,
	RISK_DENY,
	RISK_LOADED_SUFFIX,
	RISK_SUFFIX,
	type RiskDenial,
	type RiskUnavailable,
	riskTitle,
} from "../../../shared/risk-confirm.ts";
import {
	type Answer,
	type Ask,
	blockedText,
	chooseReviewers,
	deniedText,
	intentOf,
	type ModelLike,
	type Models,
	personSpokeAt,
	recentTurns,
	review,
	reviewPrompt,
	unavailableText,
	usageOf,
} from "./review.ts";

/**
 * The gate of two settings of the app, an omp extension: the web UI starts every conversation's omp with it
 * (`--extension`), and omp calls its `tool_call` handler before it runs a tool, in the main agent and in each subagent, the
 * one point at which a call can still be held back whatever the conversation's permission mode is (a subagent always runs
 * in yolo mode, which omp's own check of dangerous commands ignores). It is copied, with `shared/remote-risk.ts`,
 * `shared/risk-confirm.ts`, `shared/guard.ts` and `review.ts` next to it in the same layout, into the app's data folder
 * (`install.ts`), because omp reads it from a file; it runs in omp's own process and imports nothing else of the app.
 *
 * The server tells it what to do in a small file beside the conversation's settings overlay (`<overlay>.risk`, found from
 * omp's own `--config` argument), which it reads before each call:
 *
 * - "Confirm risky commands from remote pages" (#608): `armed` while the setting is on and the turn was driven from a
 *   remote page. A risky call then waits for the person's answer to omp's own `select` dialog, which the page shows like
 *   an approval; a subagent has no one to ask (omp gives it no dialogs), so its risky calls are refused.
 * - "Guard dangerous commands" (#609): the `guard` word. Unless it is `off`, a risky call is not run until it is approved,
 *   by a reviewer model (`review.ts`) or by the person (`ask`). A reviewer's denial of the main agent's call is put to the
 *   person when somebody will see the question (`askWhenDenied`, #747). Every decision is written down (`GuardDecision`).
 *
 * Which wins: while the first is armed it decides alone (the person is asked, or a subagent's call refused); the guard
 * decides every other risky call. A call that is not risky, or is made while neither applies, runs as the permission
 * mode says. Anything the gate cannot read is read as the strictest word.
 */

/** What omp passes to a `tool_call` handler, as far as the gate reads it. */
interface ToolCall {
	toolName: string;
	toolCallId?: string;
	input?: unknown;
}

/** The session of the agent whose call it is: the entries its history holds, and where a request outside the transcript is recorded. */
interface SessionLike {
	getSessionId?(): string;
	getSessionFile?(): string | undefined;
	getLeafId?(): string | null;
	getBranch?(): unknown[];
	appendModelUsage?(record: Record<string, unknown>, owner: { sessionId: string; parentId: string | null }): unknown;
}

interface Context {
	cwd: string;
	hasUI: boolean;
	ui: { select(title: string, options: string[]): Promise<string | undefined> };
	/** `main`, or `sub` for a subagent (and an advisor), which has no dialogs. */
	agent?: { kind?: string; id?: string; name?: string };
	model?: ModelLike;
	models?: Models;
	modelRegistry?: {
		getApiKeyAndHeaders(
			model: ModelLike,
		): Promise<{ ok: boolean; apiKey?: string; headers?: Record<string, string>; error?: string }>;
	};
	sessionManager?: SessionLike;
}

interface Pi {
	on(
		event: "tool_call",
		handler: (event: ToolCall, ctx: Context) => Promise<{ block: true; reason: string } | undefined>,
	): void;
	pi?: { settings?: unknown };
}

/** The request of omp's own model library the gate makes, as far as it reads it (`@oh-my-pi/pi-ai`, which omp lends to its extensions). */
interface AiModule {
	completeSimple(
		model: ModelLike,
		context: { systemPrompt: string; messages: { role: "user"; content: string; timestamp: number }[] },
		options: { apiKey?: string; headers?: Record<string, string>; maxTokens?: number; signal?: AbortSignal },
	): Promise<{
		content?: unknown;
		usage?: unknown;
		stopReason?: string;
		errorMessage?: string;
		api?: string;
		provider?: string;
		model?: string;
	}>;
}

/** The server's own settings overlay for this process: the last `--config` of omp's command line. */
function overlayFile(argv: readonly string[]): string | null {
	const at = argv.lastIndexOf("--config");
	return at >= 0 && argv[at + 1] ? argv[at + 1] : null;
}

/**
 * What the server says in the `.risk` file: whether "Confirm risky commands" is armed, the places that are never changed
 * unasked, and what the guard does. Only an explicit `armed: false` lets a call go: a file that is gone, cannot be read, is
 * not an object or says nothing about it is not the server's word, and the gate asks. A word of the guard it cannot read is
 * the guard on, with a reviewer of its own choosing.
 */
function readState(file: string | null): {
	armed: boolean;
	protect: string[];
	guard: GuardWord;
	ports?: number[];
	hosts?: string[];
} {
	if (file === null) return { armed: false, protect: [], guard: { ...GUARD_WORD_FALLBACK, mode: "off" } };
	try {
		const state: unknown = JSON.parse(readFileSync(`${file}${RISK_SUFFIX}`, "utf8"));
		const record = typeof state === "object" && state !== null ? (state as Record<string, unknown>) : {};
		const protect = Array.isArray(record.protect)
			? record.protect.filter((p): p is string => typeof p === "string")
			: [];
		// Any port that is not a port, or none at all, is not known: every loopback /api/ asks.
		const ports = Array.isArray(record.ports)
			? record.ports.filter((p): p is number => Number.isInteger(p) && p > 0 && p <= 65535)
			: [];
		// The addresses the server answers on besides the loopback; any that is not one is left out (the classifier does).
		const hosts = Array.isArray(record.hosts)
			? record.hosts.filter((h): h is string => typeof h === "string" && h.trim() !== "")
			: [];
		return {
			armed: record.armed !== false,
			protect,
			guard: parseGuardWord(record.guard) ?? GUARD_WORD_FALLBACK,
			...(ports.length > 0 ? { ports } : {}),
			...(hosts.length > 0 ? { hosts } : {}),
		};
	} catch {
		return { armed: true, protect: [], guard: GUARD_WORD_FALLBACK };
	}
}

const real = (path: string): string => {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
};

function contextFor(
	cwd: string,
	protect: readonly string[],
	ports?: readonly number[],
	hosts?: readonly string[],
): RiskContext {
	const home = homedir();
	const temp = [tmpdir(), "/tmp", "/private/tmp", "/var/tmp", "/private/var/tmp"];
	const agent = process.env.PI_CODING_AGENT_DIR;
	return {
		roots: [...new Set([cwd, real(cwd)])],
		home,
		temp: [...new Set([...temp, ...temp.map(real)])],
		protect: [...protect, ...(agent ? [agent, real(agent)] : [])],
		...(ports ? { ports } : {}),
		...(hosts ? { hosts } : {}),
	};
}

/** What the agent is called: `main`, or the subagent's own name (its id: `Worker`; its `name` is the kind of agent, `task`). */
const agentName = (ctx: Context, subagent: boolean): string =>
	subagent ? (ctx.agent?.id ?? ctx.agent?.name ?? "subagent") : "main";

const refuse = (reason: string): { block: true; reason: string } => ({ block: true, reason });

/** What a call names, as text: the guard's own files are looked for in it. */
function textOf(input: unknown): string {
	try {
		return JSON.stringify(input) ?? "";
	} catch {
		return String(input);
	}
}

/** Whether the call names one of the app's own files or folders (as written, or as they really are). */
function namesOwn(input: unknown, own: readonly string[]): string | null {
	const text = textOf(input);
	for (const place of own) {
		if (place === "") continue;
		for (const name of new Set([place, real(place)])) if (text.includes(name)) return place;
	}
	return null;
}

// ---------------------------------------------------------------------------------------------------- the model

let ai: AiModule | null = null;

/** omp's model library, which it lends to the extensions it runs; null when this omp does not. */
async function modelLibrary(): Promise<AiModule | null> {
	if (ai) return ai;
	try {
		// Not a dependency of the app: omp lends it to the extensions it runs, by this name, so only the running omp can resolve
		// it (and only a name written out here: omp resolves it as the extension is loaded, not from a variable).
		// @ts-expect-error TS2307: resolved by the running omp.
		ai = await import("@oh-my-pi/pi-ai");
	} catch {
		ai = null;
	}
	return ai;
}

const textOfAnswer = (content: unknown): string =>
	Array.isArray(content)
		? content
				.map((b) => (typeof b === "object" && b !== null && "text" in b && typeof b.text === "string" ? b.text : ""))
				.join("")
		: "";

/** The most output a reviewer may write: its verdict is a line or two. */
const MAX_ANSWER_TOKENS = 1_500;

/**
 * `work`, unless `signal` aborts first: a lookup that hangs (a credential helper that never answers) must not hold the handler
 * past the attempt's time. The work itself is not cancelled (nothing it was given can), only waited for no longer.
 */
function within<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	const stop = (): void =>
		reject(signal.reason instanceof Error ? signal.reason : new Error("the attempt ran out of time"));
	if (signal.aborted) stop();
	else signal.addEventListener("abort", stop, { once: true });
	work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stop));
	return promise;
}

function askWith(ctx: Context): Ask {
	return async (model, system, user, signal): Promise<Answer> => {
		const library = await within(modelLibrary(), signal);
		if (!library) throw new Error("this omp lends no model library to extensions");
		if (!ctx.modelRegistry) throw new Error("this omp gives extensions no model registry");
		const auth = await within(ctx.modelRegistry.getApiKeyAndHeaders(model), signal);
		if (!auth.ok) throw new Error(auth.error ?? "no credentials for this model");
		const message = await library.completeSimple(
			model,
			{ systemPrompt: system, messages: [{ role: "user", content: user, timestamp: Date.now() }] },
			{ apiKey: auth.apiKey, headers: auth.headers, maxTokens: MAX_ANSWER_TOKENS, signal },
		);
		return {
			text: textOfAnswer(message.content),
			usage: usageOf(message.usage),
			stopReason: message.stopReason ?? "stop",
			errorMessage: message.errorMessage,
		};
	};
}

/** omp's own fallbacks for a `reviewer` role, and how long a `tool_call` handler may take, from its settings. */
async function ompSettings(pi: Pi): Promise<{ chain: string[]; handlerMs: number }> {
	const out = { chain: [] as string[], handlerMs: 30_000 };
	try {
		// As above: omp's own settings registry, resolved by the running omp.
		// @ts-expect-error TS2307: resolved by the running omp.
		const library = await import("@oh-my-pi/pi-coding-agent/config/registry");
		const registry: { lookup(id: string): { get(scope: unknown): unknown } | undefined } = library;
		const scope = pi.pi?.settings;
		const chains = registry.lookup("retry.fallbackChains")?.get(scope);
		const reviewer =
			typeof chains === "object" && chains !== null && "reviewer" in chains ? chains.reviewer : undefined;
		if (Array.isArray(reviewer)) out.chain = reviewer.filter((s): s is string => typeof s === "string");
		const timeout = registry.lookup("extensionHandlers.toolCallTimeoutMs")?.get(scope);
		if (typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0) out.handlerMs = timeout;
	} catch {
		// Not readable: the defaults.
	}
	return out;
}

// ---------------------------------------------------------------------------------------------------- the record

/** Calls the reviewer denied, kept while the process lives: asking again about the same call is not another chance at a yes. */
const denied = new Map<string, { at: number; model: string; reason: string }>();
const DENIAL_MEMORY_MS = 10 * 60_000;

const DENIALS_KEPT = 500;

function remembered(key: string): { at: number; model: string; reason: string } | null {
	const now = Date.now();
	for (const [k, v] of denied) if (now - v.at > DENIAL_MEMORY_MS) denied.delete(k);
	return denied.get(key) ?? null;
}

function rememberDenial(key: string, model: string, reason: string): void {
	// Oldest first (a Map keeps the order it was filled in): the memory stays small in a process that runs for days.
	while (denied.size >= DENIALS_KEPT) denied.delete(denied.keys().next().value as string);
	denied.set(key, { at: Date.now(), model, reason });
}

/** One line to the decisions file; never throws (a log that cannot be written must not make a call run, or fail). */
function writeDecision(word: GuardWord, decision: GuardDecision): void {
	if (word.log === "") return;
	try {
		mkdirSync(dirname(word.log), { recursive: true, mode: 0o700 });
		appendFileSync(word.log, `${JSON.stringify(decision)}\n`, { mode: 0o600 });
	} catch {
		// Not written down: the call is still decided as it was.
	}
}

/** The requests a reviewer made, in the conversation's own history, where its totals and usage are read from (`model_usage`). */
function recordSpend(
	session: SessionLike | undefined,
	attempts: readonly { model: ModelLike; answer?: Answer }[],
): void {
	if (!session?.appendModelUsage || !session.getSessionId) return;
	for (const attempt of attempts) {
		if (!attempt.answer) continue;
		try {
			session.appendModelUsage(
				{
					purpose: "guard",
					role: "reviewer",
					api: attempt.model.api,
					provider: attempt.model.provider,
					model: attempt.model.id,
					usage: {
						input: attempt.answer.usage.input,
						output: attempt.answer.usage.output,
						cacheRead: attempt.answer.usage.cacheRead,
						cacheWrite: attempt.answer.usage.cacheWrite,
						totalTokens: attempt.answer.usage.input + attempt.answer.usage.output,
						cost: { total: attempt.answer.usage.cost },
					},
					stopReason: attempt.answer.stopReason,
					...(attempt.answer.errorMessage ? { errorMessage: attempt.answer.errorMessage } : {}),
				},
				{ sessionId: session.getSessionId(), parentId: session.getLeafId?.() ?? null },
			);
		} catch {
			// Not counted: the decision stands, and its own record says what it cost.
		}
	}
}

// ---------------------------------------------------------------------------------------------------- the two ways a call is held

/** "Confirm risky commands from remote pages": the person decides, on the page; a subagent's risky call is refused. */
async function confirmWithPerson(
	event: ToolCall,
	ctx: Context,
	risk: Risk,
): Promise<{ block: true; reason: string } | undefined> {
	const why = risk.kinds.join(", ");
	if (!ctx.hasUI) {
		return refuse(
			`This call is high-risk (${why}) and needs the person's confirmation, which a subagent cannot ask for. It was not run. Do not look for another way to do it: name the exact command in your final answer, so that the main agent can have the person confirm it.`,
		);
	}
	const answer = await ctx.ui.select(riskTitle(event.toolName, risk.kinds, risk.detail, { by: "remote" }), [
		RISK_ALLOW,
		RISK_DENY,
	]);
	if (answer === RISK_ALLOW) return undefined;
	return refuse(
		answer === RISK_DENY
			? `The person did not allow this high-risk call (${why}) from the remote page. It was not run. Retry it only after the person explicitly approves this exact call, and do not look for another way to do the same thing: say what you meant to do and why, and let the person decide.`
			: `The person did not answer the confirmation of this high-risk call (${why}), so it was not run. Do not look for another way to do it: tell the person what you need and wait, and retry it only after they explicitly approve it.`,
	);
}

/** Everything the guard writes down about one call before the verdict is known. */
interface Frame {
	event: ToolCall;
	ctx: Context;
	risk: Risk;
	word: GuardWord;
	subagent: boolean;
	intent: string;
	started: number;
}

function decide(
	frame: Frame,
	verdict: GuardVerdict,
	by: GuardBy,
	reason: string,
	extra: Partial<Pick<GuardDecision, "model" | "tried" | "usage">> = {},
): GuardDecision {
	const at = Date.now();
	const decision: GuardDecision = {
		id: newDecisionId(at),
		at,
		session: frame.ctx.sessionManager?.getSessionId?.() ?? "",
		file: frame.ctx.sessionManager?.getSessionFile?.() ?? "",
		agent: agentName(frame.ctx, frame.subagent),
		subagent: frame.subagent,
		toolCallId: frame.event.toolCallId ?? "",
		tool: frame.event.toolName,
		kinds: frame.risk.kinds,
		cwd: frame.ctx.cwd,
		intent: frame.intent,
		detail: frame.risk.detail.slice(0, GUARD_DETAIL_MAX),
		mode: frame.word.mode,
		verdict,
		by,
		reason,
		ms: at - frame.started,
		...extra,
	};
	writeDecision(frame.word, decision);
	return decision;
}

/**
 * Ask the person, as the confirmation of #608 does, and write the answer down as theirs. `denied`: the reviewer's denial
 * they are asked to overrule, which the dialog names apart from the call (#753), and the record and the agent are told the
 * answer was given over. `unavailable`: no reviewer could be reached, which the dialog names apart from the call too (#764).
 */
async function askPerson(
	frame: Frame,
	extra: Partial<Pick<GuardDecision, "model" | "tried" | "usage">> = {},
	denied?: RiskDenial,
	unavailable?: RiskUnavailable,
) {
	const { event, ctx, risk } = frame;
	const title = riskTitle(event.toolName, risk.kinds, risk.detail, { by: "guard", denied, unavailable });
	const answer = await ctx.ui.select(title, [RISK_ALLOW, RISK_DENY]);
	const why = risk.kinds.join(", ");
	const before = denied ? `The reviewer (${denied.model}) denied it: ${denied.reason || "no reason given"}. ` : "";
	if (answer === RISK_ALLOW) {
		decide(frame, "allow", "person", `${before}The person allowed it.`, extra);
		return undefined;
	}
	decide(
		frame,
		"deny",
		"person",
		`${before}${answer === RISK_DENY ? "The person denied it." : "The person did not answer."}`,
		extra,
	);
	return refuse(
		before +
			(answer === RISK_DENY
				? `The person did not allow this high-risk call (${why}). It was not run. Retry it only after the person explicitly approves this exact call, and do not look for another way to do the same thing: say what you meant to do and why, and let the person decide.`
				: `The person did not answer the question about this high-risk call (${why}), so it was not run. Do not look for another way to do it: tell the person what you need and wait, and retry it only after they explicitly approve it.`),
	);
}

/** "Guard dangerous commands" in `reviewer` mode (and, for `ask`, the person alone). */
async function guardCall(
	pi: Pi,
	event: ToolCall,
	ctx: Context,
	risk: Risk,
	word: GuardWord,
): Promise<{ block: true; reason: string } | undefined> {
	// The tools that set up remote access are the app's own, served only to the conversation the person opened for that, and omp
	// itself asks about each one before it runs (also in Auto-approve): a reviewer on top of the person's own answer is no guard.
	if (risk.kinds.every((k) => k === "remote_tool")) return undefined;
	const subagent = ctx.agent?.kind === "sub" || !ctx.hasUI;
	const session = ctx.sessionManager;
	let branch: unknown[] = [];
	try {
		branch = session?.getBranch?.() ?? [];
	} catch {
		// No history to show: the call is judged on what it is.
	}
	const frame: Frame = {
		event,
		ctx,
		risk,
		word,
		subagent,
		intent: event.toolCallId ? intentOf(branch, event.toolCallId) : "",
		started: Date.now(),
	};
	const why = risk.kinds.join(", ");
	// Somebody will see a question about the main agent's call: a page is open on the conversation, or the app tells them.
	const askable = !subagent && word.page;
	// A reviewer's denial is put to them too, unless the person said not to; the server says not to while the conversation is
	// unattended, whose turn never waits for the person (#752).
	const overrule = askable && word.askWhenDenied;

	// The guard's own settings, state and log are not the agent's to change, whoever would approve: no reviewer is asked.
	const own = namesOwn(event.input, word.own);
	if (own !== null) {
		decide(frame, "deny", "guard", "The call names the files that configure the guard.");
		return refuse(
			`This call names a file or folder of the safety guard itself (${own}). The agent may not change what guards it, so no reviewer was asked and it was not run. Do not look for another way to do it.`,
		);
	}

	// A category the person set to Block or Allow is decided here, by the setting, and no one is asked: no reviewer, no
	// question to the person. Ask (the default for every category) goes on to whoever decides.
	const action = actionFor(risk.kinds, word.thresholds);
	if (action === "block") {
		decide(frame, "deny", "classifier", `Blocked: ${why} is set to Block in the guard's settings.`);
		return refuse(blockedText(risk.kinds));
	}
	if (action === "allow") {
		decide(frame, "allow", "classifier", `Allowed: ${why} is set to Allow in the guard's settings.`);
		return undefined;
	}

	if (word.mode === "ask") {
		if (!ctx.hasUI || subagent) {
			decide(frame, "deny", "guard", "Ask me is on, and a subagent has no one to ask.");
			return refuse(
				`This call is high-risk (${why}) and Settings › Safety says the person approves such calls, but a subagent has no one to ask (only the main agent's calls wait for the person's answer). It was not run. Do not look for another way to do it: name the exact command in your final answer, so that the main agent can have the person confirm it.`,
			);
		}
		return askPerson(frame);
	}

	// A call the reviewer has turned down is not put to it again: another sample of the same question is not an appeal.
	// One process is one conversation, its subagents included: the key names no session, so a subagent (a new session each time) is no new chance either.
	// The person can overrule it, as they can a fresh denial. And once they have said something since the denial (a message
	// of their own, which a subagent never has), the reviewer is asked again and reads it: their explicit approval in chat is
	// what the denial told the agent to wait for (#751).
	const key = `${event.toolName}|${textOf(event.input)}|${word.reviewers.join(",")}`;
	const before = remembered(key);
	if (before && personSpokeAt(branch) <= before.at) {
		const model = before.model || "the reviewer";
		if (overrule) return askPerson(frame, { model: before.model }, { model, reason: before.reason });
		decide(frame, "deny", "reviewer", `${before.reason} (the same call was denied before)`, { model: before.model });
		return refuse(deniedText(model, before.reason, risk.kinds, subagent));
	}

	const settings = await ompSettings(pi);
	const models = ctx.models;
	const chosen = models
		? chooseReviewers({ configured: word.reviewers, chain: settings.chain, agent: ctx.model }, models)
		: { models: [] as ModelLike[], missing: [...word.reviewers] };
	const prompt = reviewPrompt(
		{
			tool: event.toolName,
			kinds: risk.kinds,
			detail: risk.detail,
			cwd: ctx.cwd,
			intent: frame.intent,
			agent: { subagent, name: agentName(ctx, subagent) },
			turns: recentTurns(branch),
		},
		word.policy,
	);
	// Inside omp's own limit for this handler, with a margin for what comes after (writing the record, the answer).
	const budgetMs = Math.min(90_000, Math.max(5_000, settings.handlerMs - 5_000));
	const outcome = await review(chosen.models, chosen.missing, prompt, askWith(ctx), {
		attemptMs: Math.min(30_000, budgetMs),
		budgetMs,
	});
	recordSpend(session, outcome.attempts);
	const extra = {
		model: outcome.model,
		tried: outcome.tried,
		usage: outcome.usage.requests > 0 ? outcome.usage : undefined,
	};

	if (outcome.verdict === "allow") {
		decide(frame, "allow", "reviewer", outcome.reason || "The reviewer allowed it.", extra);
		return undefined;
	}
	if (outcome.verdict === "deny") {
		const model = outcome.model ?? "the reviewer";
		rememberDenial(key, outcome.model ?? "", outcome.reason);
		// The person, who can see the question, has the last word: the reviewer's verdict and reason are put to them (#747).
		if (overrule) return askPerson(frame, extra, { model, reason: outcome.reason });
		decide(frame, "deny", "reviewer", outcome.reason, extra);
		return refuse(deniedText(model, outcome.reason, risk.kinds, subagent));
	}
	// No reviewer could be reached. The main agent, with a page open and the person's say-so (the setting), asks the person;
	// otherwise the call is refused, and said to be so for want of a reviewer, not for what it is.
	if (askable && word.askWhenUnavailable) return askPerson(frame, extra, undefined, { reason: outcome.reason });
	decide(frame, "unavailable", "guard", outcome.reason || GUARD_UNAVAILABLE, extra);
	return refuse(unavailableText(outcome.reason, risk.kinds, subagent));
}

export default function remoteRiskGate(pi: Pi): void {
	const overlay = overlayFile(process.argv);
	pi.on("tool_call", async (event, ctx) => {
		const state = readState(overlay);
		if (!state.armed && state.guard.mode === "off") return undefined;
		const risk = classifyToolCall(
			event.toolName,
			event.input,
			contextFor(ctx.cwd, state.protect, state.ports, state.hosts),
		);
		if (risk === null) return undefined;
		return state.armed ? confirmWithPerson(event, ctx, risk) : guardCall(pi, event, ctx, risk, state.guard);
	});
	// Said last, once the handler is in: the server covers a process with this note, and not on the strength of its command line (omp carries on without an extension it could not load).
	if (overlay === null) return;
	try {
		writeFileSync(`${overlay}${RISK_LOADED_SUFFIX}`, String(process.pid), { mode: 0o600 });
	} catch {
		// No note: the server takes the process for one without the gate, and refuses a remote page's turn while the setting is on.
	}
}
