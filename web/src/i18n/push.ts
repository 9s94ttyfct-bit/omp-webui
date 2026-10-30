/**
 * Strings for Web Push: Settings › Notifications on this device. Like `projects` and `guard`, this namespace is not in
 * `MODULES` of `index.ts`: the card is a lazy chunk and the strings travel with it (`lib/push-strings.ts`, `addStrings`). The
 * zh-CN ones are a chunk of their own, fetched only by a person who reads the page in Chinese.
 */
export const en = {
	title: "Notifications when this page is closed",
	/** The card's name in Settings' index. */
	indexTitle: "Notifications",
	hint: "A phone or computer is told when a conversation finishes or needs you, even with this page closed. The message is encrypted for the one device and names the conversation by its saved title (or just says it is a conversation) and says why: nothing of what was said unless you choose.",
	// This device
	thisDevice: "This device",
	enable: "Notify this device",
	disable: "Stop notifying this device",
	enabling: "Turning on…",
	enabledNote:
		"This device is told by the server when a conversation finishes or needs you and none of its pages is on screen.",
	// Why it cannot be turned on here
	unsupported: "This browser cannot receive notifications when the page is closed.",
	needsApp:
		"On an iPhone or iPad, add this page to the Home Screen first (Share › Add to Home Screen), open it from there, and turn this on in that app. Safari tabs cannot receive notifications.",
	needsHttps:
		"Notifications for a closed page need a secure address (https). Open the app through its remote address (Settings › Remote access).",
	blocked:
		"Notifications are blocked for this site. Allow them in the browser's or the system's settings, then try again.",
	macApp: "The macOS app shows its own notifications; this is for a browser or a Home Screen app.",
	failed: "Could not turn it on: {error}",
	// The devices
	devices: "Devices that are notified",
	none: "No device yet.",
	current: "This device",
	lastSent: "Last sent {when}",
	neverSent: "Nothing sent yet",
	preview: "Show a line of the message",
	previewHint:
		"Off: the notification names the conversation and says it finished or needs you. On: it also shows the question that waits, or the start of the last reply, in what the push service carries (encrypted, but longer).",
	test: "Send a test",
	testSent: "Sent",
	testFailed: "{error}",
	testRefused: "The push service refused it ({status}).",
	testGone: "This device is no longer known to its push service and was removed.",
	testWait: "A test was sent a moment ago. Wait a few seconds and try again.",
	revoke: "Revoke",
	revokeLabel: "Revoke {name}",
	revokeAll: "Revoke all devices",
	revoked: "Revoked",
	loadFailed: "Could not read the devices: {error}",
	changeFailed: "Could not change it: {error}",
	remoteNote: "Through the tunnel, a device is notified only while remote access is on.",
	masterNote: "Notifications must also be on in the card above (it is turned on for you).",
} as const;
