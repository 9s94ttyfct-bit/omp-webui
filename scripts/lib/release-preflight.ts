/**
 * What a release needs from this machine, checked before anything long runs (scripts/release-local.ts). Each of these
 * would otherwise be found only when its step is reached: after the live-model tests and the app build, minutes in.
 *
 *   gui      a logged-in desktop session with Finder automation: `bun run dmg` lays the window out through Finder
 *   publish  a signed-in `gh` whose token may write the release and push the tag (scope `repo`)
 *   signing  the self-signed code-signing identity (scripts/signing-identity.ts): without it the app is signed ad hoc and
 *            every update loses its macOS permissions
 */
import { IDENTITY_NAME, parseIdentities, SIGNING_KEYCHAIN } from "../signing-identity.ts";

export interface ProbeResult {
	code: number;
	out: string;
	err: string;
}

/** Runs a command to its end (or `timeoutMs`, which is a failure); a command that cannot be started is code 127. */
export type Probe = (cmd: string[], timeoutMs: number) => Promise<ProbeResult>;

export interface Needs {
	/** The dmg is laid out by Finder. */
	gui: boolean;
	/** The tag is pushed and the release published. */
	publish: boolean;
	/** The app is signed with the stable identity, so that an update keeps its macOS permissions. */
	signing: boolean;
}

const SCOPES = ["repo"];

/** The scopes in the `X-OAuth-Scopes` header of a `gh api -i` answer; null when it has none (fine-grained tokens). */
export function tokenScopes(headers: string): string[] | null {
	const line = headers.split("\n").find((l) => /^x-oauth-scopes:/i.test(l));
	if (line === undefined) return null;
	return line
		.slice(line.indexOf(":") + 1)
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

const first = (text: string) => text.trim().split("\n")[0] ?? "";

async function gui(probe: Probe): Promise<string[]> {
	const session = await probe(["launchctl", "managername"], 10_000);
	if (session.out.trim() !== "Aqua") {
		return [
			`no logged-in desktop session (launchctl managername: ${session.out.trim() || first(session.err) || "no answer"}): the dmg's window is laid out by Finder, so run the release from Terminal on the Mac's own desktop, not over SSH or with the screen locked`,
		];
	}
	const finder = await probe(["osascript", "-e", 'tell application "Finder" to get name'], 20_000);
	if (finder.code !== 0) {
		return [
			`Finder cannot be scripted (${first(finder.err) || `osascript exited with ${finder.code}`}): allow this terminal under System Settings > Privacy & Security > Automation > Finder`,
		];
	}
	return [];
}

async function publish(probe: Probe): Promise<string[]> {
	const user = await probe(["gh", "api", "-i", "user"], 20_000);
	if (user.code !== 0)
		return [`gh is not signed in (${first(user.err) || `exit ${user.code}`}): run \`gh auth login\``];
	const scopes = tokenScopes(user.out);
	const missing = scopes === null ? [] : SCOPES.filter((s) => !scopes.includes(s));
	return missing.length > 0
		? [`the gh token lacks ${missing.join(", ")}: run \`gh auth refresh -s ${missing.join(",")}\``]
		: [];
}

async function signing(probe: Probe): Promise<string[]> {
	const listed = await probe(["security", "find-identity", "-p", "codesigning", SIGNING_KEYCHAIN], 20_000);
	if (listed.code !== 0) {
		return [
			`security find-identity failed (${first(listed.err) || `exit ${listed.code}`}): the signing keychain ${SIGNING_KEYCHAIN} cannot be read`,
		];
	}
	if (parseIdentities(listed.out).length > 0) return [];
	return [
		`no code-signing identity named "${IDENTITY_NAME}": the app would be signed ad-hoc and macOS would forget its permissions (notifications, screen recording, accessibility) at every update. Run \`bun scripts/signing-identity.ts\` once on this Mac`,
	];
}

/** Every prerequisite this release is missing, named; empty when it can go ahead. The checks run side by side. */
export async function preflight(needs: Needs, probe: Probe): Promise<string[]> {
	const checks: Promise<string[]>[] = [];
	if (needs.gui) checks.push(gui(probe));
	if (needs.publish) checks.push(publish(probe));
	if (needs.signing) checks.push(signing(probe));
	return (await Promise.all(checks)).flat();
}
