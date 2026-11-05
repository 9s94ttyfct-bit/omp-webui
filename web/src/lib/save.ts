/**
 * Hand an address to the browser to save: a link with `download`, clicked. The macOS app's window turns this into its
 * own save panel (a `fetch` and a `Blob` would hold the whole file in memory and give it no panel at all).
 */
export function startSave(url: string, name: string): void {
	const link = document.createElement("a");
	link.href = url;
	link.download = name;
	link.rel = "noopener";
	link.style.display = "none";
	document.body.append(link);
	link.click();
	link.remove();
}

/**
 * Save what the page made (`blob`) as `name`, through `startSave`. Its address stays valid for a minute: WebKit (Safari,
 * the macOS app) decides on the download after the click has returned, and an address revoked at once can leave that
 * download nothing to read.
 */
export function saveBlob(blob: Blob, name: string): void {
	const url = URL.createObjectURL(blob);
	startSave(url, name);
	setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
