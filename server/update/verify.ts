import { join } from "node:path";
import { isRecord } from "../../shared/guards.ts";
import { compareVersions, parseVersion } from "../../shared/omp-install.ts";
import type { UpdateFailure } from "../../shared/update.ts";
import { run } from "../omp/run.ts";
import { detailOf } from "./steps.ts";

/**
 * What a downloaded app must be before it replaces the running one (#571): its signature is intact, it is this app, it is
 * the release it was downloaded as, it is newer than the running one, and it is signed by the certificate the running one
 * is. The last is what macOS keeps the app's permissions by (#456): the designated requirement names the bundle identifier
 * and the signing certificate, and an ad-hoc signature's is the build's own hash, which never matches anything else. It is
 * also what makes the download worth trusting: anyone can publish a file under a release's name, only the holder of the
 * certificate's key can sign it so that this requirement holds.
 *
 * Every refusal says what was wrong; nothing is installed after one.
 */

type Refusal = Omit<UpdateFailure, "tag">;

const COMMAND_MS = 60_000;

/** The designated requirement the signature at `app` carries (`codesign -d -r-`), or null when it has none. */
export async function designatedRequirementOf(app: string): Promise<string | null> {
	const r = await run(["/usr/bin/codesign", "-d", "-r-", app], { timeoutMs: COMMAND_MS });
	// An ad-hoc signature's is a comment (`# designated => cdhash H"…"`): codesign made it up, the signer wrote none.
	const line = r.stdout.split("\n").find((l) => /^(# )?designated =>/.test(l));
	return line ? line.replace(/^# /, "").trim() : null;
}

/** The SHA-1 of the signing certificate a requirement names (`certificate leaf = H"…"`); null for any other kind. */
export function leafOf(requirement: string): string | null {
	return /certificate leaf = H"([0-9a-f]{40})"/i.exec(requirement)?.[1]?.toLowerCase() ?? null;
}

/** The two Info.plist keys that decide whether an app is the release it claims to be. */
export interface AppInfo {
	id: string;
	version: string;
}

/** `Contents/Info.plist` of the bundle at `app`; null when it is not there or has no identifier and version. */
export async function infoOf(app: string): Promise<AppInfo | null> {
	const r = await run(["/usr/bin/plutil", "-convert", "json", "-o", "-", join(app, "Contents", "Info.plist")], {
		timeoutMs: COMMAND_MS,
	});
	if (r.code !== 0) return null;
	try {
		const info: unknown = JSON.parse(r.stdout);
		if (!isRecord(info)) return null;
		const id = info.CFBundleIdentifier;
		const version = info.CFBundleShortVersionString;
		return typeof id === "string" && typeof version === "string" ? { id, version } : null;
	} catch {
		return null;
	}
}

export interface Expectation {
	/** The running app's bundle: its identifier and designated requirement are what the download must have. */
	running: string;
	/** The release's version (its tag without the `v`): the app must say so itself. */
	version: string;
	/** The version running now: the app must be newer. */
	installed: string;
}

/**
 * `null` when the app at `app` is fit to replace the running one, else the first thing wrong with it. The order is the
 * order of the sentences a person would want first: is it intact, is it ours, is it the right release, is it newer, is
 * it signed by the same certificate.
 */
export async function refusalOf(app: string, expected: Expectation): Promise<Refusal | null> {
	const verified = await run(["/usr/bin/codesign", "--verify", "--deep", "--strict", app], { timeoutMs: COMMAND_MS });
	if (verified.code !== 0) return { code: "signature", params: { detail: detailOf(verified) } };

	const [found, running] = await Promise.all([infoOf(app), infoOf(expected.running)]);
	if (!found || !running) {
		return { code: "signature", params: { detail: "Contents/Info.plist could not be read" } };
	}
	if (found.id !== running.id) return { code: "bundleId", params: { expected: running.id, found: found.id } };
	if (found.version !== expected.version || parseVersion(found.version) === null) {
		return { code: "version", params: { tag: `v${expected.version}`, found: found.version } };
	}
	if (compareVersions(found.version, expected.installed) <= 0) {
		return { code: "notNewer", params: { found: found.version, installed: expected.installed } };
	}

	const [mine, theirs] = await Promise.all([designatedRequirementOf(expected.running), designatedRequirementOf(app)]);
	const mineLeaf = mine === null ? null : leafOf(mine);
	// Nothing to hold the download against: an ad-hoc signature is its own build's hash.
	if (mine === null || mineLeaf === null) return { code: "adHoc", params: {} };
	const theirLeaf = theirs === null ? null : leafOf(theirs);
	if (theirs === null || theirLeaf === null || theirs !== mine) {
		const found = theirLeaf === null ? "ad hoc" : theirLeaf === mineLeaf ? "another requirement" : theirLeaf;
		return { code: "requirement", params: { expected: mineLeaf, found } };
	}
	return null;
}
