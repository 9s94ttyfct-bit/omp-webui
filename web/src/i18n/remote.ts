/**
 * Strings for remote access: the Settings card, the sidebar's indicator and the remote warning above the composer.
 *
 * Only the strings a module of the first page load asks for: `tests/unit/i18n-first-load.test.ts` holds this
 * file to that. The rest are in `remote-later.ts`.
 */
export const en = {
	// The Cloudflare sign-in link, when the AI started the login (it is shown here and never to the AI)
	loginReady: "Cloudflare is waiting for you to sign in.",
	loginOpen: "Open the sign-in page",

	// Sidebar indicator
	indicatorOff: "Remote off",
	indicatorStarting: "Remote starting…",
	indicatorConnected: "Remote connected",
	indicatorError: "Remote not running",
	indicatorTitle: "Remote access: {state}. Settings › Remote access.",
};
