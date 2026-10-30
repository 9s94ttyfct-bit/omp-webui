import { type ArchiveSkipped, TRANSFER_LIMITS, type TransferCode } from "@shared/transfer.ts";
import { type MessageKey, t } from "../i18n/index.ts";
import { fmtBytes } from "./files-rows.ts";

/**
 * What a refused or failed transfer says, in the page's language. The code decides the words (a code of the contract that
 * has none yet is a type error here); a code the page does not know is shown with the server's own English sentence.
 * The strings are the `files` namespace's, registered by the Files tab (`components/files/FilesPane.tsx`).
 */
const CODE_WORDS: Record<TransferCode, MessageKey> = {
	off: "files.transferErrOff",
	uploadOff: "files.transferErrUploadOff",
	outside: "files.transferErrOutside",
	secret: "files.transferErrSecret",
	hidden: "files.transferErrHidden",
	protected: "files.transferErrProtected",
	homeFolder: "files.transferErrHomeFolder",
	ownData: "files.transferErrOwnData",
	refused: "files.transferErrRefused",
	badName: "files.transferErrBadName",
	badRequest: "files.transferErrBadRequest",
	notFound: "files.transferErrNotFound",
	gone: "files.transferErrGone",
	notFile: "files.transferErrNotFile",
	notFolder: "files.transferErrNotFolder",
	exists: "files.transferErrExists",
	offset: "files.transferErrOffset",
	changed: "files.transferErrChanged",
	conflict: "files.editErrConflict",
	notText: "files.editErrNotText",
	tooLarge: "files.transferErrTooLarge",
	tooMany: "files.transferErrTooMany",
	busy: "files.transferErrBusy",
	diskFull: "files.transferErrDiskFull",
	stalled: "files.transferErrStalled",
	write: "files.transferErrWrite",
};

/** What the words of a failure are made from: a `TransferError`, or a row's error. */
export interface Failure {
	code: TransferCode | "failed";
	/** The server's own sentence (English). */
	message: string;
	/** The HTTP status; 0: no answer came. */
	status: number;
	limit?: number;
}

/** `name` is the file the failure is about. */
export function describeFailure(failure: Failure, name: string): string {
	if (failure.code === "failed") {
		return failure.status === 0
			? t("files.transferErrNetwork")
			: t("files.transferErrOther", { error: failure.message });
	}
	const many = failure.code === "tooMany";
	const limit = failure.limit ?? (many ? TRANSFER_LIMITS.uploadFiles : TRANSFER_LIMITS.uploadBytes);
	return t(CODE_WORDS[failure.code], { name, limit: many ? limit : fmtBytes(limit) });
}

const SKIPS: [keyof ArchiveSkipped, MessageKey][] = [
	["secret", "files.transferSkipSecret"],
	["links", "files.transferSkipLinks"],
	["special", "files.transferSkipSpecial"],
	["name", "files.transferSkipName"],
	["hidden", "files.transferSkipHidden"],
];

/** What a ZIP leaves out, as a sentence part: "2 that look like secrets, 1 hidden"; empty when nothing was left out. */
export function leftOutText(skipped: ArchiveSkipped, lang: string): string {
	const parts = SKIPS.flatMap(([key, words]) => (skipped[key] > 0 ? [t(words, { n: skipped[key] })] : []));
	return new Intl.ListFormat(lang, { style: "short", type: "conjunction" }).format(parts);
}

/** The number of things a ZIP leaves out, all reasons together. */
export const leftOutCount = (skipped: ArchiveSkipped): number =>
	skipped.secret + skipped.links + skipped.special + skipped.name + skipped.hidden;
