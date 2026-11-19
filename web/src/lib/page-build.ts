/** Set by the build (`define` in vite.config.ts): the version this page's code was built as. */
declare const __APP_VERSION__: string | undefined;

/** The version this page's code was built as; empty where there is no build (a unit test), which says nothing. */
export const PAGE_VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "";

/**
 * Whether the server runs another version than this page's code: a tab left open across an update is the old build
 * against the new server. False when the page does not know its own version.
 */
export function buildDiffers(server: string, page: string = PAGE_VERSION): boolean {
	return page !== "" && server !== page;
}

/**
 * The version a report names: the server's, and the page's own beside it when the two differ, so that a report from a
 * tab that was never reloaded does not give the new server's version for the old code it runs.
 */
export function versionNamed(server: string, page: string = PAGE_VERSION): string {
	return buildDiffers(server, page) ? `${server} (page ${page})` : server;
}
