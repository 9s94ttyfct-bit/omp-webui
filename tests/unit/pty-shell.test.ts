// needs: posixShell
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keepPathInFront, PtyManager } from "../../server/pty.ts";
import { isolatedPathPrefix } from "../../shared/isolated-env.ts";
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

test("omp run without a terminal (lines) reads what is typed a line at a time and never shows it", async () => {
	// `omp` here is `sh`: it asks, reads one line and says only how long it was.
	const ptys = new PtyManager("/bin/sh");
	const page = watched();
	try {
		const id = ptys.open(
			page.owner,
			["-c", 'printf "Paste your API key: "; read k; echo "got $(printf %s "$k" | wc -c | tr -d " ") chars"'],
			undefined,
			80,
			24,
			{
				lines: true,
			},
		);
		await pollUntil(() => page.text().includes("Paste your API key: "), "the question", 10_000);
		// A terminal's Enter (a carriage return) ends the line too.
		ptys.input(page.owner, id, "sk-never-shown\r");
		await pollUntil(page.exited, "the answer to be read", 10_000);
		expect(page.text()).toBe("Paste your API key: got 14 chars\r\n");
		expect(() => ptys.open(page.owner, [], undefined, 80, 24, { shell: true, lines: true })).toThrow(
			"needs a terminal",
		);
	} finally {
		ptys.killAll();
	}
});

const bash = Bun.which("bash");

test.skipIf(!bash)(
	"an isolated folder's bash keeps its folders in front, whatever the login files do to PROMPT_COMMAND or PATH; logout and ~/.bash_logout still work",
	async () => {
		const home = realpathSync(mkdtempSync(join(tmpdir(), "ompw-bash-home-")));
		try {
			// A profile that sets PROMPT_COMMAND and PATH whole (a one-time PROMPT_COMMAND hook was lost to the first), and an
			// EXIT trap of its own: it still runs, and ~/.bash_logout after it, as in a login bash.
			writeFileSync(
				join(home, ".bash_profile"),
				'PROMPT_COMMAND="history -a"\nexport PATH="/usr/bin:/bin"\nPROFILE_RAN=yes\ntrap \'echo "mine" >> "$HOME/logged-out"\' EXIT\n',
			);
			writeFileSync(join(home, ".bash_logout"), 'echo bye >> "$HOME/logged-out"\n');
			const { argv, env } = keepPathInFront(bash as string, "/p");
			if (!argv) throw new Error("bash is started with a startup file of its own");
			const proc = Bun.spawn(argv, {
				cwd: home,
				env: { HOME: home, PATH: "/usr/bin:/bin", ...env },
				stdin: new Blob(['echo "P=$PATH R=$PROFILE_RAN I=[$OMPW_ISOLATED_PATH] A=$#"\nlogout\necho after-logout\n']),
				stdout: "pipe",
				stderr: "pipe",
			});
			const out = await new Response(proc.stdout).text();
			expect(await proc.exited).toBe(0);
			expect(out).toContain(`P=${isolatedPathPrefix("/p").join(":")}:/usr/bin:/bin R=yes I=[] A=0`);
			expect(out).not.toContain("after-logout");
			expect(readFileSync(join(home, "logged-out"), "utf8")).toBe("mine\nbye\n");
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	},
);

test("a shell takes no arguments", () => {
	const ptys = new PtyManager("/bin/echo");
	expect(() => ptys.open(watched().owner, ["-c", "id"], undefined, 80, 24, { shell: true })).toThrow("no arguments");
});

test("turning shells off for remote pages ends every terminal a remote page has open, not this computer's", async () => {
	// `omp` here is `sh`: `-c "sleep 30" <name>` waits. omp's console runs `!command`s: any omp terminal is a shell too.
	const ptys = new PtyManager("/bin/sh");
	const remoteShell = watched();
	const remoteOmp = watched();
	const localShell = watched();
	const localOmp = watched();
	try {
		ptys.open(remoteShell.owner, [], undefined, 80, 24, { shell: true, remote: true });
		ptys.open(remoteOmp.owner, ["-c", "sleep 30", "stats"], undefined, 80, 24, { remote: true });
		const local = ptys.open(localShell.owner, [], undefined, 80, 24, { shell: true });
		ptys.open(localOmp.owner, ["-c", "sleep 30", "stats"], undefined, 80, 24);
		ptys.killRemoteTerminals();
		await pollUntil(remoteShell.exited, "the remote page's shell to end", 5000);
		await pollUntil(remoteOmp.exited, "the remote page's omp terminal to end", 5000);
		// The others are still there: this computer's shell answers.
		ptys.input(localShell.owner, local, "echo STILL-HERE\r");
		await pollUntil(() => localShell.text().includes("STILL-HERE"), "this computer's shell to answer", 10_000);
		expect(localShell.exited()).toBe(false);
		expect(localOmp.exited()).toBe(false);
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
