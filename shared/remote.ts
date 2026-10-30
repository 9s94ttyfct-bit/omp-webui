import { isRecord } from "./guards.ts";
import type { RemoteAiState } from "./remote-ai.ts";
import { DEFAULT_FILE_TRANSFER, type FileTransfer, isFileTransfer } from "./transfer.ts";

/**
 * Remote access through a Cloudflare tunnel: the settings of it, and what the tunnel is doing.
 *
 * The server owns the settings (`<data dir>/remote.json`) and the tunnel; the page shows them and asks for
 * changes. What the tunnel needs of the person (the hostname, the Cloudflare team, the AUD of the Access
 * application and the email addresses allowed through it) is here, so that both sides speak of it the same way.
 */

/** The settings of the remote access, as `<data dir>/remote.json` holds them. */
export interface RemoteConfig {
	/** Whether the person wants remote access at all. On its own it is not enough: see `isRemoteOn`. */
	enabled: boolean;
	/** The public hostname, e.g. `omp.example.com`. */
	hostname: string;
	/** The Cloudflare team (the first part of the Access domain, `<team>.cloudflareaccess.com`). */
	team: string;
	/** The AUD of the Access application: 64 hexadecimal characters. */
	aud: string;
	/** The email addresses allowed through Access (compared case-insensitively). */
	emails: string[];
	/** The id of the tunnel, once the server has created one. Never set by a page. */
	tunnelId?: string;
	/** The name the tunnel was created with. Never set by a page. */
	tunnelName?: string;
	/** Start the tunnel when the server starts. */
	autostart: boolean;
	/**
	 * Ask the person on the page before a high-risk tool call runs in a turn that a remote page drives (see
	 * `shared/remote-risk.ts`). Off unless set; like the other settings it is changed from this computer only.
	 */
	confirmRisky: boolean;
	/**
	 * What a page that is not on this computer may do with the files of a conversation's folder: nothing, download only,
	 * or download and upload (see `shared/transfer.ts`). Absent means `DEFAULT_FILE_TRANSFER` (uploads are on unless turned
	 * off); `parseRemoteConfig` always fills it in. Changed from this computer only.
	 */
	fileTransfer?: FileTransfer;
	/**
	 * Whether a page that is not on this computer may open a shell in the panel's Terminal tab (a login shell in the
	 * conversation's folder): whoever is let through the tunnel then has a shell on this computer, which the guard does
	 * not see. On unless turned off; turning it off also ends the shells remote pages have open. Changed from this
	 * computer only.
	 */
	remoteShell: boolean;
}

/** What the tunnel is doing. */
export type RemoteState = "off" | "starting" | "connected" | "error";

/** The state of the tunnel, and what it said about it. */
export interface RemoteStatus {
	state: RemoteState;
	/** What the tunnel said, or why it is not running, or what it is doing now. Absent when there is nothing to say. */
	message?: string;
}

/** What `GET /api/remote` answers: the settings, the state of the tunnel, and what it needs from this machine. */
export interface RemoteSnapshot {
	config: RemoteConfig;
	status: RemoteStatus;
	/** Whether `cloudflared` is installed. */
	installed: boolean;
	/** Whether this machine has logged in to Cloudflare (`~/.cloudflared/cert.pem` is there). */
	loggedIn: boolean;
	/** The public URL of the tunnel; empty when no hostname is set. */
	url: string;
	/**
	 * The URL the browser has to visit to finish the Cloudflare login that is under way; absent when none is. It is a
	 * one-time authorisation link: the card shows it, and it is never put into the words of the AI that helps with the set-up.
	 */
	loginUrl?: string;
	/** The opt-in to let the AI help with the set-up. */
	ai: RemoteAiState;
}

/** The answer of `POST /api/remote/login`: the snapshot, and the URL the browser has to visit to log in. */
export interface RemoteLogin extends RemoteSnapshot {
	loginUrl: string;
}

/** The settings a fresh install has: no remote access, no confirmation of risky commands, and file transfer in both directions. */
export const DEFAULT_REMOTE_CONFIG: RemoteConfig = {
	enabled: false,
	hostname: "",
	team: "",
	aud: "",
	emails: [],
	autostart: false,
	confirmRisky: false,
	fileTransfer: DEFAULT_FILE_TRANSFER,
	remoteShell: true,
};

/** What the server answers a remote page's request for a shell while Settings › Remote access has them off: the page says so in its words. */
export const REMOTE_SHELL_OFF = "Shells are off for remote pages (Settings › Remote access, on the computer itself)";

/**
 * Whether remote access is on. It is off unless the person turned it on *and* everything the tunnel needs is
 * there: a half-filled setting is not a way in.
 */
export function isRemoteOn(config: RemoteConfig): boolean {
	return config.enabled && missingRemoteSettings(config).length === 0;
}

/** What the settings still lack before remote access can work, by the name the page shows (empty when nothing). */
export function missingRemoteSettings(config: RemoteConfig): ("hostname" | "team" | "aud" | "emails")[] {
	const missing: ("hostname" | "team" | "aud" | "emails")[] = [];
	if (config.hostname === "") missing.push("hostname");
	if (config.team === "") missing.push("team");
	if (config.aud === "") missing.push("aud");
	if (config.emails.length === 0) missing.push("emails");
	return missing;
}

/** The public URL of the tunnel, or an empty string when no hostname is set. */
export function remoteUrl(hostname: string): string {
	return hostname === "" ? "" : `https://${hostname}`;
}

/** A change of the settings that is not acceptable: the whole change is refused, nothing is applied. */
export class RemoteConfigError extends Error {}

/** A DNS name: labels of letters, digits and dashes (not at either end), at least two of them. */
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
/** The team is the first part of the Access domain: letters, digits and dashes. */
const TEAM = /^[a-z0-9-]{1,63}$/;
/** The AUD of an Access application: 64 hexadecimal characters. */
const AUD = /^[0-9a-f]{64}$/;
/** An email address, as far as the allow-list needs one: printable ASCII around one `@`, a dot in the domain. */
const EMAIL = /^[\x21-\x3f\x41-\x7e]+@[\x21-\x3f\x41-\x7e]+\.[\x21-\x3f\x41-\x7e]+$/;
/** A tunnel's id: a UUID, which is what ends up in a command line and in a configuration file. */
const TUNNEL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A tunnel's name. */
const TUNNEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

/**
 * Lower-case the letters A–Z and nothing else. Unicode lower-casing would turn a Kelvin sign into a `k`, and a dotted
 * capital I into two characters: two spellings that are not the same address must not become the same one (or one
 * that the other side, which compares ASCII, does not know).
 */
export const asciiLower = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

function booleanOf(value: unknown, name: string): boolean {
	if (typeof value !== "boolean") throw new RemoteConfigError(`${name} must be true or false`);
	return value;
}

function hostnameOf(value: unknown): string {
	if (typeof value !== "string") throw new RemoteConfigError("hostname must be a string");
	const host = asciiLower(value.trim());
	if (host === "") return "";
	const labels = host.split(".");
	// The last label is the top-level domain: never all digits, which is what makes `1.2.3.4` an address, not a name.
	const ok =
		host.length <= 253 && labels.length >= 2 && labels.every((l) => LABEL.test(l)) && /[a-z]/.test(labels.at(-1) ?? "");
	if (!ok) throw new RemoteConfigError(`hostname is not a domain name: ${value}`);
	return host;
}

function teamOf(value: unknown): string {
	if (typeof value !== "string") throw new RemoteConfigError("team must be a string");
	const team = asciiLower(value.trim());
	if (team === "") return "";
	if (!TEAM.test(team)) throw new RemoteConfigError(`team is not a Cloudflare team name: ${value}`);
	return team;
}

function audOf(value: unknown): string {
	if (typeof value !== "string") throw new RemoteConfigError("aud must be a string");
	const aud = asciiLower(value.trim());
	if (aud === "") return "";
	if (!AUD.test(aud)) throw new RemoteConfigError("aud must be 64 hexadecimal characters");
	return aud;
}

function emailsOf(value: unknown): string[] {
	if (!Array.isArray(value)) throw new RemoteConfigError("emails must be a list");
	const emails: string[] = [];
	for (const entry of value) {
		if (typeof entry !== "string") throw new RemoteConfigError("emails must be a list of email addresses");
		const email = asciiLower(entry.trim());
		if (email === "") continue;
		if (email.length > 254 || !EMAIL.test(email)) throw new RemoteConfigError(`not an email address: ${entry}`);
		if (!emails.includes(email)) emails.push(email);
	}
	return emails;
}

function fileTransferOf(value: unknown): FileTransfer {
	if (!isFileTransfer(value)) throw new RemoteConfigError('fileTransfer must be "off", "download" or "full"');
	return value;
}

/**
 * Check a change of the settings a page may make and return what it says, in the shape the settings hold. A key that
 * is not one of those settings is ignored (`tunnelId` and `tunnelName` are the server's: a page cannot point the
 * server at another tunnel); a key that is one of them is checked, and a value that does not fit is refused.
 */
export function parseRemoteConfigPatch(patch: unknown): Partial<RemoteConfig> {
	if (!isRecord(patch)) throw new RemoteConfigError("The settings must be an object");
	const out: Partial<RemoteConfig> = {};
	if ("enabled" in patch) out.enabled = booleanOf(patch.enabled, "enabled");
	if ("autostart" in patch) out.autostart = booleanOf(patch.autostart, "autostart");
	if ("confirmRisky" in patch) out.confirmRisky = booleanOf(patch.confirmRisky, "confirmRisky");
	if ("remoteShell" in patch) out.remoteShell = booleanOf(patch.remoteShell, "remoteShell");
	if ("fileTransfer" in patch) out.fileTransfer = fileTransferOf(patch.fileTransfer);
	if ("hostname" in patch) out.hostname = hostnameOf(patch.hostname);
	if ("team" in patch) out.team = teamOf(patch.team);
	if ("aud" in patch) out.aud = audOf(patch.aud);
	if ("emails" in patch) out.emails = emailsOf(patch.emails);
	return out;
}

/**
 * The settings as `remote.json` holds them: every field checked like a change is, the ones the file lacks taken from
 * `DEFAULT_REMOTE_CONFIG`. Throws `RemoteConfigError` for a file that is not settings, or holds a field that does not
 * fit: a file nobody can trust is not half-read, remote access stays off.
 */
export function parseRemoteConfig(raw: unknown): RemoteConfig {
	const config: RemoteConfig = { ...DEFAULT_REMOTE_CONFIG, ...parseRemoteConfigPatch(raw) };
	const stored = raw as Record<string, unknown>;
	if (stored.tunnelId !== undefined) {
		if (typeof stored.tunnelId !== "string" || !TUNNEL_ID.test(stored.tunnelId))
			throw new RemoteConfigError("tunnelId is not a tunnel id");
		config.tunnelId = stored.tunnelId;
	}
	if (stored.tunnelName !== undefined) {
		if (typeof stored.tunnelName !== "string" || !TUNNEL_NAME.test(stored.tunnelName))
			throw new RemoteConfigError("tunnelName is not a tunnel name");
		config.tunnelName = stored.tunnelName;
	}
	return config;
}

/** Whether `id` is what a tunnel's id looks like (what `cloudflared tunnel create` printed is checked with it). */
export const isTunnelId = (id: string): boolean => TUNNEL_ID.test(id);

/** Whether `name` is a name a tunnel can be created with. */
export const isTunnelName = (name: string): boolean => TUNNEL_NAME.test(name);

/**
 * `text` with every web address in it replaced by `[link]`. What a program printed may hold an address that is a one-time
 * authorisation (the Cloudflare sign-in link, which carries the callback): it is for the person, who is shown it on the
 * card, and must not end up in anything the AI is told (kept in the conversation's file, shown on pages, exported).
 * A cut address is caught too (`https://dash.cloudflare.com/arg…`): everything up to the next space goes.
 */
export const withoutLinks = (text: string): string => text.replace(/\bhttps?:\/\/\S*/gi, "[link]");
