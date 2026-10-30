/**
 * Which push endpoints this server will send to. A subscription's endpoint is a URL a page chose, and the server posts to it
 * from the computer it runs on: any URL would let a page that holds the token make that computer fetch addresses of its
 * own network (an SSRF). So only the push services of the browsers' makers are accepted, over https on their own port, and
 * no redirect is followed when one is sent to.
 *
 * Another service (a self-hosted one, or a stand-in in a test) is named by the person who runs the server, never by a page:
 * `OMP_WEBUI_PUSH_HOSTS`, a comma-separated list of origins (`https://push.example.com`, `http://127.0.0.1:8080`).
 */

/** The hosts of the browsers' push services: exactly this host, or any host below it. */
const SERVICES = [
	// Chrome, Edge on Android, Brave, Opera, Vivaldi, Samsung Internet (Firebase Cloud Messaging; GCM is the older name).
	"fcm.googleapis.com",
	"android.googleapis.com",
	// Firefox.
	"push.services.mozilla.com",
	// Safari and every browser on iOS (a home-screen app).
	"push.apple.com",
	// Edge and Chrome on Windows when they use WNS.
	"notify.windows.com",
];

const MAX_ENDPOINT = 2048;

/** The origins the person added (`OMP_WEBUI_PUSH_HOSTS`); anything that is not an origin is dropped with a warning. */
export function extraOrigins(list: string | undefined): string[] {
	const origins: string[] = [];
	for (const item of (list ?? "").split(",")) {
		const text = item.trim();
		if (!text) continue;
		try {
			const url = new URL(text);
			if ((url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password) {
				origins.push(url.origin);
				continue;
			}
		} catch {
			// not a URL: warned of below
		}
		console.warn(
			`omp-webui: OMP_WEBUI_PUSH_HOSTS: ${JSON.stringify(text)} is not an origin (https://host[:port]); ignored`,
		);
	}
	return origins;
}

/** Whether `endpoint` is one the server sends to: a push service's own, or an origin the person allowed. */
export function allowedEndpoint(endpoint: unknown, extra: readonly string[] = []): endpoint is string {
	if (typeof endpoint !== "string" || endpoint.length > MAX_ENDPOINT) return false;
	let url: URL;
	try {
		url = new URL(endpoint);
	} catch {
		return false;
	}
	if (url.username || url.password) return false;
	if (extra.includes(url.origin)) return true;
	if (url.protocol !== "https:" || url.port !== "") return false;
	const host = url.hostname.toLowerCase();
	return SERVICES.some((service) => host === service || host.endsWith(`.${service}`));
}
