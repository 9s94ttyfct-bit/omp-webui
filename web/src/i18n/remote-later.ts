/**
 * Strings for remote access: the Settings card, the sidebar's indicator and the remote warning above the composer.
 *
 * The strings only code outside the first page load asks for, which `later.ts` registers: a module that uses one
 * imports `later.ts` (`tests/unit/i18n-first-load.test.ts`). The ones the first page asks for are in `remote.ts`.
 */
export const en = {
	// Settings › Remote access
	settingsTitle: "Remote access",
	settingsIntro:
		"Reach this app from anywhere: a Cloudflare tunnel carries https://{hostname} to this Mac, and Cloudflare Access asks who you are before it lets you in.",
	settingsRemoteRefused: "This page is not on the Mac the server runs on, so the tunnel cannot be changed from here.",

	// The state of the tunnel
	stateOff: "Off",
	stateStarting: "Starting…",
	stateConnected: "Connected",
	stateError: "Not running",
	stateLabel: "Tunnel: {state}",
	urlLabel: "Public address",
	urlEmpty: "No hostname yet",
	copyUrl: "Copy the address",
	urlCopied: "Copied",

	// The steps
	stepInstall: "Install cloudflared",
	stepInstallDone: "cloudflared is installed",
	stepLogin: "Log in to Cloudflare",
	stepLoginDone: "Signed in to Cloudflare",
	stepLoginWaiting: "Waiting for the sign-in to finish…",
	loginLink: "Open the sign-in page",
	stepSetup: "Set up the tunnel",
	stepStart: "Start the tunnel",
	stepStop: "Stop the tunnel",

	// The settings
	hostname: "Hostname",
	hostnameHint: "The public name of this app, e.g. omp.example.com",
	team: "Cloudflare team",
	teamHint: "The first part of your Access address (<team>.cloudflareaccess.com)",
	aud: "Application AUD (AUD tag)",
	audHint: "The AUD of the Access application, from the dashboard",
	emails: "Allowed e-mail addresses",
	emailsHint: "One per line. Only these addresses get in.",
	emailsEmpty: "No address yet",
	autostart: "Start the tunnel with the app",

	// Confirm risky commands from remote pages
	confirmRisky: "Confirm risky commands from remote pages",
	confirmRiskyHint:
		"Off by default. When a page that is not on this computer (it came in through the tunnel, or over a network address) sends or steers a turn, a tool call that looks high-risk (sudo, deleting or overwriting outside the project folder, git push --force or reset --hard, a download piped into a shell, broad permission changes, ~/.ssh, ~/.omp or this app's data, launchctl, osascript, tunnels, the remote-access tools) waits for your Allow or Deny on that page before it runs. Everything else runs as the conversation's permission mode says; the mode itself is not changed, and a page on this computer is never asked. A best effort, not a sandbox: it reads the command or path a call carries (the technical documentation, docs/TECHNICAL.md, lists what it looks for).",

	// File transfer from remote pages (#614)
	fileTransfer: "File transfer",
	fileTransferOff: "Off",
	fileTransferDownload: "Download only",
	fileTransferFull: "Download and upload",
	fileTransferHint:
		"What a page that is not on this computer (it came in through the tunnel, or over a network address) may do with the files of a conversation's folder: download files and folders as a ZIP, and upload files and folders into it. Uploads are on by default. Secrets (.env, keys, credentials), links that lead out of the folder, and places like ~/.ssh are never moved, and every transfer is logged in the app's data folder. A page on this computer is not affected.",
	shell: "Let remote pages open a shell",
	shellHint:
		"The panel's Terminal tab is a login shell on this computer, in the conversation's folder. With this on, a page that is not on this computer (through the tunnel, or over a network address) can open one too: whoever gets through has a shell here, and the guard does not see what is typed in it. Turning it off refuses new shells to those pages and ends the ones they have open. A page on this computer is not affected.",

	// Let the AI help
	aiSwitch: "Let the AI help with remote access",
	aiHint:
		"Off by default. In a conversation you start with “Set up with AI”, the agent can read these settings and, as you approve each step, save them, install cloudflared, start the Cloudflare login, set up, start and stop the tunnel, and check the address. It never sees a token or the tunnel's credentials, cannot turn this switch on, and is refused while a page that is not on this computer (through the tunnel, or over a network address) is open on that conversation.",
	aiButton: "Set up with AI",
	aiActiveOne: "The AI has these tools in 1 open conversation.",
	aiActiveMany: "The AI has these tools in {n} open conversations.",

	// Check the address
	checkButton: "Check the address",
	/** Under the tunnel's buttons while setting it up cannot be done yet. */
	setupNeeds: "Setting up the tunnel needs cloudflared installed, the Cloudflare login done and a saved hostname.",

	// What the AI is told at the start of the conversation
	aiPrompt:
		"Help me set up remote access to this app (omp-webui) with a Cloudflare tunnel and Cloudflare Access, step by step, until it works from my other devices.\n\nYou have the remote_access_* tools for this app's remote access: read remote_access_guide first, then remote_access_status. Do the steps you can with the tools. For the steps in the Cloudflare dashboard that you cannot do, tell me exactly where to click, and ask me to paste the hostname, team, AUD and allowed e-mail addresses when you need them. Never ask me for a Cloudflare password or an API token.\n\nWhere things stand now:\n{state}",
	aiStateTools: "- cloudflared installed: {installed}; Cloudflare login done: {login}",
	aiStateSettings: "- hostname: {hostname}; team: {team}; AUD: {aud}; allowed e-mail addresses: {emails}",
	aiStateTunnel: "- tunnel: {state}",
	aiYes: "yes",
	aiNo: "no",
	aiUnset: "not set",
	aiSet: "set",

	// The dashboard guide
	guideTitle: "Create the Access application",
	guideIntro: "In the Cloudflare dashboard, in this order:",
	guideApp: "Zero Trust › Access › Applications › Add an application › Self-hosted",
	guideHostname:
		"Give it the same hostname as above, or a wildcard that covers it (*.example.com): one application then serves every Mac under it, with one AUD tag",
	guidePolicy: "Add a policy: Allow, and the e-mail addresses above",
	guideAud: "Copy the AUD tag from the application and paste it above",
	guideSession:
		"Optional, to sign in about once a month: set the application's Session Duration to 1 month, and Access settings › global session duration to 1 month (both default to 24 hours)",
	guideLink: "Open the Cloudflare dashboard",

	// What went wrong
	actionFailed: "Could not do that: {error}",
	saveFailed: "Could not save the settings: {error}",
	saveDone: "Settings saved",

	// Export and import of the settings a second Mac shares (team, AUD, allowed addresses)
	transferTitle: "Share these settings with another Mac",
	transferHint:
		"One Access application with a wildcard domain (*.example.com) serves every Mac under it. Export the team, the AUD tag and the allowed e-mail addresses here and import them on the other Mac: it then needs only its own hostname. The file holds nothing else (no hostname, no tunnel, no credentials).",
	transferExport: "Export settings",
	transferImport: "Import settings…",
	transferExported: "Saved {name}",
	transferImported:
		"Imported the settings of the file into the form above. Check them, enter this Mac's hostname if it is not there, then Save.",
	transferTooLarge: "That file is too large to be a remote access settings file.",
	transferNotJson: "That file is not JSON.",
	transferNotOurs: "That is not a remote access settings file exported from omp-webui.",
	transferVersion: "That file is from a version of omp-webui this one cannot read.",
	transferEmpty: "That file has no team, AUD tag or e-mail address in it.",
	transferTooMany: "That file lists too many e-mail addresses.",
	transferInvalid: "That file's settings are not valid: {error}",
	transferReadFailed: "Could not read that file: {error}",
};
