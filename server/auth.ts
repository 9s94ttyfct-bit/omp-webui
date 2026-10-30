import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Per-install access token for the HTTP/WS API. The web UI can drive omp
 * (which runs tools on this machine), so loopback binding alone is not
 * enough: any local process or user could otherwise reach it.
 *
 * Accepted as an HttpOnly cookie (set by visiting `/?token=…` or POST
 * /api/auth) or an `x-omp-webui-token` header. `OMP_WEBUI_AUTH=off` disables it.
 */
export const COOKIE = "ompw_token";

export class Auth {
	readonly token: string | null;

	constructor(dataDir: string, env: Record<string, string | undefined> = process.env) {
		if (env.OMP_WEBUI_AUTH === "off") {
			this.token = null;
			return;
		}
		if (env.OMP_WEBUI_TOKEN) {
			this.token = env.OMP_WEBUI_TOKEN;
			return;
		}
		const file = join(dataDir, "token");
		// An empty or blank file (an interrupted first write, a file emptied by hand) holds no token.
		// It must never mean "no authentication": treat it as missing and generate a token.
		const stored = existsSync(file) ? readFileSync(file, "utf8").trim() : "";
		if (stored) {
			this.token = stored;
		} else {
			this.token = randomBytes(24).toString("base64url");
			writeFileSync(file, this.token, { mode: 0o600 });
		}
		chmodSync(file, 0o600);
	}

	get enabled(): boolean {
		return this.token !== null;
	}

	matches(candidate: string | null | undefined): boolean {
		// Only a disabled auth (`token === null`) lets everything in; a blank token fails closed.
		if (this.token === null) return true;
		if (!candidate) return false;
		const a = Buffer.from(candidate);
		const b = Buffer.from(this.token);
		return a.length === b.length && timingSafeEqual(a, b);
	}

	/**
	 * Every token a request presents: the header's, and the value of each `ompw_token` cookie. A cookie that cannot be
	 * decoded presents nothing (it must not fail the request), and several of them all count: cookies are shared by
	 * every localhost port, so another page's `ompw_token=…` can ride along in front of the real one.
	 */
	presented(req: Request): string[] {
		const tokens: string[] = [];
		const header = req.headers.get("x-omp-webui-token");
		if (header) tokens.push(header);
		for (const part of (req.headers.get("cookie") ?? "").split(";")) {
			const eq = part.indexOf("=");
			if (eq < 0 || part.slice(0, eq).trim() !== COOKIE) continue;
			try {
				tokens.push(decodeURIComponent(part.slice(eq + 1).trim()));
			} catch {
				// Not a token of ours: the next cookie may be.
			}
		}
		return tokens;
	}

	allowed(req: Request): boolean {
		return this.token === null || this.presented(req).some((candidate) => this.matches(candidate));
	}

	/** `secure`: the page came over https (through the tunnel): a cookie without `Secure` could then be sent in clear. */
	cookieHeader(secure = false): string {
		// 400 days, the browser maximum; the token itself never expires.
		return `${COOKIE}=${encodeURIComponent(this.token ?? "")}; ${secure ? "Secure; " : ""}HttpOnly; SameSite=Strict; Path=/; Max-Age=34560000`;
	}
}
