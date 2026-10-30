import { asciiLower } from "./remote.ts";

/**
 * The other Macs this one knows (#628, built on #614's list): the name a person gave each and the address its omp-webui is
 * served at through Cloudflare Access. The server keeps the list (`server/saved-macs.ts`, `<data dir>/remote-macs.json`), the
 * pages read it (`/api/meta`) for the sidebar's machine switcher, the macOS app's Macs menu reads and writes the same one, and
 * only a page on this computer changes it (`/api/macs*` is a local-only route).
 *
 * There is no secret in it: a Mac's sign-in lives in the app's own per-Mac web data store, never in this list.
 *
 * The rules for a name and an address are the macOS app's (`macos/remotemacs.swift`: `parseRemoteName`, `parseRemoteAddress`),
 * written again here: the app reads a file this server writes and the other way round, so what one accepts the other must too
 * (`tests/support/mac-vectors.json` holds the cases both are held to).
 */

/** The most Macs a list holds. */
export const MAC_LIMIT = 10;
/** The longest name, in characters as a person counts them. */
export const MAC_NAME_LIMIT = 60;

/** A saved Mac as any page sees it: what the switcher shows and opens, and nothing the app keeps for its own use. */
export interface SavedMac {
	id: string;
	name: string;
	/** The address's host (`omp.example.com`): a public DNS name, lower case; its page is `https://<host>/`. */
	host: string;
	/** When the macOS app last had a window of this Mac signed in (ISO 8601, UTC, whole seconds); null until it has. */
	lastConnected: string | null;
}

/** A Mac as the list holds it (`remote-macs.json`): what the macOS app needs besides what a page sees. */
export interface MacRecord extends SavedMac {
	/** The Cloudflare team this Mac's sign-in belongs to, kept the first time it is seen; null until known. */
	team: string | null;
	/** The app's web data store for this Mac (its cookies and sign-in): an identifier, not a credential. */
	storeId: string;
	added: string;
}

/** The part of a record that a page may see. */
export function savedMacOf(record: MacRecord): SavedMac {
	return { id: record.id, name: record.name, host: record.host, lastConnected: record.lastConnected };
}

/** Why a typed address cannot be a Mac's. */
export type AddressProblem =
	| "empty"
	| "not-https"
	| "user-info"
	| "port"
	| "path"
	| "ip-address"
	| "trailing-dot"
	| "not-ascii"
	| "local-name"
	| "access-domain"
	| "not-domain-name";

/** Why a typed name cannot be a Mac's. */
export type NameProblem = "empty" | "too-long" | "characters" | "taken";

/** What is wrong with a change of the list. `taken` names the Mac that has the name or the address already. */
export type MacProblem =
	| { kind: "name"; code: NameProblem; taken?: string }
	| { kind: "address"; code: AddressProblem }
	| { kind: "host-taken"; name: string }
	| { kind: "full" };

/** The words for a problem, in English: the server's error text, and what a page shows when it has none of its own. */
export function describeMacProblem(problem: MacProblem): string {
	switch (problem.kind) {
		case "full":
			return `At most ${MAC_LIMIT} Macs can be saved`;
		case "host-taken":
			return `That address is saved already, as “${problem.name}”`;
		case "name":
			if (problem.code === "empty") return "Give the Mac a name";
			if (problem.code === "too-long") return `A name is at most ${MAC_NAME_LIMIT} characters`;
			if (problem.code === "characters") return "A name cannot hold control or invisible characters";
			return `Another Mac is called “${problem.taken ?? ""}” already`;
		case "address":
			return ADDRESS_WORDS[problem.code];
	}
}

const ADDRESS_WORDS: Record<AddressProblem, string> = {
	empty: "Enter the Mac's address, such as omp.example.com",
	"not-https": "The address must be https (or have no scheme at all)",
	"user-info": "The address must not hold a user name or a password",
	port: "The address must not have a port: the tunnel answers on 443",
	path: "The address is a host name only, with no path",
	"ip-address": "An IP address is not a Mac's address: use its public host name",
	"trailing-dot": "The address must not end with a dot",
	"not-ascii": "Write an international name in its xn-- form",
	"local-name": "A name only a private network knows (localhost, .local, .lan…) cannot be reached through the tunnel",
	"access-domain": "That is Cloudflare Access's own sign-in address, not a Mac's: use the Mac's host name",
	"not-domain-name": "That is not a host name such as omp.example.com",
};

/** The last label of a name that only a private network knows. */
const PRIVATE_TOP_LEVELS = ["local", "localhost", "internal", "lan", "localdomain"];

const isLabel = (label: string): boolean => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label);

/** A last label a URL parser reads as a number, which makes the whole host an IPv4 address (WHATWG URL, "ends in a number"). */
const isNumericLabel = (label: string): boolean => /^[0-9]+$/.test(label) || /^0x[0-9a-f]*$/.test(label);

/**
 * The host of an address a person typed: `omp.example.com`, `https://omp.example.com` and `https://omp.example.com/` are the
 * same Mac. Only a public DNS name of the shape the server's own `hostname` setting takes is accepted: no port (the tunnel is
 * on 443), no user name, no path, no IP address, no private name, no trailing dot, and only ASCII.
 */
export function parseMacAddress(input: string): { ok: true; host: string } | { ok: false; problem: AddressProblem } {
	const bad = (problem: AddressProblem) => ({ ok: false as const, problem });
	let text = input.trim();
	if (text === "") return bad("empty");
	const marker = text.indexOf("://");
	if (marker >= 0) {
		if (text.slice(0, marker).toLowerCase() !== "https") return bad("not-https");
		text = text.slice(marker + 3);
	}
	const end = text.search(/[/?#]/);
	const authority = end < 0 ? text : text.slice(0, end);
	const rest = end < 0 ? "" : text.slice(end);
	if (rest !== "" && rest !== "/") return bad("path");
	if (authority === "") return bad("empty");
	if (authority.includes("@")) return bad("user-info");
	if (authority.startsWith("[")) return bad("ip-address");
	const colon = authority.indexOf(":");
	if (colon >= 0) {
		const after = authority.slice(colon + 1);
		return bad(after !== "" && /^[0-9]+$/.test(after) ? "port" : "not-domain-name");
	}
	if ([...authority].some((ch) => (ch.codePointAt(0) ?? 0) > 0x7f)) return bad("not-ascii");
	const host = asciiLower(authority);
	if (host.endsWith(".")) return bad("trailing-dot");
	const labels = host.split(".");
	const last = labels.at(-1) ?? "";
	if (isNumericLabel(last)) return bad("ip-address");
	if (PRIVATE_TOP_LEVELS.includes(last) || host.endsWith(".home.arpa")) return bad("local-name");
	if (host === "cloudflareaccess.com" || host.endsWith(".cloudflareaccess.com")) return bad("access-domain");
	if (host.length > 253 || labels.length < 2 || !labels.every(isLabel) || !/[a-z]/.test(last))
		return bad("not-domain-name");
	return { ok: true, host };
}

/** Control, format, line and paragraph separator, private-use, surrogate and unassigned characters: not in a name. */
const FORBIDDEN_IN_NAME = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cs}\p{Cn}]/u;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The name as it would be kept (trimmed), or why it is not one. Uniqueness is the list's to check. */
export function parseMacName(input: string): { ok: true; name: string } | { ok: false; problem: NameProblem } {
	const name = input.trim();
	if (name === "") return { ok: false, problem: "empty" };
	let count = 0;
	for (const _ of graphemes.segment(name)) if (++count > MAC_NAME_LIMIT) return { ok: false, problem: "too-long" };
	if (FORBIDDEN_IN_NAME.test(name)) return { ok: false, problem: "characters" };
	return { ok: true, name };
}

/**
 * What two names are compared by: case, accents, width and compatibility forms do not make a name another one, since the name is
 * what tells two Macs apart. One definition for the server and the macOS app (`foldedName` in macos/remotemacs.swift), held to
 * the same cases (`NAME_SAME` and `NAME_DIFFERENT` in tests/support/mac-vectors.ts):
 *
 * 1. NFKD (a width or a ligature becomes the letters it stands for; an accent becomes a mark after its letter),
 * 2. the marks (general category M) are dropped,
 * 3. lower case, then upper case, then lower case again: the full mappings of Unicode both ways, which make `ß`, `ẞ` and `ss`,
 *    and `σ` and `Σ`, the same letters (`toLowerCase` alone keeps `ß`),
 * 4. a final sigma `ς` is written `σ`: `toLowerCase` reads a sigma by its place in a word (`ΟΔΥΣΣΕΥΣ` ends in `ς`) and Swift's
 *    `lowercased()` does not, so neither is left to decide,
 * 5. NFC, so that what is left is written one way.
 */
export function foldMacName(name: string): string {
	return name
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.toUpperCase()
		.toLowerCase()
		.replace(/\u03c2/g, "\u03c3")
		.normalize("NFC");
}

/**
 * Whether a Mac with this name and address can join `macs`, and what it would be called and reached by. The order of the checks
 * is the order a person fixes them in: room, name, address, an address saved already. The server asks this before it writes and
 * the page before it asks the server, so the answer is the same on both sides.
 */
export function checkNewMac(
	macs: readonly { name: string; host: string }[],
	input: { name: string; address: string },
): { ok: true; name: string; host: string } | { ok: false; problem: MacProblem } {
	if (macs.length >= MAC_LIMIT) return { ok: false, problem: { kind: "full" } };
	const name = parseMacName(input.name);
	if (!name.ok) return { ok: false, problem: { kind: "name", code: name.problem } };
	const folded = foldMacName(name.name);
	const namesake = macs.find((m) => foldMacName(m.name) === folded);
	if (namesake) return { ok: false, problem: { kind: "name", code: "taken", taken: namesake.name } };
	const host = parseMacAddress(input.address);
	if (!host.ok) return { ok: false, problem: { kind: "address", code: host.problem } };
	const taken = macs.find((m) => m.host === host.host);
	if (taken) return { ok: false, problem: { kind: "host-taken", name: taken.name } };
	return { ok: true, name: name.name, host: host.host };
}

/** A Cloudflare team name as the server takes it (`shared/remote.ts`): letters, digits and dashes. */
export const isTeamName = (text: string): boolean => /^[a-z0-9-]{1,63}$/.test(text);

/** A UUID in either case (the app writes its identifiers in capitals, `crypto.randomUUID` in lower case). */
export const isMacId = (text: string): boolean =>
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text);

/** What a Mac's address is called in a link: the page of the Mac, `https://<host>/`. */
export const macUrl = (host: string): string => `https://${host}/`;

/** What `POST /api/macs` takes: a name and an address as typed, and the Cloudflare team the app found for it, if it did. */
export interface MacAdd {
	name: string;
	address: string;
	team?: string | null;
}

/** What the routes answer a writer: the record as the list holds it now. */
export interface MacAnswer {
	mac: MacRecord;
}
