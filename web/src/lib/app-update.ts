import type {
	InstallBlock,
	UpdateFailure,
	UpdateFailureCode,
	UpdateNotes,
	UpdateOutcome,
	UpdatePhase,
} from "@shared/update.ts";
import type { Lang, MessageKey, Vars } from "../i18n/index.ts";

/**
 * What the Updates card says, as plain functions: which language's release notes, what each failure of an install says
 * (and with which values), how far a download is. Type imports only, so a test reads them without React.
 */

/** The release notes in the interface language, the other language's when this one has none (either may be empty). */
export function notesFor(notes: UpdateNotes, lang: Lang): string {
	return (lang === "zh-CN" ? notes.zh || notes.en : notes.en || notes.zh).trim();
}

/** `v0.12.0` → `0.12.0`: the strings put their own `v` before a version. */
export const versionOfTag = (tag: string): string => tag.replace(/^v/i, "");

// ------------------------------------------------------------------ sizes

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;
/** A number of units with one decimal, without a trailing `.0`. */
const scaled = (bytes: number, unit: number) => String(Number((bytes / unit).toFixed(1)));

/** `54.2 MB`, `1.3 GB`, `640 KB`: the size of a download or of free space. */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return "?";
	if (bytes >= GB) return `${scaled(bytes, GB)} GB`;
	if (bytes >= MB || bytes === 0) return `${scaled(bytes, MB)} MB`;
	return `${Math.round(bytes / KB)} KB`;
}

/** `12.3 / 54.2 MB` while the size is known (both in the unit of the whole), `12.3 MB` while it is not. */
export function formatProgress(received: number, total: number): string {
	if (!(total > 0)) return formatBytes(received);
	const done = Math.min(received, total);
	const whole = formatBytes(total);
	const [number, unit] = whole.split(" ");
	const divisor = unit === "GB" ? GB : unit === "KB" ? KB : MB;
	return `${unit === "KB" ? Math.round(done / divisor) : scaled(done, divisor)} / ${number} ${unit}`;
}

/** How much of the download is done, 0 to 100; null while the total is not known (the bar has no length to show). */
export function progressPercent(received: number, total: number): number | null {
	if (!(total > 0)) return null;
	return Math.max(0, Math.min(100, Math.round((received / total) * 100)));
}

// ------------------------------------------------------------------ an install that did not go on

/** The sentence of each failure code. A code of a newer server than this page has none: `failedUnknown` says it. */
const FAILURE_KEYS = {
	download: "update.failedDownload",
	size: "update.failedSize",
	digest: "update.failedDigest",
	mount: "update.failedMount",
	noApp: "update.failedNoApp",
	signature: "update.failedSignature",
	bundleId: "update.failedBundleId",
	version: "update.failedVersion",
	notNewer: "update.failedNotNewer",
	requirement: "update.failedRequirement",
	adHoc: "update.failedAdHoc",
	space: "update.failedSpace",
	notWritable: "update.failedNotWritable",
	stage: "update.failedStage",
} as const satisfies Record<UpdateFailureCode, MessageKey>;

export const UPDATE_FAILURE_CODES = Object.keys(FAILURE_KEYS) as UpdateFailureCode[];

/** The values a sentence uses, by the code. A value the server did not send shows as `?`, never as `{name}`. */
const FAILURE_PARAMS: Record<UpdateFailureCode, readonly string[]> = {
	download: [],
	size: ["expected", "actual"],
	digest: ["expected", "actual"],
	mount: ["detail"],
	noApp: [],
	signature: ["detail"],
	bundleId: ["expected", "found"],
	version: ["tag", "found"],
	notNewer: ["found", "installed"],
	requirement: ["expected", "found"],
	adHoc: [],
	space: ["needed", "free"],
	notWritable: ["dir"],
	stage: ["detail"],
};

/** A hash of 16 characters or more cut to its first 12 (`sha256:` dropped); anything else (`ad hoc`) as it is. */
export function shortHash(value: string): string {
	const hex = value.replace(/^sha-?256:/i, "");
	return /^[0-9a-f]{16,}$/i.test(hex) ? `${hex.slice(0, 12)}…` : value;
}

/** The longest tool output put into a sentence; codesign and hdiutil can say a great deal. */
const DETAIL_LIMIT = 300;

/** A tool's output names the folder it worked in (a mount point in the update's temp files): the app is all the reader needs. */
const rawDetail = (text: string): string => text.replace(/\/[^\s:]*\/(omp-webui\.app)/g, "$1");

function paramText(code: UpdateFailureCode, name: string, raw: string | number | undefined): string {
	if (raw === undefined || raw === "") return "?";
	if (typeof raw === "number") return name === "needed" || name === "free" ? formatBytes(raw) : String(raw);
	if (name === "expected" || name === "actual" || name === "found") {
		if (code === "digest" || code === "requirement") return shortHash(raw);
	}
	if (name === "detail") {
		const text = rawDetail(raw);
		return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT)}…` : text;
	}
	if (name === "needed" || name === "free") return formatBytes(Number(raw));
	return raw;
}

/** What a failed install says: the string and the values for it. Every code has its own sentence in both languages. */
export function failureMessage(failure: Pick<UpdateFailure, "code" | "params">): { key: MessageKey; vars: Vars } {
	const { code, params } = failure;
	const known = code in FAILURE_KEYS;
	if (!known) return { key: "update.failedUnknown", vars: { code: String(code) } };
	if (code === "download") {
		const word = params.reason === undefined || params.reason === "" ? "" : String(params.reason);
		// A redirect to somewhere that is not GitHub's: the place it named is what the person needs to see.
		const reason = word === "redirect" && params.host !== undefined ? `redirect → ${params.host}` : word;
		const status = params.status === undefined || params.status === "" ? "" : `HTTP ${params.status}`;
		const detail = [reason, status].filter(Boolean).join(", ");
		return detail
			? { key: "update.failedDownload", vars: { detail } }
			: { key: "update.failedDownloadPlain", vars: {} };
	}
	const vars: Vars = {};
	for (const name of FAILURE_PARAMS[code]) vars[name] = paramText(code, name, params[name]);
	return { key: FAILURE_KEYS[code], vars };
}

// ------------------------------------------------------------------ the other things the card says by a code

/** What each way this copy cannot install says (the version names the release to download by hand). */
export const BLOCK_KEYS = {
	notApp: "update.blockedNotApp",
	translocated: "update.blockedTranslocated",
	notWritable: "update.blockedNotWritable",
	adHoc: "update.blockedAdHoc",
} as const satisfies Record<InstallBlock, MessageKey>;

/** Where an install is. */
export const PHASE_KEYS = {
	downloading: "update.phaseDownloading",
	verifying: "update.phaseVerifying",
	staging: "update.phaseStaging",
	handover: "update.phaseHandover",
} as const satisfies Record<UpdatePhase, MessageKey>;

/** The download and its check can be stopped; once the new app is staged the helper has taken over. */
export const canCancel = (phase: UpdatePhase): boolean => phase === "downloading" || phase === "verifying";

/** How an update that was put back ended: a sentence for each problem. */
export const OUTCOME_KEYS = {
	quitTimeout: "update.outcomeQuitTimeout",
	verify: "update.outcomeVerify",
	swap: "update.outcomeSwap",
	didNotStart: "update.outcomeDidNotStart",
	rollbackFailed: "update.outcomeRollbackFailed",
} as const satisfies Record<NonNullable<UpdateOutcome["problem"]>, MessageKey>;

export function outcomeMessage(outcome: UpdateOutcome): { key: MessageKey; vars: Vars } {
	const vars = { from: versionOfTag(outcome.from), to: versionOfTag(outcome.to) };
	if (outcome.ok) return { key: "update.outcomeOk", vars };
	const key =
		outcome.problem && outcome.problem in OUTCOME_KEYS ? OUTCOME_KEYS[outcome.problem] : "update.outcomeFailed";
	return { key, vars };
}

/** What a refused install request says: the string and its values. `replying` is not here: the page asks about it. */
export function refusalMessage(
	code: string | undefined,
	params: Record<string, unknown> | undefined,
	version: string,
): { key: MessageKey; vars: Vars } | null {
	if (code === "busy") return { key: "update.refusedBusy", vars: {} };
	if (code === "nothingToInstall") return { key: "update.refusedNothing", vars: {} };
	if (code === "blocked") {
		const reason = params?.reason;
		return typeof reason === "string" && reason in BLOCK_KEYS
			? { key: BLOCK_KEYS[reason as InstallBlock], vars: { version } }
			: { key: "update.refusedBlocked", vars: {} };
	}
	return null;
}

/** The conversations a `replying` refusal names: those it stops, and those that stay in the background. */
export function replyingOf(params: Record<string, unknown> | undefined): { stopped: number; staying: number } {
	const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
	return { stopped: n(params?.working) + n(params?.asking), staying: n(params?.paused) + n(params?.waiting) };
}
