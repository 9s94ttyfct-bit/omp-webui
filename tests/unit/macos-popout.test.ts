import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guiSkipNotice, guiTests } from "../support/gui-tests.ts";

/**
 * The windows the macOS app pops out for a subagent (macos/popout.swift, #573): `window.open("/?popout#/s/…/agent/…")` in
 * the app's web view opens a real second window with a web view of its own, which can go to native full screen, and which
 * closes without closing the app. The app's own window is the whole app (its close button quits), so a pop-out must not be
 * that window's kind: the harness (tests/support/swift/popout-harness.swift) runs the app's pop-out code in real windows next
 * to a main window that counts the quit requests it gets, and a window with the main window's delegate is its control.
 * Nothing is put in native full screen (that would take the screen of whoever runs the tests): that the window can, and
 * that the page hears of it, is what is checked. The web side is tests/e2e/subagent-full.spec.ts.
 */

const here = import.meta.dir;
const dir = mkdtempSync(join(tmpdir(), "ompw-popout-"));
const harness = join(dir, "popout-harness");
// Real windows and web views on the screen: opt-in (OMPW_GUI_TESTS=1, `bun run test:gui`; tests/support/gui-tests.ts).
guiSkipNotice("macos-popout (pop-out windows)");

/** What the harness reported, once it has been built and run (one run answers every test). */
let report: Report | undefined;

beforeAll(async () => {
	if (!guiTests) return;
	const built = Bun.spawnSync(
		[
			"swiftc",
			"-O",
			"-swift-version",
			"5",
			join(here, "../../macos/navigation.swift"),
			join(here, "../../macos/popout.swift"),
			join(here, "../../macos/webview.swift"),
			join(here, "../../macos/windowframe.swift"),
			join(here, "../support/swift/popout-harness.swift"),
			"-o",
			harness,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (built.exitCode !== 0) throw new Error(`swiftc failed:\n${built.stderr.toString()}`);
	report = await run();
}, 180_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** What the UI's page does: the same document at every address, which says who it is by its address. */
const PAGE = `<!doctype html><title>x</title><script>
window.fsEvents = [];
window.addEventListener("ompw-fullscreen", (e) => window.fsEvents.push(e.detail));
document.title = location.search.includes("popout") ? "popout-page" : "main-page";
window.popOut = () => window.open("/?popout#/s/%2Ftmp%2Fa.jsonl/agent/Scout", "_blank", "popup=yes,width=900,height=700");
window.plain = () => window.open("/other#/s/a");
</script>`;

interface Report {
	pure: Record<string, boolean>;
	popped: {
		windowOpenReturned: boolean;
		opened: boolean;
		url: string;
		title: string;
		closable: boolean;
		resizable: boolean;
		fullScreenPrimary: boolean;
		width: number;
		height: number;
		isOtherWindow: boolean;
		allowsMagnification: boolean;
		hasHandler: string;
		loadedEvents: boolean[];
		fullScreenEvents: boolean[];
		strayMessageWindows: number;
		strayFullScreen: boolean;
	};
	others: { plainIsNull: boolean; fileIsNull: boolean; windowsAfter: number };
	closeByPage: { closed: boolean; mainVisible: boolean; quitRequests: number; windows: number };
	closeByButton: { closed: boolean; windowIsVisible: boolean; mainVisible: boolean; quitRequests: number };
	control: { quitRequests: number; stillVisible: boolean };
	closeAll: { before: number; after: number };
	menuTarget: { popout: boolean; main: boolean; none: boolean };
	toggle: { fromPage: number };
}

async function run(): Promise<Report> {
	const answer = () => new Response(PAGE, { headers: { "content-type": "text/html" } });
	const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: answer });
	// A page of another origin (another port), for what the handler must refuse.
	const other = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: answer });
	try {
		const p = Bun.spawn([harness, `http://127.0.0.1:${server.port}/`, `http://127.0.0.1:${other.port}/`], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err, code] = await Promise.all([
			new Response(p.stdout).text(),
			new Response(p.stderr).text(),
			p.exited,
		]);
		if (code !== 0) throw new Error(`harness exited ${code}: ${err}`);
		return JSON.parse(out.trim().split("\n").pop() as string);
	} finally {
		await server.stop(true);
		await other.stop(true);
	}
}

test.skipIf(!guiTests)("only the page's own request for a window of its own is one", () => {
	const r = report as Report;
	expect(r.pure).toMatchObject({
		popOut: true,
		withOtherParameters: true,
		withValue: true,
		noFlag: false,
		flagInHash: false,
		otherPath: false,
		otherPort: false,
		otherHost: false,
		aboutBlank: false,
		fileScheme: false,
		similarName: false,
		noUrl: false,
		noOrigin: false,
	});
	// Another address of the UI, and a file, open nothing.
	expect(r.others).toEqual({ plainIsNull: true, fileIsNull: true, windowsAfter: 1 });
});

test.skipIf(!guiTests)("window.open of the pop-out address opens a window of its own that shows the page", () => {
	const p = (report as Report).popped;
	expect(p.windowOpenReturned).toBe(true);
	expect(p.opened).toBe(true);
	expect(p.isOtherWindow).toBe(true);
	expect(new URL(p.url).search).toBe("?popout");
	expect(new URL(p.url).hash).toBe("#/s/%2Ftmp%2Fa.jsonl/agent/Scout");
	// Its title follows the page's.
	expect(p.title).toBe("popout-page");
	// The size the page asked for.
	expect(Math.abs(p.width - 900)).toBeLessThanOrEqual(2);
	expect(Math.abs(p.height - 700)).toBeLessThanOrEqual(2);
	// Set up as every web view of the app is: its page is never zoomed (tests/unit/macos-no-zoom.test.ts).
	expect(p.allowsMagnification).toBe(false);
});

test.skipIf(!guiTests)("the window can go to native full screen, and the page hears that it did", () => {
	const p = (report as Report).popped;
	// The green button: a window of its own Space, which needs the full-screen behaviour and a resizable window.
	expect(p.fullScreenPrimary).toBe(true);
	expect(p.resizable).toBe(true);
	expect(p.closable).toBe(true);
	// The page can ask for it, and is told when the window enters and leaves it.
	expect(p.hasHandler).toBe("function");
	expect(p.loadedEvents).toEqual([false]);
	expect(p.fullScreenEvents).toEqual([false, true, false]);
	// A message that is not that request does nothing to the window.
	expect(p.strayMessageWindows).toBe(1);
	expect(p.strayFullScreen).toBe(false);
});

test.skipIf(!guiTests)(
	"closing a pop-out closes that window and neither closes the app's window nor asks to quit",
	() => {
		const r = report as Report;
		// By the page (`window.close()`)…
		expect(r.closeByPage).toEqual({ closed: true, mainVisible: true, quitRequests: 0, windows: 0 });
		// …and by the red button or ⌘W.
		expect(r.closeByButton).toEqual({ closed: true, windowIsVisible: false, mainVisible: true, quitRequests: 0 });
	},
);

test.skipIf(!guiTests)("a window with the app's own delegate asks to quit when it is closed: the control", () => {
	// This is what a pop-out would do if it were the app's window: the measurement above sees it.
	expect((report as Report).control).toEqual({ quitRequests: 1, stillVisible: true });
});

test.skipIf(!guiTests)("the app quitting closes every pop-out", () => {
	expect((report as Report).closeAll).toEqual({ before: 2, after: 0 });
});

test.skipIf(!guiTests)(
	"the full-screen request is the UI's own page's, in its main frame: a frame or another origin is refused",
	() => {
		const r = report as Report;
		expect(r.pure.frameOfThePage).toBe(true);
		expect(r.pure).toMatchObject({
			subframe: false,
			messageOtherPort: false,
			messageOtherHost: false,
			messageOtherScheme: false,
			messageNoOrigin: false,
		});
		// In a real web view the page's own request reaches its window once. A frame and another origin are refused by
		// `isWindowRequestAllowed` (the pure checks above); the handler is not exercised from a frame or another origin here.
		expect(r.toggle).toEqual({ fromPage: 1 });
	},
);

test.skipIf(!guiTests)("the View menu acts on the web view of the window in front, a pop-out's too", () => {
	expect((report as Report).menuTarget).toEqual({ popout: true, main: true, none: true });
});
