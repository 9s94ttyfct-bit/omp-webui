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
 * Save what the page made (`blob`) as `name`, through `startSave`. Its address is revoked at once: the download the
 * click started keeps the blob (checked in Chromium, Playwright's WebKit, and a standalone WKWebView harness that answers
 * downloads as the macOS app's window does and picks the destination 3 s later, with a 30 MB blob; #99).
 */
export function saveBlob(blob: Blob, name: string): void {
	const url = URL.createObjectURL(blob);
	startSave(url, name);
	URL.revokeObjectURL(url);
}
