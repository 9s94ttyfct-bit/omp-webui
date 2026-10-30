import { isRecord } from "./guards.ts";
import { parseRemoteConfigPatch, type RemoteConfig, RemoteConfigError } from "./remote.ts";

/**
 * The file Settings › Remote access exports and imports (#628): what a second Mac needs of the first one's remote access
 * to be set up with only its own hostname. One Cloudflare Access application with a wildcard domain (`*.example.com`)
 * serves every Mac under it, so they share the team, the AUD tag and the allowed e-mail addresses; the hostname is each
 * Mac's own and is not in the file.
 *
 * Only those three settings are in it, and only those three are read back. Nothing that opens the tunnel or this Mac is:
 * not the tunnel's id or name, not `cloudflared`'s credentials (they stay in `~/.cloudflared`), not the access token, not
 * the switches (`enabled`, `autostart`, `confirmRisky`), and not the hostname. A file that carries more is read for its
 * three settings and the rest is ignored, never applied.
 */

/** What identifies the file as this one. */
export const REMOTE_ACCESS_FILE_KIND = "omp-webui-remote-access";
/** The file's format; a file of another is refused, not guessed at. */
export const REMOTE_ACCESS_FILE_VERSION = 1;
/** The name the file is saved under. */
export const REMOTE_ACCESS_FILE_NAME = "omp-webui-remote-access.json";
/** The largest file read: it holds a team, a tag and some addresses. */
export const REMOTE_ACCESS_FILE_MAX_BYTES = 64 * 1024;
/** The most addresses one file may carry. */
export const REMOTE_ACCESS_FILE_MAX_EMAILS = 200;

/** The three settings a Mac gets from another. */
export type SharedRemoteAccess = Pick<RemoteConfig, "team" | "aud" | "emails">;

/** The file as it is written. */
export interface RemoteAccessFile extends SharedRemoteAccess {
	kind: typeof REMOTE_ACCESS_FILE_KIND;
	version: typeof REMOTE_ACCESS_FILE_VERSION;
}

/** The text of the file for these settings: indented JSON with a line break at the end. */
export function remoteAccessFileText(config: SharedRemoteAccess): string {
	const file: RemoteAccessFile = {
		kind: REMOTE_ACCESS_FILE_KIND,
		version: REMOTE_ACCESS_FILE_VERSION,
		team: config.team,
		aud: config.aud,
		emails: [...config.emails],
	};
	return `${JSON.stringify(file, null, 2)}\n`;
}

/** Why a file cannot be used. `invalid` carries the setting's own message. */
export type RemoteAccessFileProblem =
	| "too-large"
	| "not-json"
	| "not-ours"
	| "version"
	| "empty"
	| "too-many"
	| "invalid";

export type RemoteAccessFileResult =
	| { ok: true; settings: SharedRemoteAccess }
	| { ok: false; problem: RemoteAccessFileProblem; message?: string };

/**
 * The settings in `text`, checked the way the server checks a change of them (`parseRemoteConfigPatch`): a team that is no
 * team, an AUD that is not 64 hexadecimal characters or an address that is none refuses the whole file. A file with
 * nothing in it to apply is refused too, so an import never reads as done when it did nothing.
 */
export function parseRemoteAccessFile(text: string): RemoteAccessFileResult {
	if (new TextEncoder().encode(text).length > REMOTE_ACCESS_FILE_MAX_BYTES) return { ok: false, problem: "too-large" };
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return { ok: false, problem: "not-json" };
	}
	if (!isRecord(raw) || raw.kind !== REMOTE_ACCESS_FILE_KIND) return { ok: false, problem: "not-ours" };
	if (raw.version !== REMOTE_ACCESS_FILE_VERSION) return { ok: false, problem: "version" };
	if (Array.isArray(raw.emails) && raw.emails.length > REMOTE_ACCESS_FILE_MAX_EMAILS)
		return { ok: false, problem: "too-many" };
	// Only the three settings are handed on: any other key of the file never reaches the check, let alone the card.
	const { team, aud, emails } = raw;
	try {
		const checked = parseRemoteConfigPatch({
			...(team === undefined ? {} : { team }),
			...(aud === undefined ? {} : { aud }),
			...(emails === undefined ? {} : { emails }),
		});
		const settings: SharedRemoteAccess = {
			team: checked.team ?? "",
			aud: checked.aud ?? "",
			emails: checked.emails ?? [],
		};
		if (settings.team === "" && settings.aud === "" && settings.emails.length === 0)
			return { ok: false, problem: "empty" };
		return { ok: true, settings };
	} catch (e) {
		if (e instanceof RemoteConfigError) return { ok: false, problem: "invalid", message: e.message };
		throw e;
	}
}
