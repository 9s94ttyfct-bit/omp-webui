import { expect } from "bun:test";
import { fstatSync, readdirSync } from "node:fs";
import { PtyManager } from "../../server/pty.ts";
import { processIsolatedTests } from "../support/isolated-test.ts";
import { pollUntil } from "../support/poll.ts";

/**
 * The built-in terminal made its pseudo-terminal before it started the process, and left it open when starting threw:
 * four descriptors for each refused `pty_open`, for as long as the server ran (#316).
 */

function openFds(): Set<string> {
	const fds = new Set<string>();
	for (const fd of readdirSync("/dev/fd")) {
		try {
			const stat = fstatSync(Number(fd));
			fds.add(`${fd}:${stat.dev}:${stat.ino}:${stat.mode}:${stat.rdev}`);
		} catch (error) {
			// Reading /dev/fd opens a directory descriptor that is already closed when readdirSync returns.
			if ((error as NodeJS.ErrnoException).code !== "EBADF") throw error;
		}
	}
	return fds;
}

async function expectNoNewFds(before: Set<string>) {
	// Bun can finish closing native/import/IPC descriptors after the JS close returns. Observe the FD table, not a
	// guessed delay. Compare identities so disappearing runtime descriptors cannot mask newly leaked terminals.
	await pollUntil(
		() => [...openFds()].every((fd) => before.has(fd)),
		"the terminal's native descriptors to close",
		2000,
	);
	expect([...openFds()].filter((fd) => !before.has(fd))).toEqual([]);
}
const owner = { send: () => {} };
const ATTEMPTS = 25;

/** /dev/fd measures a whole process, including Bun's worker IPC and cleanup from its preceding file. Own that table. */
const ptyTest = processIsolatedTests(import.meta.path);

ptyTest("a pty_open whose arguments are no list of strings is refused, and leaves no descriptor open", async () => {
	const ptys = new PtyManager("/bin/echo");
	const before = openFds();
	for (const args of [5, "--version", null, { length: 1 }, [1], [["a"]]]) {
		expect(() => ptys.open(owner, args as unknown as string[], undefined, 80, 24)).toThrow("list of strings");
	}
	await expectNoNewFds(before);
});

ptyTest("a process that cannot be started closes its terminal: descriptors do not pile up", async () => {
	// A program name with a NUL byte cannot be started: Bun.spawn throws after the terminal was made.
	const ptys = new PtyManager("/bin/echo\0");
	// One refusal first: whatever the runtime opens once (its own tables) is not what is counted.
	expect(() => ptys.open(owner, ["x"], undefined, 80, 24)).toThrow();
	const before = openFds();
	for (let i = 0; i < ATTEMPTS; i++) expect(() => ptys.open(owner, ["x"], undefined, 80, 24)).toThrow();
	await expectNoNewFds(before);
});

ptyTest("a terminal that starts is closed when its process ends", async () => {
	const ptys = new PtyManager("/bin/echo");
	const ended = Promise.withResolvers<void>();
	const exits: unknown[] = [];
	const watching = {
		send: (m: unknown) => {
			if (typeof m === "object" && m !== null && "t" in m && m.t === "pty_exit") {
				exits.push(m);
				ended.resolve();
			}
		},
	};
	const before = openFds();
	ptys.open(watching, ["hello"], undefined, 80, 24);
	await ended.promise;
	expect(exits).toHaveLength(1);
	// The exit is announced just before the terminal is closed: look once the close has had its turn.
	const turn = Promise.withResolvers<void>();
	setImmediate(turn.resolve);
	await turn.promise;
	await expectNoNewFds(before);
});
