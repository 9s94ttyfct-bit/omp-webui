import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ompDirs } from "../../server/omp/dirs.ts";

const root = mkdtempSync(join(tmpdir(), "ompw-omp-dirs-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("omp's XDG folders hold the conversations on Linux and macOS, and omp ignores them on Windows", () => {
	const home = join(root, "home");
	const xdg = join(root, "xdg");
	mkdirSync(join(xdg, "omp"), { recursive: true });
	const env = { XDG_DATA_HOME: xdg, XDG_STATE_HOME: xdg };
	for (const platform of ["linux", "darwin"] as const) {
		const dirs = ompDirs(env, home, undefined, platform);
		expect(dirs.sessionsDir).toBe(join(xdg, "omp", "sessions"));
		expect(dirs.memoriesDir).toBe(join(xdg, "omp", "memories"));
	}
	// omp 18.22 and 19 alike: `xdgPlatform` is Linux and macOS only, so a Windows omp writes under its own agent folder.
	const win = ompDirs(env, home, undefined, "win32");
	expect(win.sessionsDir).toBe(join(home, ".omp", "agent", "sessions"));
	expect(win.memoriesDir).toBe(join(home, ".omp", "agent", "memories"));
});
