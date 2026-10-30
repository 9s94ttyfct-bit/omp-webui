import { beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { tempDir } from "../support/temp-dirs.ts";

/**
 * The page in the macOS app's windows is never zoomed: the UI is laid out for the window it is in. Every web view the app makes
 * (its own window, a pop-out, a window onto another Mac) is set up by `prepareWebView` (macos/webview.swift), which turns
 * magnification off, so neither a pinch nor a smart zoom (a two-finger double tap) zooms the page; the menu bar
 * (`appMainMenu`, macos/appmenu.swift) has no zoom command, so ⌘= ⌘- ⌘0 reach the page as the keystrokes they are. A
 * browser tab is not concerned: it keeps its browser's zoom.
 *
 * A harness (tests/support/swift/nozoom/main.swift), compiled with the `swiftc` the app is built with, reads the menu bar's
 * keys (anywhere), and hands a pinch, a smart zoom and the three keys to web views in windows that are never shown (a window
 * server session: WKWebView needs one). The control is a web view that allows magnification, as the app's did: the same
 * gestures zoom it.
 */

const here = import.meta.dir;
const dir = tempDir("ompw-nozoom-");
const harness = join(dir, "nozoom-harness");
const mac = process.platform === "darwin" && Bun.which("swiftc") !== null;
// A window server session: a web view needs one, a build on a remote shell or in CI has none.
const aqua = mac && Bun.spawnSync(["launchctl", "managername"]).stdout.toString().trim() === "Aqua";

beforeAll(() => {
	if (!mac) return;
	const built = Bun.spawnSync(
		[
			"swiftc",
			"-O",
			"-swift-version",
			"5",
			join(here, "../../macos/appmenu.swift"),
			join(here, "../../macos/webview.swift"),
			join(here, "../support/swift/nozoom/main.swift"),
			"-o",
			harness,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (built.exitCode !== 0) throw new Error(`swiftc failed:\n${built.stderr.toString()}`);
}, 240_000);

async function run<T>(variant: string): Promise<T> {
	const proc = Bun.spawn([harness, variant], { stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`harness ${variant} exited ${code}: ${err}`);
	return JSON.parse(out) as T;
}

interface MenuKey {
	menu: string;
	title: string;
	key: string;
	command: boolean;
	shift: boolean;
	option: boolean;
	control: boolean;
}

test.skipIf(!mac)("the menu bar has no zoom command: ⌘= ⌘+ ⌘- ⌘0 are no key of it", async () => {
	const { menus, keys } = await run<{ menus: Record<string, string[]>; keys: MenuKey[] }>("menu");
	const zoomKeys = keys.filter((k) => k.command && !k.option && !k.control && ["=", "+", "-", "0"].includes(k.key));
	expect(zoomKeys).toEqual([]);
	expect(menus.View).toEqual(["Reload", "Enter Full Screen"]);
	// What stays: the window's commands, and the editing keys a text field needs.
	expect(menus.Window).toEqual(["Minimize", "Close"]);
	const edit = keys.filter((k) => k.menu === "Edit").map((k) => `${k.shift ? "⇧" : ""}⌘${k.key}`);
	expect(edit).toEqual(["⌘z", "⇧⌘z", "⌘x", "⌘c", "⌘v", "⌘a"]);
	expect(keys.find((k) => k.title === "Reload")).toMatchObject({ key: "r", command: true });
});

interface Zoomed {
	pinch: number;
	smartZoom: number;
	pageZoom: number;
}

test.skipIf(!aqua)(
	"a pinch and a smart zoom leave the app's page at its size; they zoom a web view that allows magnification",
	async () => {
		const r = await run<{ app: Zoomed & { allowsMagnification: boolean }; control: Zoomed }>("gestures");
		expect(r.app).toEqual({ allowsMagnification: false, pinch: 1, smartZoom: 1, pageZoom: 1 });
		// The control: the same gestures, which the measurement sees zoom.
		expect(r.control.pinch).toBeGreaterThan(1.2);
		expect(r.control.smartZoom).toBeGreaterThan(1.2);
	},
	60_000,
);

test.skipIf(!aqua)(
	"⌘= ⌘- ⌘0 reach the page's text field as keystrokes and zoom nothing",
	async () => {
		const r = await run<{ before: string; after: string; keys: string; pageZoom: number; magnification: number }>(
			"keys",
		);
		expect(JSON.parse(r.keys)).toEqual(["meta+=", "meta+-", "meta+0"]);
		expect(JSON.parse(r.after)).toEqual(JSON.parse(r.before));
		expect(JSON.parse(r.after).scale).toBe(1);
		expect(r.pageZoom).toBe(1);
		expect(r.magnification).toBe(1);
	},
	60_000,
);
