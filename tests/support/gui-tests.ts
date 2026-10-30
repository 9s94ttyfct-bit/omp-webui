/**
 * Tests that open real windows on the Mac they run on: the macOS shell's Run in Background, which changes the harness's activation
 * policy and puts an icon in the menu bar (`macos-background`), its pop-out windows, one of which goes to native full screen
 * (`macos-popout`), and its pending-quit question, a modal panel (`macos-quit`). They are not part of the default suite or of the
 * release gate (`bun run test`, `test:all`, `test:release`): they put windows and icons on the screen of whoever is using the Mac, some of them ask
 * the system to make the harness the active app, and what they find depends on which app is in front and on what else the machine
 * is doing (a request to become the active app is refused when another app is in front; more so when several run at once under
 * `--parallel`).
 *
 * `OMPW_GUI_TESTS=1` turns them on, in a window server session with `swiftc`; `bun run test:gui` runs them, one file after the
 * other. Run them on an awake, unlocked Mac with nothing else in front and nobody typing.
 */
const darwin = process.platform === "darwin";
const optedIn = process.env.OMPW_GUI_TESTS === "1";
const windowServer =
	darwin &&
	Bun.which("swiftc") !== null &&
	Bun.spawnSync(["launchctl", "managername"]).stdout.toString().trim() === "Aqua";

/** Whether the real-window tests run: asked for, and this is a Mac that can show windows. */
export const guiTests = optedIn && windowServer;

/** Say why a file's real-window tests are skipped, once, on a Mac (where a person runs the suite), so that a skip is never silent. */
export function guiSkipNotice(file: string): void {
	if (!darwin || guiTests) return;
	const why = optedIn
		? "this is not a window server session with swiftc"
		: "OMPW_GUI_TESTS=1 is not set (bun run test:gui)";
	console.log(`${file}: tests that open real windows are skipped: ${why}`);
}
