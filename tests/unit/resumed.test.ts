import { expect, test } from "bun:test";
import { resumedSessions } from "../../server/omp/resumed.ts";

/**
 * Which conversations a terminal's `omp` opens again: every form omp 18.12 takes (`-c`, `--continue`, `-r <x>`,
 * `--resume=<x>`, `--restore`, a path, an id prefix or nothing at all), because each of them has the web UI's own omp
 * for that conversation closed first, and any that is missed leaves two processes writing one session.
 */

const CWD = "/work/project";

test("-c and --continue open the newest conversation of the folder the terminal runs in", () => {
	for (const args of [["-c"], ["--continue"], ["--continue", "What did we discuss?"], ["--model", "x", "-c"]])
		expect(resumedSessions(args, CWD)).toEqual([{ by: "folder", cwd: CWD }]);
});

test("--resume names a conversation by its id prefix, as `x` or `=x`", () => {
	for (const args of [["-r", "01a15924"], ["--resume", "01a15924"], ["--resume=01a15924"]])
		expect(resumedSessions(args, CWD)).toEqual([{ by: "id", prefix: "01a15924" }]);
	expect(resumedSessions(["--restore=01a15924"], CWD)).toEqual([{ by: "id", prefix: "01a15924" }]);
});

test("--resume names a conversation by its file; a relative path is the terminal's own folder's", () => {
	expect(resumedSessions(["--resume", "/sessions/a.jsonl"], CWD)).toEqual([{ by: "file", file: "/sessions/a.jsonl" }]);
	expect(resumedSessions(["--restore=/sessions/a.jsonl"], CWD)).toEqual([{ by: "file", file: "/sessions/a.jsonl" }]);
	expect(resumedSessions(["-r", "a.jsonl"], CWD)).toEqual([{ by: "file", file: `${CWD}/a.jsonl` }]);
});

test("--resume with no value lets omp ask: any conversation of the folder may be the one", () => {
	for (const args of [["--resume"], ["-r"], ["--resume="], ["--resume", "--model", "x"], ["-r", "-p"]])
		expect(resumedSessions(args, CWD)).toEqual([{ by: "folder", cwd: CWD }]);
});

test("--cwd moves the folder omp runs in, wherever it stands in the line", () => {
	expect(resumedSessions(["-c", "--cwd=/elsewhere"], CWD)).toEqual([{ by: "folder", cwd: "/elsewhere" }]);
	expect(resumedSessions(["--cwd", "sub", "--resume"], CWD)).toEqual([{ by: "folder", cwd: `${CWD}/sub` }]);
	expect(resumedSessions(["--cwd=/elsewhere", "-r", "a.jsonl"], CWD)).toEqual([
		{ by: "file", file: "/elsewhere/a.jsonl" },
	]);
});

test("every flag that opens a conversation counts", () => {
	expect(resumedSessions(["-c", "--resume", "01a1"], CWD)).toEqual([
		{ by: "folder", cwd: CWD },
		{ by: "id", prefix: "01a1" },
	]);
});

test("a line that opens no old conversation resumes nothing", () => {
	for (const args of [[], ["config", "list"], ["--model", "x", "hello"], ["--no-session"], ["session", "pack"]])
		expect(resumedSessions(args, CWD)).toEqual([]);
});

test("words that are not text are never taken for a flag's value", () => {
	// What a page sends is checked later (`PtyManager.open`); here it only must not throw.
	expect(resumedSessions(["-r", 5] as unknown as string[], CWD)).toEqual([{ by: "folder", cwd: CWD }]);
});
