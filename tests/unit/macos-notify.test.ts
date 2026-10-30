import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLookingAt } from "../../shared/attention.ts";

/**
 * The macOS app's notifications (macos/notifications.swift, #627): the app shows them itself, from the server's own stream
 * (`macos-shell-events.test.ts`), because nothing may depend on a page that is not there while the app runs without a window.
 * What is left for the page is Settings › Notifications, which asks the shell over a script message handler (the app's web view
 * has no usable `Notification`: `requestPermission()` answers "denied" at once, with no prompt) what macOS allows. Compiled with
 * the `swiftc` the app is built with, a harness checks what the page may ask (nothing that shows a notification), what macOS is
 * given for a notification and what a click on it opens, and runs the bridge in a real WKWebView: a page's requests are answered,
 * a request from anywhere but the server's own page is refused, and a click on a notification reaches the page, also when it
 * came before the page was up, and when the window it opens is a fresh page. The harness is a bare executable, so
 * UNUserNotificationCenter stays out of it (it needs an app bundle, and the system's prompt is not something a test can
 * answer): the bridge says "unsupported", as it does without a bundle. The web side of the protocol is tests/e2e/notify-shell.spec.ts.
 */

const here = import.meta.dir;
const dir = mkdtempSync(join(tmpdir(), "ompw-notify-"));
const harness = join(dir, "notify-harness");
// A window server session: WKWebView needs one, a build on a remote shell or in CI has none.
const mac =
	process.platform === "darwin" &&
	Bun.which("swiftc") !== null &&
	Bun.spawnSync(["launchctl", "managername"]).stdout.toString().trim() === "Aqua";

beforeAll(() => {
	if (!mac) return;
	const built = Bun.spawnSync(
		[
			"swiftc",
			"-O",
			"-swift-version",
			"5",
			join(here, "../../macos/notifications.swift"),
			join(here, "../support/swift/notify-harness.swift"),
			"-o",
			harness,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (built.exitCode !== 0) throw new Error(`swiftc failed:\n${built.stderr.toString()}`);
}, 180_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** What the shell's page does: listen for what the shell says, and ask the handler (the web side is `shell-notify.ts`). */
const PAGE = `<!doctype html><title>probe</title><script>
window.events = [];
window.addEventListener("ompw-notification", (e) => window.events.push(e.detail));
window.run = async () => {
	const handler = window.webkit.messageHandlers.ompwNotify;
	const out = {};
	for (const [name, message] of Object.entries({
		status: { type: "status" },
		show: { type: "show", id: "x", title: "t", body: "b", liveId: "L", file: null },
		unknown: { type: "nope" },
		badShow: { type: "show", id: "", title: "t" },
	})) {
		try { out[name] = await handler.postMessage(message); } catch (e) { out[name] = "refused: " + e.message; }
	}
	return out;
};
</script>`;

interface Report {
	pure: {
		status: Record<string, string>;
		parse: string[];
		ownPage: boolean[];
		open: unknown[];
		banners: Record<string, unknown>[];
		remoteBanner: Record<string, unknown>;
		looking: boolean[];
	};
	own: {
		messages: Record<string, unknown>;
		afterStatus: unknown[];
		afterLiveClick: unknown[];
		afterActivation: unknown[];
		reloadedMessages: Record<string, unknown>;
		reloadedEvents: unknown[];
		forwarded: number;
		whileGone: unknown[];
		afterFresh: unknown[];
		forwardedAfterGone: number;
	};
	other: { messages: Record<string, unknown>; events: unknown[] };
}

let report: Report;
beforeAll(async () => {
	if (!mac) return;
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () => new Response(PAGE, { headers: { "content-type": "text/html" } }),
	});
	try {
		const run = Bun.spawn([harness, server.url.href], { stdout: "pipe", stderr: "pipe" });
		const [out, err, code] = await Promise.all([
			new Response(run.stdout).text(),
			new Response(run.stderr).text(),
			run.exited,
		]);
		if (code !== 0) throw new Error(`harness exited ${code}: ${err}`);
		report = JSON.parse(out);
	} finally {
		await server.stop(true);
	}
}, 60_000);

test.skipIf(!mac)("what macOS allows is told in the browser's words", () => {
	// 0 not determined, 1 denied, 2 authorized, 3 provisional.
	expect(report.pure.status).toEqual({
		notDetermined: "default",
		denied: "denied",
		authorized: "granted",
		provisional: "granted",
	});
});

test.skipIf(!mac)(
	"a page may ask what macOS allows, ask for the permission, and say which conversation it shows; it cannot make the app show a notification",
	() => {
		expect(report.pure.parse).toEqual([
			"status",
			"request",
			"nil", // a notification is no request of a page any more, whatever it carries
			"nil",
			"nil",
			"nil",
			"nil",
			// What the page shows (#655): by process and file, either alone, or none (an empty name is none, a name that is no string too).
			"viewing:a|/f",
			"viewing:a|-",
			"viewing:-|/f",
			"viewing:-|-",
			"viewing:-|-",
			"viewing:-|-",
		]);
	},
);

/** The cases of `looking()` in the harness: window in use, what it shows, the conversation notified of. */
const LOOKING: [boolean, { liveId: string | null; file: string | null } | null, string, string | null][] = [
	[true, { liveId: "a", file: "/a" }, "a", "/a"],
	[true, { liveId: "a", file: null }, "a", "/a"],
	[true, { liveId: null, file: "/a" }, "a", "/a"],
	[true, { liveId: "b", file: "/b" }, "a", "/a"],
	[true, null, "a", "/a"],
	[false, { liveId: "a", file: "/a" }, "a", "/a"],
	[true, { liveId: "m", file: null }, "n", null],
	[true, { liveId: null, file: null }, "n", null],
	[true, { liveId: "n", file: null }, "n", null],
];

test.skipIf(!mac)(
	"the app is told who is looking by the page's rule: the same answer to every case of shared/attention.ts",
	() => {
		expect(report.pure.looking).toEqual(
			LOOKING.map(([focused, shown, liveId, file]) => isLookingAt(focused, shown, { liveId, file })),
		);
		// And the table is not all one answer.
		expect(new Set(report.pure.looking)).toEqual(new Set([true, false]));
	},
);

test.skipIf(!mac)(
	"a notification of another Mac's conversation names the Mac under its title and carries which Mac it is",
	() => {
		expect(report.pure.remoteBanner).toEqual({ id: "r", subtitle: "Studio", macId: "mac-1", liveId: "L" });
	},
);

test.skipIf(!mac)(
	"what macOS is given for a notification carries what a click opens, and replaces the conversation's earlier one",
	() => {
		expect(report.pure.banners).toEqual([
			{
				id: "a",
				title: "Fix the build",
				body: "Finished",
				sound: true,
				immediate: true,
				click: { type: "open", liveId: "live-a", file: "/s/a.jsonl" },
			},
			{
				id: "b",
				title: "Fix the build",
				body: "Finished",
				sound: true,
				immediate: true,
				click: { type: "open", liveId: "live-b", file: null },
			},
		]);
	},
);

test.skipIf(!mac)("only the page the app serves may use the bridge: its scheme, host and port", () => {
	expect(report.pure.ownPage).toEqual([true, false, false, false, false]);
});

test.skipIf(!mac)("a click names the conversation to open by its process and its file, whichever it has", () => {
	expect(report.pure.open).toEqual([
		{ type: "open", liveId: "L", file: "/f" },
		{ type: "open", liveId: "L", file: null },
		{ type: "open", liveId: null, file: "/f" },
		"nil",
	]);
});

test.skipIf(!mac)(
	"a page's permission requests are answered, and what is not one (a notification to show included) is refused",
	() => {
		expect(report.own.messages).toEqual({
			status: { permission: "unsupported" },
			show: "refused: Unknown request.",
			unknown: "refused: Unknown request.",
			badShow: "refused: Unknown request.",
		});
	},
);

test.skipIf(!mac)("a click that came before the page was up reaches it once it says it is, later ones at once", () => {
	const cold = { type: "open", liveId: "L-cold", file: "/s/cold.jsonl" };
	const live = { type: "open", liveId: "L-live", file: null };
	expect(report.own.afterStatus).toEqual([cold]);
	expect(report.own.afterLiveClick).toEqual([cold, live]);
	// Coming back to the app tells the page what macOS allows now.
	expect(report.own.afterActivation).toEqual([cold, live, { type: "permission", permission: "unsupported" }]);
	// A click while the page reloads waits for the page that comes next: the one that was up is gone.
	expect(report.own.reloadedMessages).toEqual(report.own.messages);
	expect(report.own.reloadedEvents).toEqual([{ type: "open", liveId: null, file: "/s/reload.jsonl" }]);
	// Every click opens the window.
	expect(report.own.forwarded).toBe(3);
});

test.skipIf(!mac)(
	"a click when the window and its page are gone opens the window and waits for the fresh page, not the old one",
	() => {
		// Run in Background closed the window: nothing is told to a page that is not there (the one still loaded here stands for it).
		expect(report.own.whileGone).toEqual([]);
		// The page the window opens says it is up, and is told which conversation the click was for.
		expect(report.own.afterFresh).toEqual([{ type: "open", liveId: "L-away", file: "/s/away.jsonl" }]);
		// The click is what opens the window.
		expect(report.own.forwardedAfterGone).toBe(4);
	},
);

test.skipIf(!mac)("a page at any other origin than the server's gets nothing and hears nothing", () => {
	const refused = "refused: Not available to this page.";
	expect(report.other.messages).toEqual({ status: refused, show: refused, unknown: refused, badShow: refused });
	expect(report.other.events).toEqual([]);
});
