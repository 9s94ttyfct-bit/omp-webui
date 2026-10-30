/**
 * AI-guided remote access set-up: the person lets one conversation's agent read and change the remote access settings
 * and guide them through the set-up (Settings › Remote access › "Set up with AI").
 *
 * The agent gets nine tools, served by the server over that conversation's own omp pipe (`set_host_tools`, see
 * `server/remote-ai.ts`). This file is what both sides must agree on: the tools' names, what a check of the public
 * address answers, and what the card shows of the opt-in.
 */

/** The tools, by the name omp lists them under. */
export const REMOTE_AI_TOOL = {
	guide: "remote_access_guide",
	status: "remote_access_status",
	check: "remote_access_check",
	install: "remote_access_install",
	login: "remote_access_login",
	save: "remote_access_save",
	setup: "remote_access_setup",
	start: "remote_access_start",
	stop: "remote_access_stop",
} as const;

export type RemoteAiTool = (typeof REMOTE_AI_TOOL)[keyof typeof REMOTE_AI_TOOL];

/** Every tool name, in the order the model is shown them. */
export const REMOTE_AI_TOOL_NAMES: readonly RemoteAiTool[] = Object.values(REMOTE_AI_TOOL);

/**
 * The tools that only read: omp does not ask the user to allow them whatever the permission mode (see
 * `ALWAYS_ALLOWED_TOOLS` in `server/omp/approval.ts`). The others change something on this Mac or in the settings and
 * go through omp's tool approval like any other tool of its own.
 */
export const REMOTE_AI_READ_ONLY: readonly RemoteAiTool[] = [
	REMOTE_AI_TOOL.guide,
	REMOTE_AI_TOOL.status,
	REMOTE_AI_TOOL.check,
];

/** The settings the agent may save: what the person would type into the card. Never `enabled` or `autostart`. */
export const REMOTE_AI_SETTINGS = ["hostname", "team", "aud", "emails"] as const;

/** What the card shows of the opt-in. */
export interface RemoteAiState {
	/** The switch "Let the AI help with remote access". Off until the person turns it on. */
	enabled: boolean;
	/** The conversations (their live ids) that hold the tools now: the ones started with "Set up with AI". */
	conversations: string[];
}

/** The opt-in of a fresh install, and of a server that does not offer it. */
export const NO_REMOTE_AI: RemoteAiState = { enabled: false, conversations: [] };

/** What a check of the public address found. */
export type RemoteCheckVerdict =
	/** The hostname answers and Cloudflare Access asks for a sign-in: the way in is as it should be. */
	| "ok"
	/** The hostname does not resolve. */
	| "dns"
	/** Cloudflare answers but the tunnel is not connected, or its DNS record points at a tunnel that is not there (1033, 1016). */
	| "tunnel-down"
	/** The tunnel is connected but nothing answers behind it (502, 521–523). */
	| "origin-down"
	/** The address reaches this app without Access asking for a sign-in: the Access application does not cover it. */
	| "no-access"
	/** The request did not complete (timeout, TLS, refused). */
	| "unreachable"
	/** Anything else. */
	| "other";

/** The answer of `POST /api/remote/check` and of the `remote_access_check` tool. */
export interface RemoteCheck {
	/** What was asked: `https://<hostname>/`. */
	url: string;
	verdict: RemoteCheckVerdict;
	/** The HTTP status that came back, when one did. */
	status?: number;
	/** What it means and what to do about it, in a sentence or two. */
	message: string;
}
