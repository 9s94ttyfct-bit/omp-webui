import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "bun";

/**
 * The harness behind scripts/app-shots.ts (tests/support/swift/appshots-harness.swift): it photographs a page in a
 * WKWebView that is never shown, set up with the app's own script message handlers, and compares two pictures. Compiled
 * with the `swiftc` the app is built with and run against a page of this test's own: the picture has the size asked for
 * (pixels, whatever the screen's density), the page found the shell's handlers (so it ran in the shell's mode), a picture
 * is never written over one that is there, and the comparison counts the pixels that differ.
 */

const here = import.meta.dir;
const dir = mkdtempSync(join(tmpdir(), "ompw-appshots-"));
const harness = join(dir, "appshots-harness");
// A window server session: WKWebView needs one, a build on a remote shell or in CI has none.
const mac =
	process.platform === "darwin" &&
	Bun.which("swiftc") !== null &&
	Bun.spawnSync(["launchctl", "managername"]).stdout.toString().trim() === "Aqua";

let server: Server<undefined>;

beforeAll(() => {
	if (!mac) return;
	const built = Bun.spawnSync(
		[
			"swiftc",
			"-O",
			"-swift-version",
			"5",
			join(here, "../../macos/notifications.swift"),
			join(here, "../../macos/droppaths.swift"),
			join(here, "../../macos/navigation.swift"),
			join(here, "../../macos/popout.swift"),
			join(here, "../../macos/windowframe.swift"),
			join(here, "../support/swift/appshots-harness.swift"),
			"-o",
			harness,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (built.exitCode !== 0) throw new Error(`swiftc failed:\n${built.stderr.toString()}`);
	// "/" is the token link (as the server's); the pages are a colour each, and say whether the shell's handlers are there.
	server = Bun.serve({
		port: 0,
		fetch(req) {
			const url = new URL(req.url);
			const colour = url.hash === "" && url.pathname === "/" ? "#cc2222" : "#2222cc";
			return new Response(
				`<!doctype html><body style="margin:0;background:${colour}"><script>
				window.inShell = typeof window.webkit?.messageHandlers?.ompwNotify?.postMessage === "function"
					&& typeof window.webkit?.messageHandlers?.ompwDrop?.postMessage === "function"
					&& typeof window.webkit?.messageHandlers?.ompwWindow?.postMessage === "function";
				</script></body>`,
				{ headers: { "content-type": "text/html" } },
			);
		},
	});
});
afterAll(() => {
	server?.stop(true);
	rmSync(dir, { recursive: true, force: true });
});

// Async: the page is served by this process, which a blocking spawn would keep from answering.
async function shoot(name: string, path: string, waitFor: string) {
	const job = join(dir, `${name}.json`);
	writeFileSync(
		job,
		JSON.stringify({
			base: `http://127.0.0.1:${server.port}`,
			token: "t",
			out: dir,
			width: 400,
			height: 300,
			scale: 1,
			timeout: 20,
			settle: 50,
			shots: [{ name, path, waitFor }],
		}),
	);
	const proc = Bun.spawn([harness, "shoot", job], { stdout: "pipe", stderr: "pipe" });
	const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	return { stdout, exitCode };
}

function pngSize(file: string): { width: number; height: number } {
	const png = readFileSync(file);
	return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

test.skipIf(!mac)(
	"a page is photographed at the size asked for, in the shell's mode, and a picture is never replaced",
	async () => {
		const first = await shoot("red", "/", "window.inShell === true");
		expect(first.stdout).toContain('"shot":"red"');
		expect(first.exitCode).toBe(0);
		expect(pngSize(join(dir, "red.png"))).toEqual({ width: 400, height: 300 });

		const again = await shoot("red", "/", "window.inShell === true");
		expect(again.exitCode).toBe(1);
		expect(again.stdout).toContain('"error"');
	},
	60_000,
);

test.skipIf(!mac)(
	"a page that never shows what the shot waits for is an error, not a picture of something else",
	async () => {
		const r = await shoot("never", "/", "window.nothingLikeThis === 1");
		expect(r.exitCode).toBe(1);
		expect(existsSync(join(dir, "never.png"))).toBe(false);
	},
	60_000,
);

test.skipIf(!mac)(
	"the comparison counts the pixels that differ",
	async () => {
		expect((await shoot("blue", "/other", "window.inShell === true")).exitCode).toBe(0);
		const run = (a: string, b: string, out: string) => {
			const r = Bun.spawnSync([harness, "compare", join(dir, a), join(dir, b), join(dir, out), "A", "B"], {
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(r.exitCode).toBe(0);
			return JSON.parse(r.stdout.toString().trim()) as { changed: number; total: number };
		};
		expect(run("red.png", "red.png", "same.png")).toEqual({
			changed: 0,
			total: 120_000,
			width: 400,
			height: 300,
		} as never);
		// Red and blue differ everywhere.
		expect(run("red.png", "blue.png", "diff.png").changed).toBe(120_000);
		// Before | after under their labels: wider and taller than one picture.
		const side = pngSize(join(dir, "diff.png"));
		expect(side.width).toBeGreaterThan(800);
		expect(side.height).toBeGreaterThan(300);
	},
	60_000,
);
