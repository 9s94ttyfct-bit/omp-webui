// needs: posixShell
import { afterEach, expect, test } from "bun:test";
import { PtyManager } from "../../server/pty.ts";
import { pollUntil } from "../support/poll.ts";

/**
 * Ending a terminal (`pty_kill`, a page that leaves) ends what its shell runs, not the shell alone, and nothing beyond its
 * terminal. Before 0.23.1 the shell had no session of its own: it was in the server's process group, with no controlling
 * terminal. A zsh's command then outlived a hangup of the shell (a `remote_run` command that timed out on another computer
 * went on running), and a bash hung up its whole group when it was hung up: this process too (it ended with SIGHUP, on
 * Linux CI). Run here, this test ends with SIGHUP if a terminal's hangup reaches the server.
 */

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const started: number[] = [];
afterEach(() => {
	for (const pid of started.splice(0)) if (alive(pid)) process.kill(pid, "SIGKILL");
});

test("ending a shell's terminal ends the command it is running, in a subshell too", async () => {
	const ptys = new PtyManager("/bin/echo");
	let printed = "";
	const owner = {
		send: (m: unknown) => {
			if (typeof m === "object" && m !== null && "t" in m && m.t === "pty_data")
				printed += (m as unknown as { data: string }).data;
		},
	};
	const id = ptys.open(owner, [], undefined, 120, 30, { shell: true });
	// The marker is written in two parts so that the echo of the typed line never matches it.
	ptys.input(owner, id, ` ( sh -c 'echo "pid""=$$"; exec sleep 9999' ) </dev/null\r`);
	await pollUntil(() => /pid=\d+/.test(printed), "the command to start", 10_000);
	const pid = Number(/pid=(\d+)/.exec(printed)?.[1]);
	started.push(pid);
	expect(alive(pid)).toBe(true);
	ptys.kill(owner, id);
	await pollUntil(() => !alive(pid), `the command (${pid}) to end with its terminal`, 5000);
});
