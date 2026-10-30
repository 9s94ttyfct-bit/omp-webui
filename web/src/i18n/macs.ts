/**
 * Strings for the sidebar's machine switcher (#628): the row under the New chat button that opens this Mac's page or another Mac's.
 * Like `host`, the namespace is not in `MODULES` of `index.ts`: everything that draws it is a lazy chunk, and its strings travel
 * with the chunk (`lib/macs-strings.ts`, `addStrings`). The zh-CN ones are a chunk of their own.
 */
export const en = {
	thisMac: "This Mac",
	rowAria: "Computer: this Mac, or another Mac to open",
	rowTitle: "Open another Mac's omp-webui",
	menuLabel: "Choose a computer",

	// What is known of each (a Mac's live state comes with a later release: only the last time it was opened is known)
	hereConnected: "Connected",
	hereNotConnected: "Not connected",
	lastConnected: "Last opened {when}",
	neverConnected: "Not opened yet",
	stateRunning: "Running",
	stateAttention: "Needs attention",
	stateUnreachable: "Unreachable",
	stateUnknown: "State not known",

	openTitle: "Open {name} ({host})",
	openFailed: "Could not open {name}: {error}",
	openRefused: "The app did not open that Mac",

	add: "Add Mac…",
	addTitle: "Add a Mac",
	addDetail:
		"The address of another Mac's omp-webui, as it is set up under Settings › Remote access there (https://omp.example.com). It is opened there, signed in through Cloudflare Access.",
	nameLabel: "Name",
	namePlaceholder: "Studio Mac",
	addressLabel: "Address",
	addressPlaceholder: "omp.example.com",
	addSubmit: "Add",
	adding: "Adding…",
	added: "Added {name}",
	addFailed: "Could not add the Mac: {error}",

	// What the list refuses
	problemFull: "At most {n} Macs can be saved",
	problemHostTaken: "That address is saved already, as “{name}”",
	problemNameEmpty: "Give the Mac a name",
	problemNameTooLong: "A name is at most {n} characters",
	problemNameCharacters: "A name cannot hold control or invisible characters",
	problemNameTaken: "Another Mac is called “{name}” already",
	addressEmpty: "Enter the Mac's address, such as omp.example.com",
	addressNotHttps: "The address must be https (or have no scheme at all)",
	addressUserInfo: "The address must not hold a user name or a password",
	addressPort: "The address must not have a port: the tunnel answers on 443",
	addressPath: "The address is a host name only, with no path",
	addressIpAddress: "An IP address is not a Mac's address: use its public host name",
	addressTrailingDot: "The address must not end with a dot",
	addressNotAscii: "Write an international name in its xn-- form",
	addressLocalName:
		"A name only a private network knows (localhost, .local, .lan…) cannot be reached through the tunnel",
	addressAccessDomain: "That is Cloudflare Access's own sign-in address, not a Mac's: use the Mac's host name",
	addressNotDomainName: "That is not a host name such as omp.example.com",
};
