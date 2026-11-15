import type { LiveInfo } from "@shared/protocol.ts";

/** How Settings › Accounts starts its omp: no conversation, in the home folder. */
export const HELPER_ARGS = ["--no-session"];

/**
 * Whether a process is the Accounts section's helper rather than a conversation: Settings names it so, and what it asks
 * (a provider's API key, an authorization code) is answered in the Accounts section, not in a conversation.
 */
export function isAccountsHelper(info: LiveInfo, home: string | undefined): boolean {
	return info.sessionFile === null && info.cwd === home && HELPER_ARGS.every((a) => info.args.includes(a));
}
