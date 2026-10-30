/**
 * Where the files dropped on the macOS app's window are. A page is never told: a dropped `File` has a name, a size and its
 * bytes, and no path, in every browser and in the app's WebKit. The app's window (`macos/droppaths.swift`) keeps the file URLs
 * the drag carried, and the page asks for them over the script message handler `ompwDrop` as it handles the drop:
 *
 * - `{ type: "paths" }` is answered with `{ items: [{ name, path, directory, size }] }`, in the order of the drag, once: a
 *   second ask (or one that comes more than fifteen seconds after the drop) is answered with no items.
 *
 * Everything here is inert in a browser: there is no handler, and nothing is asked.
 */

export interface ShellItem {
	name: string;
	/** Where it is on this Mac. */
	path: string;
	directory: boolean;
	/** Bytes of a file; 0 for a folder. */
	size: number;
}

const isItem = (v: unknown): v is ShellItem => {
	const o = v as Record<string, unknown> | null;
	return (
		typeof o === "object" &&
		o !== null &&
		typeof o.name === "string" &&
		typeof o.path === "string" &&
		typeof o.directory === "boolean" &&
		typeof o.size === "number"
	);
};

/** What the app's window kept of the drop that has just been made; nothing in a browser, or when the drag carried no files. */
export async function shellDropItems(): Promise<ShellItem[]> {
	const handler = typeof window === "undefined" ? undefined : window.webkit?.messageHandlers?.ompwDrop;
	if (typeof handler?.postMessage !== "function") return [];
	try {
		const reply = (await handler.postMessage({ type: "paths" })) as { items?: unknown } | null;
		return Array.isArray(reply?.items) ? reply.items.filter(isItem) : [];
	} catch {
		return [];
	}
}
