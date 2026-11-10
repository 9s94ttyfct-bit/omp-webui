/**
 * The Cloudflare Access sign-ins of the saved computers (the Macs list), as the macOS app hands them over (`POST
 * /api/macs/<id>/sign-in`): the `CF_Authorization` token it holds in that computer's own web data store, which is what lets
 * this server reach the computer's page through its tunnel for `remote_run` (see `shared/remote-run.ts`).
 *
 * Kept in this process's memory only, per computer, until the token's own expiry (its `exp`): never written to a file, never
 * logged, never sent to a page (a page is told `signedInUntil`, a date), and never put in a tool's arguments or results. A
 * server that restarts holds none until the app hands them over again. The token's signature is not checked here: the remote
 * computer's Access and server check it, and a token they refuse is a sign-in that has lapsed (`RemoteNotSignedIn`).
 */

/** A token that cannot be kept: not a JWT, no expiry, or already past it. Answered with 400; nothing is kept. */
export class RemoteSignInError extends Error {
	readonly status = 400;
}

interface Kept {
	jwt: string;
	/** When it lapses, epoch ms. */
	expiresMs: number;
}

/** A JWT's three base64url parts: no padding, no other characters. */
const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

/** The longest token taken: an Access token is a few KB; anything far beyond is not one. */
const JWT_MAX = 16 * 1024;

/** When the token lapses (its `exp`, epoch ms), or why it cannot be kept. */
function expiryOf(jwt: string): number {
	if (jwt.length > JWT_MAX || !JWT_SHAPE.test(jwt)) throw new RemoteSignInError("The sign-in is not a token");
	let payload: unknown;
	try {
		payload = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8"));
	} catch {
		throw new RemoteSignInError("The sign-in is not a token");
	}
	const exp = typeof payload === "object" && payload !== null && "exp" in payload ? payload.exp : undefined;
	if (typeof exp !== "number" || !Number.isFinite(exp)) throw new RemoteSignInError("The sign-in has no expiry");
	return exp * 1000;
}

/** The sign-ins, by the computer's id in the Macs list (compared without case, as the list compares them). */
export class RemoteSignIns {
	private readonly kept = new Map<string, Kept>();

	constructor(private readonly now: () => number = Date.now) {}

	/** Keep `jwt` for the computer `macId`, in place of what was kept; throws `RemoteSignInError` for one that cannot be. */
	set(macId: string, jwt: string): { expires: string } {
		const expiresMs = expiryOf(jwt);
		if (expiresMs <= this.now()) throw new RemoteSignInError("The sign-in has lapsed");
		this.kept.set(macId.toLowerCase(), { jwt, expiresMs });
		return { expires: new Date(expiresMs).toISOString() };
	}

	/** Forget the computer's sign-in (the app has none any more, or the computer left the list). */
	clear(macId: string): void {
		this.kept.delete(macId.toLowerCase());
	}

	/** The computer's sign-in while it holds; null when there is none or it has lapsed (and is then forgotten). */
	get(macId: string): { jwt: string; expires: string } | null {
		const key = macId.toLowerCase();
		const kept = this.kept.get(key);
		if (!kept) return null;
		if (kept.expiresMs <= this.now()) {
			this.kept.delete(key);
			return null;
		}
		return { jwt: kept.jwt, expires: new Date(kept.expiresMs).toISOString() };
	}

	/** Until when the computer is signed in (ISO 8601), for a page; null when it is not. Never the token. */
	signedInUntil(macId: string): string | null {
		return this.get(macId)?.expires ?? null;
	}
}
