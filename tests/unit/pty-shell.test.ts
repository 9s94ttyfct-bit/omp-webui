import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PtyManager } from "../../server/pty.ts";
import { pollUntil } from "../support/poll.ts";

/**
 * The panel's Terminal tab (v0.11.18 §8): a login shell in the conversation's folder. Turning shells for remote pages off
 * ends the shells remote pages have open, and only those: a shell of this computer's page and a remote page's `omp`
 * terminal go on.
 */

interface Watched {
	owner: { send: (m: unknown) => void };
	text: () => string;
	exited: () => boolean;
}

function watched(): Watched {
	let out = "";
	let ended = false;
	return {
		owner: {
			send: (m) => {
				const msg = m as { t: string; data?: string };
				if (msg.t === "pty_data") out += msg.data ?? "";
				if (msg.t === "pty_exit") ended = true;
			},
		},
		text: () => out,
		exited: () => ended,
	};
}

test("a shell runs in the folder it is given and takes input", async () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "ompw-shell-")));
	const ptys = new PtyManager("/bin/echo");
	const page = watched();
	try {
		const id = ptys.open(page.owner, [], dir, 80, 24, { shell: true });
		ptys.input(page.owner, id, "echo AT=$PWD\r");
		await pollUntil(() => page.text().includes(`AT=${dir}`), "the shell to print its folder", 10_000);
		ptys.input(page.owner, id, "exit\r");
		await pollUntil(page.exited, "the shell to end", 5000);
	} finally {
		ptys.killAll();
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a shell takes no arguments", () => {
	const ptys = new PtyManager("/bin/echo");
	expect(() => ptys.open(watched().owner, ["-c", "id"], undefined, 80, 24, { shell: true })).toThrow("no arguments");
});

test("turning shells off for remote pages ends a remote page's shell and its omp shell, not this computer's or a remote omp terminal", async () => {
	// `omp` here is `sh`: `-c "sleep 30" <name>` waits, and a terminal whose arguments say `shell` is omp's shell console.
	const ptys = new PtyManager("/bin/sh");
	const remoteShell = watched();
	const remoteOmpShell = watched();
	const localShell = watched();
	const remoteOmp = watched();
	try {
		ptys.open(remoteShell.owner, [], undefined, 80, 24, { shell: true, remote: true });
		ptys.open(remoteOmpShell.owner, ["-c", "sleep 30", "shell"], undefined, 80, 24, { remote: true });
		const local = ptys.open(localShell.owner, [], undefined, 80, 24, { shell: true });
		ptys.open(remoteOmp.owner, ["-c", "sleep 30", "stats"], undefined, 80, 24, { remote: true });
		ptys.killRemoteShells();
		await pollUntil(remoteShell.exited, "the remote page's shell to end", 5000);
		await pollUntil(remoteOmpShell.exited, "the remote page's omp shell to end", 5000);
		// The others are still there: this computer's shell answers.
		ptys.input(localShell.owner, local, "echo STILL-HERE\r");
		await pollUntil(() => localShell.text().includes("STILL-HERE"), "this computer's shell to answer", 10_000);
		expect(localShell.exited()).toBe(false);
		expect(remoteOmp.exited()).toBe(false);
	} finally {
		ptys.killAll();
	}
});

test("another page cannot type into a terminal, size it or end it by its id; its own page can (#682)", async () => {
	const ptys = new PtyManager("/bin/echo");
	const mine = watched();
	const other = watched();
	try {
		const id = ptys.open(mine.owner, [], undefined, 80, 24, { shell: true });
		ptys.input(other.owner, id, "echo HIJACKED\r");
		ptys.resize(other.owner, id, 33, 11);
		ptys.kill(other.owner, id);
		ptys.input(mine.owner, id, "echo SIZE=$(stty size)\r");
		await pollUntil(() => mine.text().includes("SIZE=24 80"), "the owner's own command to run", 10_000);
		expect(mine.text()).not.toContain("HIJACKED");
		expect(mine.exited()).toBe(false);
		expect(other.text()).toBe("");
		ptys.kill(mine.owner, id);
		await pollUntil(mine.exited, "the owner's kill to end it", 5000);
	} finally {
		ptys.killAll();
	}
});
