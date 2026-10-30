/**
 * What the web UI knows about the omp it drives: whether it is installed and how, whether a newer release
 * exists, and which omp versions this build of the web UI is made for. The server computes it
 * (`server/omp/lifecycle.ts`) and the page shows it; versions are compared here so both agree.
 */

import type { ErrorInfo } from "./error-info.ts";

/**
 * The omp versions this web UI supports: `min` up to, not including, `below`. omp's RPC protocol, config keys
 * and commands are what the web UI is written against (the contract tests run against the latest omp every
 * day); a release of the next major version may change them, so the web UI warns before moving there and when
 * it starts on one. Raise `min` when the web UI starts to rely on something older releases lack, and `below`
 * once a newer major release has been checked against it.
 */
export const OMP_COMPAT = { min: "18.11.0", below: "19.0.0" } as const;

/** The range as a person reads it. */
export const OMP_COMPAT_RANGE = `>=${OMP_COMPAT.min} <${OMP_COMPAT.below}`;

interface ParsedVersion {
	core: [number, number, number];
	pre: string[];
}

/** `18.12.1`, `v18.12.1`, `omp/18.13.0-canary.2`; null for anything else. Build metadata (`+…`) is ignored. */
export function parseVersion(text: string): ParsedVersion | null {
	const m = /^(?:omp\/)?v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
		text.trim(),
	);
	if (!m) return null;
	return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
}

/** Semver order: negative when `a` is older than `b`; a prerelease is older than its release. 0 when either is not a version. */
export function compareVersions(a: string, b: string): number {
	const x = parseVersion(a);
	const y = parseVersion(b);
	if (!x || !y) return 0;
	for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
	if (x.pre.length === 0 || y.pre.length === 0) return x.pre.length === y.pre.length ? 0 : x.pre.length === 0 ? 1 : -1;
	for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
		const p = x.pre[i];
		const q = y.pre[i];
		if (p === undefined) return -1;
		if (q === undefined) return 1;
		if (p === q) continue;
		const numeric = /^\d+$/.test(p) && /^\d+$/.test(q);
		if (numeric) return Number(p) < Number(q) ? -1 : 1;
		if (/^\d+$/.test(p) !== /^\d+$/.test(q)) return /^\d+$/.test(p) ? -1 : 1;
		return p < q ? -1 : 1;
	}
	return 0;
}

/** How a version stands to the range this web UI supports. `unknown`: it is not a version (omp could not report one). */
export type CompatVerdict = "supported" | "older" | "newer" | "unknown";

export function compatOf(version: string | null): CompatVerdict {
	if (!version || !parseVersion(version)) return "unknown";
	if (compareVersions(version, OMP_COMPAT.min) < 0) return "older";
	// A prerelease of the next major (`19.0.0-canary.1`) is already outside the range: it is older than 19.0.0 itself.
	const next = parseVersion(OMP_COMPAT.below);
	const v = parseVersion(version);
	if (next && v && v.core[0] === next.core[0] && v.core[1] === next.core[1] && v.core[2] === next.core[2])
		return "newer";
	return compareVersions(version, OMP_COMPAT.below) < 0 ? "supported" : "newer";
}

// ------------------------------------------------------------------ install

/**
 * How the omp that runs was installed, from where its file is (`detectInstall`). It decides where the latest
 * release is looked up (the standalone binary's build service, or npm for every package manager) and what the
 * Update button tells the user will happen.
 */
export type InstallMethod =
	| "homebrew"
	| "bun"
	| "npm"
	/** omp's own installer (`curl https://omp.sh/install`): a standalone binary that replaces itself. */
	| "installer"
	| "mise"
	| "nix"
	/** Kept up to date by another app (omp reads its `manager.json`); `OmpInstall.managedBy` names it. */
	| "managed"
	/** A source checkout or a file this cannot classify. */
	| "unknown";

export interface OmpInstall {
	method: InstallMethod;
	managedBy: string | null;
	/** The file the omp on PATH really is (symlinks resolved). */
	realPath: string;
	/** `omp update` can update this install. Nix and managed installs update elsewhere; an unknown one is not touched. */
	updatable: boolean;
}

/** The ways the first-run screen can install omp. */
export type InstallOptionId = "homebrew" | "installer" | "bun";

export interface InstallOption {
	id: InstallOptionId;
	/** What running it runs, as a user would type it. */
	command: string;
	/** The program that must be installed for it to work (`brew`, `bun`, `curl`); null when none beyond the shell. */
	needs: string | null;
	/** `needs` was found. */
	available: boolean;
	recommended: boolean;
}

/**
 * Conversations of the web UI that an update waits for, told apart by what each is doing — `working` ends by itself;
 * `asking` needs the user's answer; `paused` is frozen until the user resumes or ends it.
 */
export interface Holds {
	working: number;
	asking: number;
	paused: number;
}

export type JobState = "waiting" | "running" | "done" | "failed";

/** An install or an update the server runs; one at a time. Its output is `omp_log` messages and `GET /api/omp`'s `log`. */
export interface OmpJob {
	id: string;
	kind: "install" | "update";
	/** An `InstallOptionId` for an install; the install method of the omp being updated for an update. */
	method: string;
	command: string;
	state: JobState;
	exitCode: number | null;
	error: string | null;
	/** What the page words `error` from, when it is one the user is meant to read (`shared/error-info.ts`). */
	errorInfo?: ErrorInfo;
	startedAt: number;
	endedAt: number | null;
	/** Started by "Update omp automatically", not by a click. */
	auto: boolean;
	/** The conversations an update is waiting for, by what they are doing: it starts once none is left (`anyway`: none is working). */
	waiting: Holds;
	/**
	 * "Update anyway" was chosen: paused conversations and ones waiting for an answer are no longer waited for, only the
	 * ones that are working (they finish by themselves). The omp processes of the others keep running the old version.
	 */
	anyway: boolean;
	/** The version omp reports once the job succeeded. */
	version: string | null;
}

export interface OmpRelease {
	latest: string;
	/** `latest` is newer than the installed version. */
	newer: boolean;
	changelogUrl: string;
	source: "npm" | "build-service";
	checkedAt: number;
	/** How `latest` stands to the range the web UI supports. */
	compat: CompatVerdict;
}

export interface OmpState {
	/** `missing`: no omp found. `broken`: one was found but does not run (`error` says why). */
	status: "ready" | "missing" | "broken";
	bin: string | null;
	version: string | null;
	error: string | null;
	/** Where it looked, for the message when it is missing. */
	searched: string[];
	install: OmpInstall | null;
	/** What the first-run screen offers; empty while omp is ready. */
	options: InstallOption[];
	compat: { range: string; verdict: CompatVerdict };
	release: OmpRelease | null;
	releaseError: string | null;
	checking: boolean;
	/** The setting: update omp by itself when no conversation is busy. */
	autoUpdate: boolean;
	/**
	 * "Update omp automatically" is on and a release it may install is out, but these conversations are in the way, so
	 * no update was started; null when nothing is in the way (or there is nothing to install). Counts of what holds it.
	 */
	autoWaitingFor: Holds | null;
	/** The first-time setup (sign in, default model, permissions) is still to be done or finished. */
	onboarding: boolean;
	job: OmpJob | null;
	/**
	 * Which run of the server said this (`boot`), and the order it said things in (`rev` counts up with every
	 * statement). A page gets the state twice over: pushed on the socket, and as the answer to a request. The answer
	 * is the state as of the request, so it can arrive after a push that is newer (an update that fails at once is
	 * `failed` on the socket before the answer saying `running` is read); a page keeps the one with the higher `rev`.
	 * A new run of the server counts from the start again, which its `boot` tells apart from an old run's.
	 */
	boot: string;
	rev: number;
}

/** `GET /api/omp`: the state and the output of the current job. */
export interface OmpSnapshot {
	state: OmpState;
	log: string;
}
