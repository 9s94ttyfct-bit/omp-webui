// needs: posixShell
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	parseRemoteRun,
	parseRemoteRunArgs,
	REMOTE_RUN_OUTPUT_TAIL,
	REMOTE_RUN_TIMEOUT_S,
	REMOTE_RUN_TOOL,
	remoteRunLine,
	remoteRunTool,
	tailOutput,
} from "../../shared/remote-run.ts";

/**
 * The line `remote_run` types into a remote computer's login shell, and how what the shell prints is read back: run here
 * through real shells (`sh`, `bash`, `zsh` where there is one), so that what is asserted is what a shell does with it.
 */

const NONCE = "a1b2c3d4e5f6";
const scratch = mkdtempSync(join(tmpdir(), "ompw-remote-run-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const SHELLS = ["/bin/sh", "/bin/bash", "/bin/zsh"].filter((s) => Bun.file(s).size > 0);

/** What a shell prints for the line, as the pty would carry it (stdout and stderr together), and its parse. */
function run(shell: string, command: string, cwd: string | null) {
	const line = remoteRunLine(command, cwd, NONCE);
	const out = Bun.spawnSync([shell, "-c", `exec 2>&1; ${line.slice(0, -1)}`], {
		cwd: scratch,
		env: { ...process.env, HOME: scratch },
		stdin: "ignore",
	});
	const raw = out.stdout.toString();
	return parseRemoteRun(raw, NONCE);
}

describe("remoteRunLine", () => {
	test("is one line typed into the shell: a leading space, no line break inside, ending in a carriage return", () => {
		const line = remoteRunLine("echo one\necho two", "/srv/app", NONCE);
		expect(line.startsWith(" ")).toBe(true);
		expect(line.endsWith("\r")).toBe(true);
		expect(line.slice(0, -1)).not.toMatch(/[\r\n]/);
	});

	test("its markers are spelled apart, so the shell's echo of the line never reads as one", () => {
		const line = remoteRunLine("true", null, NONCE);
		expect(line).not.toContain(`B${NONCE}X`);
		expect(line).not.toContain(`E${NONCE}X`);
		expect(line).toContain(`"B${NONCE}""X"`);
		expect(line).toContain(`"E${NONCE}""X"`);
	});

	for (const shell of SHELLS) {
		describe(shell, () => {
			test("runs a command with quotes, $ and && exactly as given", () => {
				const r = run(shell, `echo "a b" && printf '%s' "$HOME" | wc -c | tr -d ' '`, null);
				expect(r).toEqual({ done: true, output: `a b\n${scratch.length}\n`, exitCode: 0 });
			});

			test("runs a multi-line heredoc with non-ASCII text", () => {
				const command = "cat <<'EOF'\n你好 $HOME `x`\nline two\nEOF\necho 你好";
				const r = run(shell, command, null);
				expect(r).toEqual({ done: true, output: "你好 $HOME `x`\nline two\n你好\n", exitCode: 0 });
			});

			test("gives the command's exit code, and `exit` ends the command, not the shell", () => {
				expect(run(shell, "false", null)).toEqual({ done: true, output: "", exitCode: 1 });
				expect(run(shell, "echo before; exit 3", null)).toEqual({ done: true, output: "before\n", exitCode: 3 });
			});

			test("output without a final line break is kept as it is", () => {
				expect(run(shell, "printf done", null)).toEqual({ done: true, output: "done", exitCode: 0 });
			});

			test("runs in cwd, with a single quote in its name", () => {
				const dir = join(scratch, "it's here");
				Bun.spawnSync(["mkdir", "-p", dir]);
				expect(run(shell, "pwd", dir)).toEqual({ done: true, output: `${dir}\n`, exitCode: 0 });
			});

			test("a cwd that does not exist fails with the shell's error, and the command does not run", () => {
				const r = run(shell, "echo ran", join(scratch, "nope"));
				expect(r.done).toBe(true);
				expect(r.exitCode).not.toBe(0);
				expect(r.output).toContain("nope");
				expect(r.output).not.toContain("ran");
			});

			test("a command that reads its input gets none and ends", () => {
				expect(run(shell, "cat; echo end", null)).toEqual({ done: true, output: "end\n", exitCode: 0 });
			});
		});
	}
});

describe("parseRemoteRun", () => {
	test("reads past the shell's echo and the terminal's escapes", () => {
		const echo = ` printf '%s\\n' "B${NONCE}""X"; ( eval "$(printf %s 'ZWNobyBoaQ==' | base64 -d)" ) </dev/null; printf '\\n%s %s\\n' "E${NONCE}""X" "$?"`;
		const raw = `\u001b]2;title\u0007% ${echo}\r\n\u001b[?2004l\r\r\nB${NONCE}X\r\n\u001b[1;32mhi\u001b[0m\r\n\r\nE${NONCE}X 0\r\n\u001b[?2004h% `;
		expect(parseRemoteRun(raw, NONCE)).toEqual({ done: true, output: "hi\n", exitCode: 0 });
	});

	test("partial input is not done, and gives the output so far", () => {
		expect(parseRemoteRun("% typing", NONCE)).toEqual({ done: false, output: "", exitCode: null });
		expect(parseRemoteRun(`\r\nB${NONCE}X\r\nline 1\r\nline`, NONCE)).toEqual({
			done: false,
			output: "line 1\nline",
			exitCode: null,
		});
		// The end marker without its line break may still be growing (`E…X 1` of `E…X 12`).
		expect(parseRemoteRun(`B${NONCE}X\r\nout\r\n\r\nE${NONCE}X 1`, NONCE)).toEqual({
			done: false,
			output: "out\n",
			exitCode: null,
		});
	});

	test("a marker of another nonce is output", () => {
		const raw = `B${NONCE}X\nBotherX\nEotherX 0\n\nE${NONCE}X 2\n`;
		expect(parseRemoteRun(raw, NONCE)).toEqual({ done: true, output: "BotherX\nEotherX 0\n", exitCode: 2 });
	});
});

describe("tailOutput", () => {
	test("keeps text up to the limit, and the last part of longer text", () => {
		expect(tailOutput("abc", 5)).toEqual({ text: "abc", cut: false });
		expect(tailOutput("abcdefgh", 5)).toEqual({ text: "defgh", cut: true });
		expect(tailOutput("x".repeat(REMOTE_RUN_OUTPUT_TAIL + 10)).text.length).toBe(REMOTE_RUN_OUTPUT_TAIL);
	});

	test("never starts with half a character", () => {
		const cut = tailOutput("a😀b", 2);
		expect(cut).toEqual({ text: "b", cut: true });
	});
});

describe("the tool", () => {
	test("names the computers in an enum and in its description", () => {
		const tool = remoteRunTool(["Server1", "Build box"]);
		expect(tool.name).toBe(REMOTE_RUN_TOOL);
		expect(tool.loadMode).toBe("essential");
		expect(tool.parameters).toMatchObject({
			properties: { computer: { enum: ["Server1", "Build box"] } },
			required: ["computer", "command"],
		});
		expect(tool.description).toContain("Server1");
		expect(tool.description).toContain("Build box");
	});

	test("arguments: a known computer and a command; timeout clamped, cwd optional", () => {
		const computers = ["Server1"];
		expect(parseRemoteRunArgs({ computer: "Server1", command: "ls" }, computers)).toEqual({
			computer: "Server1",
			command: "ls",
			cwd: null,
			timeoutS: REMOTE_RUN_TIMEOUT_S.default,
		});
		expect(parseRemoteRunArgs({ computer: "Server1", command: "ls", cwd: "/srv", timeout: 99999 }, computers)).toEqual({
			computer: "Server1",
			command: "ls",
			cwd: "/srv",
			timeoutS: REMOTE_RUN_TIMEOUT_S.max,
		});
		expect(parseRemoteRunArgs({ computer: "Server1", command: "ls", timeout: 0 }, computers)).toMatchObject({
			timeoutS: 1,
		});
		expect(parseRemoteRunArgs({ computer: "Server1", command: "ls", cwd: "" }, computers)).toMatchObject({ cwd: null });
	});

	test("arguments that are refused", () => {
		const computers = ["Server1"];
		const refused = (args: unknown) => "error" in parseRemoteRunArgs(args, computers);
		expect(refused(null)).toBe(true);
		expect(refused({ computer: "Other", command: "ls" })).toBe(true);
		expect(refused({ computer: "Server1", command: "" })).toBe(true);
		expect(refused({ computer: "Server1", command: "   " })).toBe(true);
		expect(refused({ computer: "Server1" })).toBe(true);
		expect(refused({ computer: "Server1", command: "ls", cwd: "/a\nb" })).toBe(true);
		expect(refused({ computer: "Server1", command: "ls", timeout: "soon" })).toBe(true);
		const unknown = parseRemoteRunArgs({ computer: "Other", command: "ls" }, computers);
		expect("error" in unknown && unknown.error).toContain("Server1");
	});
});
