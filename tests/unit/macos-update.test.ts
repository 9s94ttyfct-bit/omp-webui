import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * How the macOS shell hears that the server has an update to install (macos/update.swift, #571): SIGUSR1 means "quit for the
 * update" only while the server's handover record is there, is never fatal on its own (its default action ends a process),
 * and the quit that follows really ends the app. Compiled with the `swiftc` the app is built with, a harness
 * (tests/support/swift/update/main.swift) runs the shell's own `UpdateQuit` inside a real `NSApplication` whose
 * `applicationShouldTerminate` answers `.terminateLater` and replies from a block of the main queue, as the shell does while
 * the server stops. The first version of the shell called `terminate` inside the signal's handler, which is a block of the
 * main queue: `terminate` then waited for a reply that could only come from the queue it was blocking, and the first real
 * update never got past "the app did not quit". The harness's `direct` mode is that version, the control of the measurement.
 */

const here = import.meta.dir;
const dir = mkdtempSync(join(tmpdir(), "ompw-update-quit-"));
const mac = process.platform === "darwin" && Bun.which("swiftc") !== null;
const harness = join(dir, "update-harness");

if (mac) {
	const compiled = Bun.spawnSync(
		[
			"swiftc",
			"-O",
			"-swift-version",
			"5",
			join(here, "../../macos/update.swift"),
			join(here, "../support/swift/update/main.swift"),
			"-o",
			harness,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (compiled.exitCode !== 0) throw new Error(`swiftc failed:\n${compiled.stderr.toString()}`);
}
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Harness = Bun.Subprocess<"ignore", "pipe", "pipe">;

function start(
	data: string,
	...mode: string[]
): { proc: Harness; seen: string[]; saw(line: string, ms?: number): Promise<boolean> } {
	const proc = Bun.spawn([harness, data, ...mode], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	const seen: string[] = [];
	const waiting: { line: string; resolve: (found: boolean) => void }[] = [];
	void (async () => {
		let text = "";
		const decoder = new TextDecoder();
		for await (const chunk of proc.stdout) {
			text += decoder.decode(chunk, { stream: true });
			const complete = text.split("\n");
			text = complete.pop() ?? "";
			for (const line of complete.filter(Boolean)) {
				seen.push(line);
				for (const w of waiting.filter((x) => x.line === line)) w.resolve(true);
			}
		}
		for (const w of waiting) w.resolve(false);
	})();
	return {
		proc,
		seen,
		saw(line, ms = 8000) {
			if (seen.includes(line)) return Promise.resolve(true);
			const { promise, resolve } = Promise.withResolvers<boolean>();
			waiting.push({ line, resolve });
			setTimeout(() => resolve(false), ms);
			return promise;
		},
	};
}

function withHandover(name: string, present: boolean): string {
	const data = join(dir, name);
	mkdirSync(data, { recursive: true });
	if (present) {
		mkdirSync(join(data, "update"), { recursive: true });
		writeFileSync(join(data, "update", "handover.json"), "{}");
	}
	return data;
}

test.skipIf(!mac)(
	"SIGUSR1 without the server's handover record is somebody else's signal: the app neither quits nor dies of it",
	async () => {
		const h = start(withHandover("none", false));
		try {
			expect(await h.saw("ready")).toBe(true);
			process.kill(h.proc.pid, "SIGUSR1");
			// A second signal behind the first: both have been read by the time `ready` is answered again by nothing; the process is up.
			expect(await h.saw("asked", 700)).toBe(false);
			expect(h.proc.exitCode).toBeNull();
			expect(h.seen).toEqual(["ready"]);
		} finally {
			h.proc.kill("SIGKILL");
		}
	},
	30_000,
);

test.skipIf(!mac)(
	"with the record it quits for the update: asked once, the application ends, and the quit is the one that waits for the server",
	async () => {
		const h = start(withHandover("handover", true));
		try {
			expect(await h.saw("ready")).toBe(true);
			process.kill(h.proc.pid, "SIGUSR1");
			expect(await h.saw("quit")).toBe(true);
			expect(await h.proc.exited).toBe(0);
			expect(h.seen).toEqual(["ready", "asked", "quit"]);
		} finally {
			h.proc.kill("SIGKILL");
		}
	},
	30_000,
);

test.skipIf(!mac)(
	"the shell's first way of quitting (terminate inside the signal's handler) never ends the app: the control of the measurement",
	async () => {
		const h = start(withHandover("direct", true), "direct");
		try {
			expect(await h.saw("ready")).toBe(true);
			process.kill(h.proc.pid, "SIGUSR1");
			expect(await h.saw("asked")).toBe(true);
			// 0.3 s is when the reply is sent; ten times that is far past it.
			expect(await h.saw("quit", 3000)).toBe(false);
			expect(h.proc.exitCode).toBeNull();
		} finally {
			h.proc.kill("SIGKILL");
		}
	},
	30_000,
);
