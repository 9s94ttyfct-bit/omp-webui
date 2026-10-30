import { CodedError, type ErrorCode, type ErrorParams } from "../../shared/error-info.ts";
import { isRecord } from "../../shared/guards.ts";
import { BACKEND_NAMES, type Backend } from "../../shared/offline.ts";

/**
 * A failure the user can act on: the message says what happened and what to do, in English; the page words it from
 * its `code` and `params` (`shared/error-info.ts`).
 */
export class OfflineError extends CodedError {}

/** A backend's provider, as the offline models.yml writes it. */
export interface BackendProvider {
	baseUrl: string;
	/** `apiKey` as written: the name of an environment variable, or the key itself. */
	apiKey: string | null;
	/** The user's entry has credentials that are not sent to this address (see `offlineModels`). */
	keyWithheld?: boolean;
}

const CHECK_MS = 4000;

/** The token omp sends for `apiKey`: the named environment variable when it is set, else the literal. */
export function resolveApiKey(
	value: string | null,
	env: Record<string, string | undefined> = process.env,
): { key: string | null; unresolved: boolean } {
	if (!value) return { key: null, unresolved: false };
	// A `!command` key is run by omp when it needs it; asking the backend for its models does not.
	if (value.startsWith("!")) return { key: null, unresolved: true };
	return { key: env[value] || value, unresolved: false };
}

/** The address to show (in messages, in Settings): without credentials, query or fragment, which may carry a secret. */
export function shown(baseUrl: string): string {
	try {
		const u = new URL(baseUrl);
		u.username = "";
		u.password = "";
		u.search = "";
		u.hash = "";
		return u.toString().replace(/\/$/, "");
	} catch {
		return baseUrl;
	}
}

/** The `code` of a system error (`ECONNREFUSED`), on the error or the one that caused it. */
function errorCode(e: unknown): string | undefined {
	if (typeof e !== "object" || e === null) return undefined;
	if ("code" in e && typeof e.code === "string") return e.code;
	return "cause" in e ? errorCode(e.cause) : undefined;
}

/** Why a backend did not answer: in words, and as the code and parameters the page words it from. */
function reason(e: unknown): { text: string; code: ErrorCode; params: ErrorParams } {
	if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
		const seconds = CHECK_MS / 1000;
		return { text: `no answer within ${seconds} s`, code: "offlineUnreachableTimeout", params: { seconds } };
	}
	const code = errorCode(e);
	if (code === "ECONNREFUSED") return { text: "connection refused", code: "offlineUnreachableRefused", params: {} };
	const text = code ?? (e instanceof Error ? e.message : "unknown error");
	return { text, code: "offlineUnreachableOther", params: { reason: text } };
}

/** The model ids in an OpenAI-compatible `GET /models` answer; null when it is not one. */
async function openAiModels(res: Response): Promise<string[] | null> {
	if (!res.ok) return null;
	const body: unknown = await res.json().catch(() => null);
	if (!isRecord(body) || !Array.isArray(body.data)) return null;
	return body.data.flatMap((m) => (isRecord(m) && typeof m.id === "string" ? [m.id] : []));
}

/**
 * Ollama's own list (`GET /api/tags`, at the server's root whatever path `baseUrl` has): where omp discovers
 * Ollama's models, and an answer for a `baseUrl` given without `/v1`. Null when it does not answer with one.
 */
async function ollamaTags(baseUrl: string, headers: Record<string, string>): Promise<string[] | null> {
	try {
		const res = await fetch(`${new URL(baseUrl).origin}/api/tags`, { headers, signal: AbortSignal.timeout(CHECK_MS) });
		if (!res.ok) return null;
		const body: unknown = await res.json();
		if (!isRecord(body) || !Array.isArray(body.models)) return null;
		return body.models.flatMap((m) => {
			const id = isRecord(m) ? (m.model ?? m.name) : undefined;
			return typeof id === "string" ? [id] : [];
		});
	} catch {
		return null;
	}
}

/**
 * Ask a backend which models it serves (`GET <baseUrl>/models`, which all three answer in OpenAI's format; Ollama's
 * own `/api/tags` when it does not). Throws an `OfflineError` when it cannot be reached or refuses the key. Null: it
 * answered, but not with a model list this can read, or the key is one only omp can resolve (a `!command`) and the
 * backend wants it.
 */
export async function queryBackend(
	backend: Backend,
	provider: BackendProvider,
	env: Record<string, string | undefined> = process.env,
): Promise<string[] | null> {
	const name = BACKEND_NAMES[backend];
	const { key, unresolved } = resolveApiKey(provider.apiKey, env);
	const headers: Record<string, string> = key ? { authorization: `Bearer ${key}` } : {};
	let res: Response;
	try {
		res = await fetch(`${provider.baseUrl.replace(/\/+$/, "")}/models`, {
			headers,
			signal: AbortSignal.timeout(CHECK_MS),
		});
	} catch (e) {
		const why = reason(e);
		const url = shown(provider.baseUrl);
		throw new OfflineError(
			`${name} is not reachable at ${url} (${why.text}). Start the ${name} server, or switch to Full, or to Light with your own models.`,
			why.code,
			{ backend, url, ...why.params },
		);
	}
	if (res.status === 401 || res.status === 403) {
		if (unresolved) return null;
		const url = shown(provider.baseUrl);
		if (provider.keyWithheld)
			throw new OfflineError(
				`${name} at ${url} wants an API key (HTTP ${res.status}), and the one in models.yml is not sent there: this address is neither on this machine or its network nor the one models.yml gives the ${backend} provider. Put the address in that provider, or use a local one.`,
				"offlineKeyWithheld",
				{ backend, url, status: res.status },
			);
		throw new OfflineError(
			`${name} at ${url} refused its API key (HTTP ${res.status}). Check apiKey of the ${backend} provider in models.yml.`,
			"offlineKeyRefused",
			{ backend, url, status: res.status },
		);
	}
	const models = await openAiModels(res);
	if (models === null && backend === "ollama") return ollamaTags(provider.baseUrl, headers);
	return models;
}
