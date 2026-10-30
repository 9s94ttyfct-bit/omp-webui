import { remoteUrl } from "../shared/remote.ts";
import type { RemoteCheck } from "../shared/remote-ai.ts";

/**
 * A look at the public address from outside: does the hostname answer, and does Cloudflare Access ask for a sign-in
 * before anything of this app is served? One unauthenticated GET of `https://<hostname>/`, redirects not followed:
 * what comes back says where the way in is broken (DNS, the tunnel, this app, the Access application). It changes
 * nothing, and reads no more than the start of the answer.
 */

/** How long the address has to answer. */
const CHECK_MS = 10_000;
/** How much of the answer is read: an error page of Cloudflare's names its code in the first lines. */
const BODY_BYTES = 16 * 1024;

/** What the check needs of an answer. */
export interface Answer {
	status: number;
	/** The `Location` of a redirect. */
	location: string | null;
	/** The start of the body. */
	body: string;
}

/** The code of a Cloudflare error page (`Error 1033`, `error code: 1016`), or null. */
function cloudflareCode(body: string): string | null {
	return /error code:?\s*(\d{4})/i.exec(body)?.[1] ?? /\bError\s+(\d{4})\b/.exec(body)?.[1] ?? null;
}

/** The host a redirect goes to, or null when it is none. */
function hostOf(location: string | null, base: string): string | null {
	if (!location) return null;
	try {
		return new URL(location, base).host.toLowerCase();
	} catch {
		return null;
	}
}

/** What an answer from the public address says about the way in. `team`: the Cloudflare team the settings name ("" when none). */
export function judge(url: string, answer: Answer, team: string): RemoteCheck {
	const { status } = answer;
	const done = (verdict: RemoteCheck["verdict"], message: string): RemoteCheck => ({ url, verdict, status, message });
	const redirected = [301, 302, 303, 307, 308].includes(status);
	const target = redirected ? hostOf(answer.location, url) : null;
	if (target?.endsWith(".cloudflareaccess.com")) {
		if (team !== "" && target !== `${team}.cloudflareaccess.com`)
			return done(
				"other",
				`Cloudflare Access asks for a sign-in at ${target}, but the team saved here is "${team}": save the team that matches (the first part of ${target}).`,
			);
		return done(
			"ok",
			`The hostname answers and Cloudflare Access asks for a sign-in (at ${target}). The way in is as it should be.`,
		);
	}
	const code = cloudflareCode(answer.body);
	// 1001 comes with a 530 as 1033 does: the code says which it is.
	if (code === "1001")
		return done(
			"dns",
			"Cloudflare cannot resolve the hostname (error 1001): check its DNS record in the Cloudflare dashboard.",
		);
	if (code === "1033" || code === "1016" || status === 530)
		return done(
			"tunnel-down",
			`Cloudflare answers, but the tunnel is not connected${code ? ` (error ${code})` : ""}: it is not running, or the hostname's DNS record points at another tunnel. Start the tunnel and wait for "Connected"; if it is connected, set the tunnel up again.`,
		);
	if ([502, 503, 504, 521, 522, 523, 524].includes(status))
		return done(
			"origin-down",
			`The tunnel is connected but nothing answers behind it (HTTP ${status}): this app was not reachable on its port. Stop the tunnel and start it again; it writes the right port when it starts.`,
		);
	if (status === 403 && answer.body.trim() === "Forbidden")
		return done(
			"no-access",
			"The address reaches this app without Cloudflare Access asking for a sign-in: the Access application does not cover this hostname. In the Zero Trust dashboard, check that the application's domain is this hostname or a wildcard that covers it (*.example.com) and that it has an Allow policy.",
		);
	if (status === 404 && answer.body.trim() === "")
		return done(
			"other",
			"cloudflared answered 404: its configuration does not list this hostname. Set the tunnel up again, then start it.",
		);
	return done(
		"other",
		`The address answered HTTP ${status}${code ? ` (error ${code})` : ""}, which is none of the expected answers.`,
	);
}

/** What a failed request says: the name did not resolve, or the connection could not be made. */
function failure(url: string, e: unknown): RemoteCheck {
	const said = e instanceof Error ? `${(e as NodeJS.ErrnoException).code ?? ""} ${e.message}` : String(e);
	if (/ENOTFOUND|getaddrinfo|could not be resolved|dns/i.test(said))
		return {
			url,
			verdict: "dns",
			message:
				"The hostname does not resolve: it has no DNS record yet. Set the tunnel up (it creates the record), and check that the hostname's domain is in the Cloudflare account that was logged in.",
		};
	return {
		url,
		verdict: "unreachable",
		message: `The address could not be reached (${said.trim().slice(0, 160)}). Check the connection and the hostname, then try again.`,
	};
}

/** The start of `res`'s body, at most `BODY_BYTES`: the rest is not read. */
async function head(res: Response): Promise<string> {
	if (!res.body) return "";
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	try {
		while (text.length < BODY_BYTES) {
			const { done, value } = await reader.read();
			if (done) break;
			text += decoder.decode(value, { stream: true });
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	return text.slice(0, BODY_BYTES);
}

/**
 * Look at `https://<hostname>/`. `override`: where the request really goes instead (what the specs use: no Cloudflare
 * here); the answer is read as if it came from the hostname. Never throws for what the network does: that is the answer.
 */
export async function checkAddress(hostname: string, team: string, override?: string): Promise<RemoteCheck> {
	const url = `${remoteUrl(hostname)}/`;
	try {
		const res = await fetch(override ?? url, {
			redirect: "manual",
			signal: AbortSignal.timeout(CHECK_MS),
			headers: { accept: "text/html", "user-agent": "omp-webui-remote-check" },
		});
		return judge(url, { status: res.status, location: res.headers.get("location"), body: await head(res) }, team);
	} catch (e) {
		return failure(url, e);
	}
}
