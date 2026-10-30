import { readFileSync, statSync } from "node:fs";
import { isRecord } from "../shared/guards.ts";
import { asciiLower, isRemoteOn, parseRemoteConfig, type RemoteConfig, RemoteConfigError } from "../shared/remote.ts";

/**
 * Remote access through Cloudflare Access: which requests that arrive on the public hostname are let in.
 *
 * A request is the person's own when it is addressed to the configured hostname (and, when it names an origin, to that
 * origin) and carries a Cloudflare Access JWT that this module verifies itself: RS256 against the team's published keys,
 * for this application (`aud`), from this team (`iss`), unexpired, and for an email on the allow-list. Nothing the
 * request says about itself is trusted before that: the header and the cookie are both the browser's to set.
 *
 * The settings are read from `remote.json` (see `parseSettings`); remote access is off unless they are complete and
 * `enabled`, and the file is read again whenever it changes.
 */

/** How far a token's `exp` and `nbf` may be off the server's clock, seconds. */
const SKEW_SECONDS = 60;
/** The keys are read again for a `kid` they do not hold, and at most this often however many requests ask. */
const REFRESH_MIN_MS = 60_000;
/** Keys older than this are read again (a key withdrawn since must not be trusted for ever). */
const KEYS_MAX_AGE_MS = 60 * 60_000;
const FETCH_TIMEOUT_MS = 5000;
const MAX_KEYS_BYTES = 1024 * 1024;
const MAX_TOKEN_CHARS = 16 * 1024;
/** The identities already logged are forgotten when they are this many. */
const MAX_LOGGED = 1000;

const RSA = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** An email as the allow-list knows one: printable ASCII, nothing else (no Unicode that case folding could map onto it). */
const ASCII_EMAIL = /^[\x21-\x7e]+$/;

/** Who a verified request is from, and until when its token is good (epoch ms: `exp` and the skew `verify` allows). */
export interface RemoteIdentity {
	email: string;
	validUntil: number;
}

export interface RemoteAuthOptions {
	/** Where the keys are read from; default `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`. */
	certsUrl?: string;
	now?: () => number;
	fetchTimeoutMs?: number;
	/** Where a first sight of an email or session is said; default the console. */
	log?: (line: string) => void;
}

/** The settings in `text`, or null when it is not valid JSON, remote access is not enabled, or anything it needs is missing. */
export function parseSettings(text: string): RemoteConfig | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	let config: RemoteConfig;
	try {
		config = parseRemoteConfig(raw);
	} catch (e) {
		// A file nobody can trust is not half-read: remote access stays off.
		if (e instanceof RemoteConfigError) return null;
		throw e;
	}
	return isRemoteOn(config) ? config : null;
}

function decodeJson(part: string): Record<string, unknown> | null {
	try {
		const value: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
		return isRecord(value) ? value : null;
	} catch {
		return null;
	}
}

/** What of the settings decides who is let in (see `RemoteAuth.onChange`); "" while remote access is off. */
function accessOf(s: RemoteConfig | null): string {
	return s === null ? "" : JSON.stringify([s.hostname, s.team, s.aud, s.emails]);
}

/** The Access tokens a request presents: the header Cloudflare adds, and each `CF_Authorization` cookie. */
function presented(req: Request): string[] {
	const tokens: string[] = [];
	const header = req.headers.get("cf-access-jwt-assertion");
	if (header) tokens.push(header.trim());
	for (const part of (req.headers.get("cookie") ?? "").split(";")) {
		const eq = part.indexOf("=");
		if (eq >= 0 && part.slice(0, eq).trim() === "CF_Authorization") tokens.push(part.slice(eq + 1).trim());
	}
	return tokens;
}

interface KeySet {
	url: string;
	keys: Map<string, CryptoKey>;
	/** When the keys were read; -Infinity before the first read. */
	fetchedAt: number;
	/** When the last read began (it failed or not); -Infinity before the first. */
	attemptedAt: number;
}

export class RemoteAuth {
	private settings: RemoteConfig | null = null;
	/** What the file looked like when `settings` was read from it: its modification time and size, "" when it is absent. */
	private stamp: string | null = null;
	private keySet: KeySet | null = null;
	private reading: Promise<void> | null = null;
	private readonly logged = new Set<string>();
	private readonly listeners = new Set<() => void>();
	private readonly now: () => number;
	private readonly timeoutMs: number;
	private readonly log: (line: string) => void;
	private readonly certsUrl: string | undefined;

	constructor(
		private readonly file: string,
		options: RemoteAuthOptions = {},
	) {
		this.now = options.now ?? Date.now;
		this.timeoutMs = options.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
		this.log = options.log ?? ((line) => console.log(line));
		this.certsUrl = options.certsUrl || undefined;
	}

	/** The settings in force, or null while remote access is off. Reads the file again when it has changed. */
	current(): RemoteConfig | null {
		let stamp = "";
		try {
			const stat = statSync(this.file);
			stamp = `${stat.mtimeMs}:${stat.size}`;
		} catch {
			// no file: off
		}
		if (stamp === this.stamp) return this.settings;
		this.stamp = stamp;
		let next: RemoteConfig | null = null;
		if (stamp) {
			try {
				next = parseSettings(readFileSync(this.file, "utf8"));
			} catch {
				// unreadable: off
			}
		}
		const changed = accessOf(next) !== accessOf(this.settings);
		this.settings = next;
		if (changed) for (const listener of this.listeners) listener();
		return next;
	}

	/**
	 * Called whenever who may come in changes: remote access turned on or off, another hostname, team, application or
	 * allow-list. A switch that is read where it applies (confirm risky commands, file transfer, shells) is not such a change.
	 */
	onChange(listener: () => void): void {
		this.listeners.add(listener);
	}

	/** Whether `host` (a Host header) is the public hostname, exactly: no port, no other name. False while remote access is off. */
	isPublicHost(host: string | null): boolean {
		const s = this.current();
		return s !== null && host !== null && asciiLower(host) === s.hostname;
	}

	/**
	 * Who `req` is from, if it is a remote request that may be served: addressed to the public hostname (and its origin,
	 * when it names one) and carrying a valid Access token. Null for anything else, including every request while
	 * remote access is off.
	 */
	async verify(req: Request): Promise<RemoteIdentity | null> {
		const s = this.current();
		if (!s || !this.isPublicHost(req.headers.get("host"))) return null;
		const origin = req.headers.get("origin");
		if (origin !== null && asciiLower(origin) !== `https://${s.hostname}`) return null;
		for (const token of presented(req)) {
			const claims = await this.check(token, s);
			if (!claims) continue;
			const key = `${claims.email}|${claims.iat}`;
			if (!this.logged.has(key)) {
				if (this.logged.size >= MAX_LOGGED) this.logged.clear();
				this.logged.add(key);
				this.log(`omp-webui: remote access by ${claims.email} (new session on ${s.hostname})`);
			}
			return { email: claims.email, validUntil: (claims.exp + SKEW_SECONDS) * 1000 };
		}
		return null;
	}

	private async check(token: string, s: RemoteConfig): Promise<{ email: string; iat: number; exp: number } | null> {
		if (token.length > MAX_TOKEN_CHARS) return null;
		const parts = token.split(".");
		if (parts.length !== 3 || !parts.every((p) => BASE64URL.test(p))) return null;
		const header = decodeJson(parts[0]);
		const claims = decodeJson(parts[1]);
		if (!header || !claims || header.alg !== "RS256" || typeof header.kid !== "string") return null;
		const key = await this.keyFor(header.kid, s);
		if (!key) return null;
		const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
		const valid = await crypto.subtle.verify(RSA, key, Buffer.from(parts[2], "base64url"), signed).catch(() => false);
		if (!valid) return null;

		const now = Math.floor(this.now() / 1000);
		const { exp, nbf, iss, aud, email, iat } = claims;
		// Good until `exp` and the skew, to the millisecond: the instant an open socket is ended at (`RemoteIdentity.validUntil`).
		if (typeof exp !== "number" || !Number.isFinite(exp) || this.now() >= (exp + SKEW_SECONDS) * 1000) return null;
		if (nbf !== undefined && (typeof nbf !== "number" || !Number.isFinite(nbf) || nbf - SKEW_SECONDS > now))
			return null;
		if (iss !== `https://${s.team}.cloudflareaccess.com`) return null;
		if (!(aud === s.aud || (Array.isArray(aud) && aud.includes(s.aud)))) return null;
		if (typeof email !== "string" || !ASCII_EMAIL.test(email) || !s.emails.includes(asciiLower(email))) return null;
		// As the token has it: the allow-list decides who is let in, not a spelling this module made up.
		return { email, iat: typeof iat === "number" ? iat : 0, exp };
	}

	/** The key `kid` names: from the keys held, else from the team's current ones, which are read at most once a minute. */
	private async keyFor(kid: string, s: RemoteConfig): Promise<CryptoKey | null> {
		const url = this.certsUrl ?? `https://${s.team}.cloudflareaccess.com/cdn-cgi/access/certs`;
		if (this.keySet?.url !== url) {
			this.keySet = {
				url,
				keys: new Map(),
				fetchedAt: Number.NEGATIVE_INFINITY,
				attemptedAt: Number.NEGATIVE_INFINITY,
			};
		}
		const set = this.keySet;
		const now = this.now();
		const known = set.keys.get(kid);
		if (known && now - set.fetchedAt <= KEYS_MAX_AGE_MS) return known;
		if (this.reading) {
			await this.reading;
		} else if (now - set.attemptedAt >= REFRESH_MIN_MS) {
			set.attemptedAt = now;
			this.reading = this.read(set).finally(() => {
				this.reading = null;
			});
			await this.reading;
		}
		// Whatever is held now, a key kept from before a read that failed included.
		return set.keys.get(kid) ?? null;
	}

	/** Replace the keys of `set` with the ones the team publishes; keep what is held if they cannot be had. */
	private async read(set: KeySet): Promise<void> {
		try {
			const res = await fetch(set.url, { signal: AbortSignal.timeout(this.timeoutMs) });
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const text = await res.text();
			if (text.length > MAX_KEYS_BYTES) throw new Error("the answer is too large");
			const body: unknown = JSON.parse(text);
			const listed = isRecord(body) ? body.keys : undefined;
			if (!Array.isArray(listed)) throw new Error("no keys in the answer");
			const keys = new Map<string, CryptoKey>();
			for (const jwk of listed) {
				if (!isRecord(jwk)) continue;
				const { kty, kid, n, e, alg } = jwk;
				if (kty !== "RSA" || typeof kid !== "string" || typeof n !== "string" || typeof e !== "string") continue;
				if (alg !== undefined && alg !== "RS256") continue;
				try {
					keys.set(
						kid,
						await crypto.subtle.importKey("jwk", { kty, n, e, alg: "RS256", ext: true }, RSA, false, ["verify"]),
					);
				} catch {
					// not a usable key: the others may be
				}
			}
			if (keys.size === 0) throw new Error("no usable key in the answer");
			set.keys = keys;
			set.fetchedAt = this.now();
		} catch (e) {
			console.warn(
				`omp-webui: remote access: the Cloudflare Access keys could not be read from ${set.url}: ${(e as Error).message}`,
			);
		}
	}
}
