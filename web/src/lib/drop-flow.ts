import {
	ATTACH_LIMITS,
	actionAllowed,
	type Classified,
	classify,
	DOCUMENT_LIMITS,
	type DropAction,
	type DropChoices,
	type DropKind,
	hasMention,
	looksLikeText,
	type NoAttach,
} from "@shared/attachment.ts";
import { UPLOAD_LIMITS, type UploadCode } from "@shared/upload.ts";
import { type MessageKey, t } from "../i18n/index.ts";
import type { DocumentFailure } from "./documents.ts";
import type { DropRequest } from "./drop-items.ts";
import { type ImageRefusal, refusalMessage } from "./images.ts";
import { type ShellItem, shellDropItems } from "./shell-drop.ts";

/**
 * What the choice between attaching a dropped file and inserting its path is made of, apart from how it looks
 * (`components/DropChoice.tsx`): what each file is, where it is on this computer, which are asked about and which a
 * remembered choice settles, and the words for what cannot be done.
 */

/** One file (or folder) given to the composer. */
export interface Entry {
	file: File;
	directory: boolean;
	info: Classified;
	/** Where it is on this computer, when the app's window said so: its path needs no upload. */
	path: string | null;
	/** A text file that can be attached has an `@` mention in it that omp would read as a file (`hasMention`). */
	mentions: boolean;
}

const nfc = (s: string) => s.normalize("NFC");

/**
 * The path of each of `files` among what the app's window kept of the drop: the item of the same name, which for a file has
 * its size too (a folder has no size to compare). An item is given to one file only. Null where the app said nothing of it.
 */
export function matchPaths(
	files: readonly { name: string; size: number; directory: boolean }[],
	items: readonly ShellItem[],
): ({ path: string; directory: boolean } | null)[] {
	const taken = new Set<number>();
	return files.map((file) => {
		const at = items.findIndex(
			(item, i) =>
				!taken.has(i) &&
				nfc(item.name) === nfc(file.name) &&
				(item.directory ? file.directory || file.size === 0 : !file.directory && item.size === file.size),
		);
		if (at < 0) return null;
		taken.add(at);
		const item = items[at] as ShellItem;
		return { path: item.path, directory: item.directory };
	});
}

/** The app's answer for each request: the window gives what it kept once, so a request is never asked about twice. */
const kept = new WeakMap<DropRequest, Promise<ShellItem[]>>();

/**
 * What each file of the request is: its first bytes say whether it is text. A drop is first matched to what the app's
 * window kept of it (its paths): the window lets go of that fifteen seconds after the drop, which this runs well inside.
 */
export async function describe(request: DropRequest): Promise<Entry[]> {
	let asked = kept.get(request);
	if (!asked) {
		asked = request.source === "drop" ? shellDropItems() : Promise.resolve([]);
		kept.set(request, asked);
	}
	const items = await asked;
	const matched = matchPaths(
		request.files.map((file, i) => ({ name: file.name, size: file.size, directory: request.directories[i] ?? false })),
		items,
	);
	return Promise.all(
		request.files.map(async (file, i) => {
			const directory = (request.directories[i] ?? false) || matched[i]?.directory === true;
			// The whole file up to what a message takes: a file that is text for its first bytes and not after is not text.
			const head = file.slice(0, ATTACH_LIMITS.textFileBytes);
			const sample = directory
				? new Uint8Array()
				: new Uint8Array(await head.arrayBuffer().catch(() => new ArrayBuffer(0)));
			const whole = sample.byteLength === file.size;
			const info = classify(
				{ name: file.name, type: file.type, size: file.size, directory },
				looksLikeText(sample, whole),
			);
			const mentions = info.kind === "text" && info.attach === true && hasMention(new TextDecoder().decode(sample));
			return { file, directory, info, path: matched[i]?.path ?? null, mentions };
		}),
	);
}

/** An entry and what is to be done with it. */
export interface Task {
	entry: Entry;
	action: DropAction;
}

/**
 * The choices that apply to files from `source`: the ones the person remembered, and for a paste one more. A picture pasted
 * from the clipboard (a screenshot, mostly) is attached without asking, as it was before there was a choice, unless the
 * person chose otherwise for pictures.
 */
export function choicesFor(source: DropRequest["source"], remembered: DropChoices): DropChoices {
	return source === "paste" ? { image: "attach", ...remembered } : remembered;
}

/**
 * Which entries a remembered choice settles, and which are asked about. A remembered "attach" does not settle a file that
 * cannot be attached (a text file over the limit): the person chose for files that can.
 */
export function plan(entries: readonly Entry[], choices: DropChoices): { settled: Task[]; asked: Entry[] } {
	const settled: Task[] = [];
	const asked: Entry[] = [];
	for (const entry of entries) {
		const action = choices[entry.info.kind];
		if (action && actionAllowed(entry.info.kind, action) && (action === "path" || entry.info.attach === true))
			settled.push({ entry, action });
		else asked.push(entry);
	}
	return { settled, asked };
}

/** The kinds among `entries`, each once, in the order they are named in the settings. */
export function kindsOf(entries: readonly Entry[]): DropKind[] {
	const present = new Set(entries.map((e) => e.info.kind));
	return (["text", "image", "document", "other", "folder"] as const).filter((k) => present.has(k));
}

/** The choices to remember when `action` is picked for `asked`: the kinds it can be done to. */
export function rememberedFor(asked: readonly Entry[], action: DropAction): DropChoices {
	const out: DropChoices = {};
	for (const kind of kindsOf(asked)) if (actionAllowed(kind, action)) out[kind] = action;
	return out;
}

/** `bytes` as a person reads it: `256 KB`, `1.5 MB`. */
export function sizeText(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${Number((bytes / (1024 * 1024)).toFixed(1))} MB`;
}

/** Why an item cannot be attached, in the page's words. */
export function whyText(why: NoAttach): string {
	switch (why) {
		case "folder":
			return t("drop.whyFolder");
		case "document":
			return t("drop.whyDocument");
		case "binary":
			return t("drop.whyBinary");
		case "tooLarge":
			return t("drop.whyTooLarge", { limit: sizeText(ATTACH_LIMITS.textFileBytes) });
		case "documentTooLarge":
			return t("drop.whyDocumentTooLarge", { limit: sizeText(DOCUMENT_LIMITS.fileBytes) });
	}
}

/** The toast for an attachment that was refused. */
export function notAttachedText(name: string, why: NoAttach): string {
	return t("drop.notAttached", { name, why: whyText(why) });
}

/** The toast for a text file that would take the message's text files over their total. */
export function totalText(name: string, total: number): string {
	return t("drop.notAttachedTotal", {
		name,
		total: sizeText(total),
		limit: sizeText(ATTACH_LIMITS.textTotalBytes),
	});
}

/** The toast for an image that was refused (the words of the images' own limits). */
export function imageRefusalText(r: ImageRefusal): string {
	const { key, vars } = refusalMessage(r);
	return t(key, vars);
}

/** The toast for a document that could not be read, or has nothing a message could carry. */
export function documentFailureText(f: DocumentFailure): string {
	switch (f.reason) {
		case "tooLarge":
			return t("drop.docTooLarge", { name: f.name, limit: sizeText(DOCUMENT_LIMITS.fileBytes) });
		case "encrypted":
			return t("drop.docEncrypted", { name: f.name });
		case "damaged":
			return t("drop.docDamaged", { name: f.name });
		case "oldWord":
			return t("drop.docOldWord", { name: f.name });
		case "empty":
			return t("drop.docEmpty", { name: f.name });
		case "noRoom":
			return totalText(f.name, f.total);
		case "failed":
			return t("drop.errRead", { name: f.name, error: f.message });
	}
}

const LABELS: Record<DropKind, MessageKey> = {
	text: "drop.labelText",
	image: "drop.labelImage",
	document: "drop.labelDocument",
	other: "drop.labelOther",
	folder: "drop.labelFolder",
};

const KINDS: Record<DropKind, MessageKey> = {
	text: "drop.kindText",
	image: "drop.kindImage",
	document: "drop.kindDocument",
	other: "drop.kindOther",
	folder: "drop.kindFolder",
};

/** The label of a kind of file in a row of the list. */
export function labelText(kind: DropKind): string {
	return t(LABELS[kind]);
}

/** The kinds as a sentence part: "text files and images". */
export function kindsText(kinds: readonly DropKind[], lang: string): string {
	const names = kinds.map((k) => t(KINDS[k]));
	return new Intl.ListFormat(lang, { style: "long", type: "conjunction" }).format(names);
}

/** The toast for an upload that failed or was refused, from the server's answer (`UploadError`, `lib/upload.ts`). */
export function uploadFailureText(
	name: string,
	failure: { code: UploadCode | "failed"; message: string; limit?: number },
): string {
	switch (failure.code) {
		case "tooLarge":
			return t("drop.errTooLarge", { name, limit: sizeText(failure.limit ?? UPLOAD_LIMITS.fileBytes) });
		case "quota":
			return t("drop.errQuota", { limit: sizeText(failure.limit ?? UPLOAD_LIMITS.folderBytes) });
		case "tooMany":
			return t("drop.errTooManyFiles", { limit: failure.limit ?? UPLOAD_LIMITS.counted });
		case "ownData":
			return t("drop.errOwnData");
		case "off":
			return t("drop.errOff");
		case "folderGone":
			return t("drop.errFolderGone");
		case "unknownConversation":
			return t("drop.errUnknown");
		case "refused":
			return t("drop.errRefused");
		case "stalled":
			return t("drop.errStalled");
		case "write":
			return t("drop.errWrite", { name });
		case "badRequest":
			return t("drop.errBadRequest", { name });
		case "failed":
			return t("drop.errFailed", { name, error: failure.message });
	}
}
