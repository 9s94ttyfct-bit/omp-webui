import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replaceTodos, TodoError, type TodoProcess } from "../../server/omp/todos.ts";

/**
 * Replacing the todo list asks omp to `/todo import` a file. A line omp does not know goes to the model as a prompt, so
 * the command is checked for first; the file is written for omp alone and removed whatever omp says.
 */

const withImport = { data: { commands: [{ name: "todo", subcommands: [{ name: "import" }] }] }, success: true };
const without = { data: { commands: [{ name: "todo", subcommands: [{ name: "copy" }] }] }, success: true };

/** A fake omp that has `catalog` for its commands and answers each command line with `say(line)`. */
function fakeOmp(catalog: { success: boolean; data?: unknown }, say: (line: string) => string | null) {
	const sent: string[] = [];
	const omp: TodoProcess = {
		rpc: async () => catalog,
		command: async (line) => {
			sent.push(line);
			return say(line);
		},
	};
	return { omp, sent };
}

/** The file a `/todo import "<path>"` line names. */
const fileOf = (line: string): string => /^\/todo import "(.+)"$/.exec(line)?.[1] ?? "";

let tmp: string;
const realTmp = process.env.TMPDIR;
beforeEach(() => {
	// A folder with a space in its name: the path is quoted for omp, which strips one pair of double quotes.
	tmp = mkdtempSync(join(realTmp ?? tmpdir(), "ompw todo test-"));
	process.env.TMPDIR = tmp;
});
afterEach(() => {
	if (realTmp === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = realTmp;
	rmSync(tmp, { recursive: true, force: true });
});

test("omp is asked to import a file holding the Markdown, and the file is gone afterwards", async () => {
	let read = "";
	let file = "";
	const { omp, sent } = fakeOmp(withImport, (line) => {
		file = fileOf(line);
		read = readFileSync(file, "utf8");
		return `Imported 1 phase(s), 1 task(s) from ${file}.`;
	});
	await replaceTodos(omp, "# A\n- [ ] x\n");
	expect(sent).toHaveLength(1);
	expect(file).toContain("ompw todo test-");
	expect(read).toBe("# A\n- [ ] x\n");
	expect(existsSync(file)).toBe(false);
});

test("omp's refusal is the error, with the temp file's path replaced, and the file is gone", async () => {
	let file = "";
	const { omp } = fakeOmp(withImport, (line) => {
		file = fileOf(line);
		return `Could not parse ${file}:\n  Line 2: unrecognized syntax "x"`;
	});
	const failure = await replaceTodos(omp, "# A\nx\n").catch((e: unknown) => e);
	expect(failure).toBeInstanceOf(TodoError);
	expect((failure as TodoError).status).toBe(422);
	expect((failure as TodoError).message).toBe('Could not parse the list:\n  Line 2: unrecognized syntax "x"');
	expect(existsSync(file)).toBe(false);
});

test("an omp without /todo import is not asked: its line would go to the model", async () => {
	const old = fakeOmp(without, () => "never");
	await expect(replaceTodos(old.omp, "# A\n")).rejects.toMatchObject({ status: 501 });
	expect(old.sent).toEqual([]);
	const failed = fakeOmp({ success: false }, () => "never");
	await expect(replaceTodos(failed.omp, "# A\n")).rejects.toMatchObject({ status: 501 });
	expect(failed.sent).toEqual([]);
});

test("a command omp does not take, and one that prints nothing, are errors", async () => {
	await expect(replaceTodos(fakeOmp(withImport, () => null).omp, "# A\n")).rejects.toMatchObject({ status: 501 });
	await expect(replaceTodos(fakeOmp(withImport, () => "").omp, "# A\n")).rejects.toMatchObject({ status: 422 });
});

test("a list too long is refused before anything is asked", async () => {
	const { omp, sent } = fakeOmp(withImport, () => "never");
	await expect(replaceTodos(omp, "x".repeat(300 * 1024))).rejects.toMatchObject({ status: 413 });
	expect(sent).toEqual([]);
});
