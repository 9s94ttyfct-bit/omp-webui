import type { ImageAttachment, TextAttachment } from "../components/Composer.tsx";

/** What is in a composer and not sent yet. */
export interface Draft {
	text: string;
	images: ImageAttachment[];
	/** Text files attached and not sent yet; their text joins the message when it is sent (`shared/attachment.ts`). */
	files?: TextAttachment[];
}

/** Most drafts kept at once: each can hold up to 20 MB of images, and nobody comes back to dozens of them. */
export const MAX_DRAFTS = 20;

/** Where the drafts are mirrored: the tab's session storage, which a reload (of any kind) keeps and a closed tab does not. */
const STORAGE_KEY = "ompw.drafts";

/**
 * The most attached data the mirror keeps, over all drafts: picture data in base64 characters (~0.75 byte each) and
 * the characters of attached text files alike. Session storage holds about 5 M characters in all, and the text of the
 * drafts must never be what a big picture or file crowds out. Newer drafts get theirs first; a draft whose pictures do
 * not fit is mirrored without them, and the files that do not fit are left out one by one.
 */
export const MAX_PERSISTED_IMAGE_CHARS = 1_500_000;

/** How long after the last change the mirror is written: typing changes the draft on every key. */
export const PERSIST_DELAY_MS = 400;

/**
 * Unsent composer contents per conversation (its session file, or its process before omp has written one; `new`
 * for the new-chat page). The chat page is remounted for every conversation, so the composer's own state would
 * be lost by a look at another one. Kept in memory, and mirrored to session storage once `hydrateDrafts` is given one,
 * so that a reload (⌘R, the automatic one after an upgrade, a killed web view) brings them back; the least recently
 * written go when more than MAX_DRAFTS are held.
 */
const drafts = new Map<string, Draft>();

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
let store: DraftStorage | null = null;
/** The drafts differ from what the mirror holds. */
let dirty = false;
/** Counts the changes: only the write scheduled by the latest one runs, so a burst of keys is one write. */
let scheduled = 0;

export function readDraft(key: string): Draft | undefined {
	return drafts.get(key);
}

/** Keep `draft` under `key`, as the newest; an empty one is forgotten. */
export function keepDraft(key: string, draft: Draft): void {
	drafts.delete(key);
	if (draft.text || draft.images.length || draft.files?.length) {
		drafts.set(key, draft);
		for (const oldest of drafts.keys()) {
			if (drafts.size <= MAX_DRAFTS) break;
			drafts.delete(oldest);
		}
	}
	changed();
}

export function forgetDraft(key: string): void {
	drafts.delete(key);
	changed();
}

/** The conversation `from` is now known as `to` (its process wrote a session file, or moved to another one): its draft follows. */
export function moveDraft(from: string, to: string): void {
	if (from === to) return;
	const d = drafts.get(from);
	if (!d) return;
	drafts.delete(from);
	keepDraft(to, d);
}

function changed(): void {
	if (!store) return;
	dirty = true;
	const mine = ++scheduled;
	setTimeout(() => {
		if (mine === scheduled) flushDrafts();
	}, PERSIST_DELAY_MS);
}

/** The drafts as the mirror keeps them, oldest first: what fits of the pictures and files, newest drafts first. */
function mirrored(): [string, Draft][] {
	let room = MAX_PERSISTED_IMAGE_CHARS;
	const out: [string, Draft][] = [];
	for (const [key, d] of [...drafts].reverse()) {
		const size = d.images.reduce((n, img) => n + img.data.length, 0);
		const fits = size <= room;
		if (fits) room -= size;
		const files: TextAttachment[] = [];
		for (const f of d.files ?? []) {
			if (f.text.length > room) continue;
			room -= f.text.length;
			files.push(f);
		}
		const mirror: Draft = { text: d.text, images: fits ? d.images : [] };
		if (files.length) mirror.files = files;
		out.push([key, mirror]);
	}
	return out.reverse();
}

/**
 * Write the mirror now, if it is behind: the page is going (`pagehide`, hidden) or about to reload. A storage that
 * is full gets the text alone; one that is blocked gets nothing, and the drafts live on in memory.
 */
export function flushDrafts(): void {
	if (!store || !dirty) return;
	dirty = false;
	const all = mirrored();
	try {
		if (all.length) store.setItem(STORAGE_KEY, JSON.stringify(all));
		else store.removeItem(STORAGE_KEY);
	} catch {
		try {
			store.setItem(STORAGE_KEY, JSON.stringify(all.map(([key, d]) => [key, { text: d.text, images: [] }])));
		} catch {
			// Full or blocked even for the text alone: not worth more than the drafts in memory.
		}
	}
}

function isImage(v: unknown): v is ImageAttachment {
	const o = v as Record<string, unknown> | null;
	return (
		typeof o === "object" &&
		o !== null &&
		o.type === "image" &&
		typeof o.data === "string" &&
		typeof o.mimeType === "string" &&
		typeof o.name === "string" &&
		typeof o.id === "string"
	);
}

function isFile(v: unknown): v is TextAttachment {
	const o = v as Record<string, unknown> | null;
	return (
		typeof o === "object" &&
		o !== null &&
		o.type === "text" &&
		typeof o.name === "string" &&
		typeof o.text === "string" &&
		typeof o.id === "string" &&
		typeof o.bytes === "number" &&
		Number.isFinite(o.bytes) &&
		o.bytes >= 0
	);
}

/** What the mirror held, in order; anything that is not a draft of the shape this version writes is left out. */
export function parseDrafts(raw: string | null): [string, Draft][] {
	if (!raw) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const out: [string, Draft][] = [];
	for (const entry of parsed) {
		if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
		const d = entry[1] as { text?: unknown; images?: unknown; files?: unknown } | null;
		if (typeof d?.text !== "string" || !Array.isArray(d.images)) continue;
		const images = d.images.filter(isImage);
		const files = Array.isArray(d.files) ? d.files.filter(isFile) : [];
		if (!d.text && !images.length && !files.length) continue;
		out.push([entry[0], files.length ? { text: d.text, images, files } : { text: d.text, images }]);
	}
	return out;
}

/** Take over the drafts a reload left in `storage`, and mirror every change to it from now on. */
export function hydrateDrafts(storage: DraftStorage): void {
	store = storage;
	dirty = false;
	let raw: string | null = null;
	try {
		raw = storage.getItem(STORAGE_KEY);
	} catch {
		// Blocked: nothing to bring back.
	}
	for (const [key, d] of parseDrafts(raw)) keepDraft(key, d);
	// What was just read is what the mirror holds.
	dirty = false;
}

/** Mirror the drafts to this tab's session storage, and write them out when the page goes away or is hidden. */
export function startDraftPersistence(): void {
	try {
		hydrateDrafts(window.sessionStorage);
	} catch {
		// Session storage is blocked (reading the property throws): drafts stay in memory.
		return;
	}
	window.addEventListener("pagehide", flushDrafts);
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "hidden") flushDrafts();
	});
}
