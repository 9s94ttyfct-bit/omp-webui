import { createContext } from "react";
import "../i18n/later.ts";
import { t } from "../i18n/index.ts";
import { isMarkdownPath, openMdEditor } from "../store/md-editor.ts";
import { type FolderScope, folder } from "./folder-api.ts";

/**
 * Opening a `.md` file that rendered Markdown points at, in the Markdown editor (`store/md-editor.ts`). A conversation's
 * messages, the Files tab's rendering of a Markdown file and the editor's own preview each say, through `MdOpenContext`,
 * which conversation they are of and which folder their relative paths start from; a link there to a Markdown file of the
 * conversation's folder is then a button that opens it. Paths are only ever named to the server relative to that folder,
 * which resolves them inside it and refuses the rest (`server/folder.ts`): nothing here widens what can be read.
 */

export interface MdOpen {
	scope: FolderScope;
	/** The conversation's key (`lib/chat-key.ts`): the editor is kept for it. */
	chatKey: string;
	/** The folder relative links start from, relative to the conversation's ("" is that folder itself). */
	base: string;
}

export const MdOpenContext = createContext<MdOpen | null>(null);

/** A path a link names: relative to the conversation's folder, or absolute (resolved against the folder when it is known). */
export type LinkedPath = { kind: "relative"; path: string } | { kind: "absolute"; path: string };

/** `a/b/../c/./d` as `a/c/d`; null when it climbs out of where it starts. */
function normalize(parts: string[]): string | null {
	const out: string[] = [];
	for (const part of parts) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (out.length === 0) return null;
			out.pop();
		} else out.push(part);
	}
	return out.length > 0 ? out.join("/") : null;
}

/**
 * The file a link's address names, or null when it names none: a web or other address, an anchor, a path that climbs out
 * of the folder. `base` is the folder relative paths start from. A fragment, a query and a `:line[:column]` suffix (as
 * agents write paths) are dropped.
 */
export function linkedPath(href: string | undefined, base: string): LinkedPath | null {
	if (!href) return null;
	let raw = href.trim();
	if (/^file:\/\//i.test(raw)) raw = raw.replace(/^file:\/\/(?:localhost)?/i, "");
	else if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//") || raw.startsWith("#")) return null;
	raw = raw.replace(/[?#].*$/, "").replace(/:\d+(?::\d+)?$/, "");
	try {
		raw = decodeURIComponent(raw);
	} catch {
		return null;
	}
	if (raw === "" || raw.startsWith("~") || raw.includes("\\")) return null;
	if (raw.startsWith("/")) return { kind: "absolute", path: raw };
	const path = normalize([...base.split("/"), ...raw.split("/")]);
	return path === null ? null : { kind: "relative", path };
}

/** The Markdown file a link names (see `linkedPath`), or null. */
export function linkedMarkdown(href: string | undefined, base: string): LinkedPath | null {
	const linked = linkedPath(href, base);
	return linked && isMarkdownPath(linked.path) ? linked : null;
}

/**
 * The file of the folder an image of a Markdown file names by a relative path, or null. Only a relative path: the page
 * fetches it from the conversation's folder (`GET /api/folder/raw`, which serves images only, from inside the folder),
 * never from elsewhere.
 */
export function linkedImage(src: string | undefined, base: string): string | null {
	if (src?.trim().toLowerCase().startsWith("file:")) return null;
	const linked = linkedPath(src, base);
	return linked?.kind === "relative" ? linked.path : null;
}

/** `abs` relative to the folder `root`, or null when it is not in it. */
export function insideRoot(abs: string, root: string): string | null {
	const top = root.replace(/\/+$/, "");
	if (!abs.startsWith(`${top}/`)) return null;
	return normalize(abs.slice(top.length + 1).split("/"));
}

/** The conversation's folder as the server resolved it: asked for once per conversation, when an absolute path needs it. */
const roots = new Map<string, Promise<string>>();

function rootOf(open: MdOpen): Promise<string> {
	let root = roots.get(open.chatKey);
	if (!root) {
		root = folder.list(open.scope, "", false, false).then((listing) => listing.root);
		root.catch(() => roots.delete(open.chatKey));
		roots.set(open.chatKey, root);
	}
	return root;
}

/**
 * Open what `linked` names in the editor. An absolute path is opened when it is inside the conversation's folder; otherwise
 * `onOutside` is told (the caller says so where the person is looking).
 */
export async function openLinked(
	open: MdOpen,
	linked: LinkedPath,
	from: Element | null,
	onOutside: (message: string) => void,
): Promise<void> {
	let path: string | null = linked.path;
	if (linked.kind === "absolute") {
		try {
			path = insideRoot(linked.path, await rootOf(open));
		} catch (e) {
			onOutside(e instanceof Error ? e.message : String(e));
			return;
		}
	}
	if (path === null) {
		onOutside(t("chat.mdOpenOutside", { path: linked.path }));
		return;
	}
	openMdEditor(open.chatKey, path, from);
}
