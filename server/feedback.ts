import { arch, platform, release, userInfo } from "node:os";
import { REPO } from "../shared/repo.ts";

/** How long an answer GitHub gave stays good; one that could not be had is asked for again sooner. */
const ANSWER_MS = 24 * 60 * 60 * 1000;
const FAILURE_MS = 60 * 60 * 1000;

/**
 * Whether the project's repository is public, as GitHub tells an anonymous visitor: a public repository answers
 * `private: false`, a private one is "not found" to everyone without access. Anything else (offline, rate limit,
 * an odd reply) is `null`, "could not tell": the star prompt must never show on a guess, and the page asks again later.
 */
export class RepoVisibility {
	private known: { isPublic: boolean | null; until: number } | null = null;
	private asking: Promise<boolean | null> | null = null;

	constructor(
		private readonly apiBase = "https://api.github.com",
		private readonly fetcher: typeof fetch = fetch,
		private readonly now: () => number = Date.now,
	) {}

	async isPublic(): Promise<boolean | null> {
		if (this.known && this.now() < this.known.until) return this.known.isPublic;
		this.asking ??= this.ask().finally(() => {
			this.asking = null;
		});
		return this.asking;
	}

	private async ask(): Promise<boolean | null> {
		let isPublic: boolean | null = null;
		let until = this.now() + FAILURE_MS;
		try {
			// No credentials of any kind: whatever this machine is signed in to must not widen the answer.
			const r = await this.fetcher(`${this.apiBase}/repos/${REPO}`, {
				headers: { accept: "application/vnd.github+json", "user-agent": "omp-webui" },
				signal: AbortSignal.timeout(5000),
			});
			if (r.status === 404) {
				isPublic = false;
				until = this.now() + ANSWER_MS;
			} else if (r.ok) {
				const body: unknown = await r.json();
				if (typeof body === "object" && body !== null && "private" in body && typeof body.private === "boolean") {
					isPublic = !body.private;
					until = this.now() + ANSWER_MS;
				}
			}
		} catch {
			// Could not tell: asked again within the hour.
		}
		this.known = { isPublic, until };
		return isPublic;
	}
}

/** The OS user name, for the Feedback report to leave out; empty when the system cannot say. */
export function osUser(): string {
	try {
		return userInfo().username;
	} catch {
		return "";
	}
}

let macos: Promise<string | null> | undefined;

/** `sw_vers -productVersion` on a Mac, else null; asked once. */
function macosVersion(): Promise<string | null> {
	macos ??= (async () => {
		if (platform() !== "darwin") return null;
		try {
			const proc = Bun.spawn(["sw_vers", "-productVersion"], { stdout: "pipe", stderr: "ignore" });
			const out = (await new Response(proc.stdout).text()).trim();
			return (await proc.exited) === 0 && /^\d+(\.\d+)*$/.test(out) ? out : null;
		} catch {
			return null;
		}
	})();
	return macos;
}

/** The machine as a bug report names it: `macOS 15.1 (arm64)`, `linux 6.8.0 (x64)`. */
export async function osDescription(): Promise<string> {
	const mac = await macosVersion();
	return mac ? `macOS ${mac} (${arch()})` : `${platform()} ${release()} (${arch()})`;
}
