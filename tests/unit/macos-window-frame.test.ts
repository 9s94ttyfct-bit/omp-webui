import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Where the macOS app puts its window (macos/windowframe.swift): the frame the person left is put back when it still fits
 * the screens there are now, and otherwise the window goes where it would the first time. Compiled with the `swiftc` the
 * app is built with; the harness (tests/support/swift/windowframe/main.swift) asks about made-up screens and a defaults
 * suite of its own. No window, no window server.
 */

const here = import.meta.dir;
const dir = mkdtempSync(join(tmpdir(), "ompw-windowframe-"));
const mac = process.platform === "darwin" && Bun.which("swiftc") !== null;

afterAll(() => rmSync(dir, { recursive: true, force: true }));

test.if(mac)(
	"a saved frame comes back only where it can be seen and grabbed",
	() => {
		const harness = join(dir, "windowframe-harness");
		const built = Bun.spawnSync(
			[
				"swiftc",
				"-swift-version",
				"5",
				join(here, "../../macos/windowframe.swift"),
				join(here, "../support/swift/windowframe/main.swift"),
				"-o",
				harness,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		expect(built.stderr.toString()).not.toContain("error:");
		expect(built.exitCode).toBe(0);
		const run = Bun.spawnSync([harness], { stdout: "pipe", stderr: "pipe" });
		expect(run.exitCode).toBe(0);
		const r = JSON.parse(run.stdout.toString()) as Record<string, number[] | null>;
		// On the screen: as it was left.
		expect(r.onScreen).toEqual([100, 80, 1300, 820]);
		// On a second display: kept while that display is there, not when it was unplugged.
		expect(r.onSecond).toEqual([1700, 200, 1600, 1000]);
		expect(r.secondGone).toBeNull();
		// Its title bar above the screen (nothing to drag it by), or smaller than the window may be: not put back.
		expect(r.titleBarOff).toBeNull();
		expect(r.tooSmall).toBeNull();
		// What is kept reads back; nothing, or text that is no frame, is no frame.
		expect(r.parsed).toEqual([12, 34, 1280, 840]);
		expect(r.parsedEmpty).toBeNull();
		expect(r.parsedJunk).toBeNull();
		expect(r.sizeBefore).toBeNull();
		expect(r.sizeAfter).toEqual([1300, 800]);
	},
	120_000,
);
