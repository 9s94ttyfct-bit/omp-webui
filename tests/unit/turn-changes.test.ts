import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "../../shared/protocol.ts";
import { toolResultsById } from "../../web/src/lib/messages.ts";
import { relativeIn, turnEdits } from "../../web/src/lib/turn-changes.ts";

const msg = (id: string, parentId: string | null, message: Record<string, unknown>) =>
	({ type: "message", id, parentId, timestamp: "2026-01-01T00:00:00.000Z", message }) as unknown as SessionEntry;
const call = (id: string, name: string, args: Record<string, unknown>) => ({
	type: "toolCall",
	id,
	name,
	arguments: args,
});
const assistant = (id: string, parent: string, ...calls: ReturnType<typeof call>[]) =>
	msg(id, parent, { role: "assistant", content: calls });
const result = (id: string, parent: string, toolCallId: string, details: unknown, isError = false) =>
	msg(id, parent, { role: "toolResult", toolCallId, toolName: "x", content: [], details, isError });
const turns = (entries: SessionEntry[]) => turnEdits(entries, toolResultsById(entries));

describe("what each turn of a conversation changed", () => {
	test("the files omp's edit and write calls changed, turn by turn, from the first prompt on", () => {
		const entries = [
			msg("u1", null, { role: "user", content: "add the parser\nand its test" }),
			assistant("a1", "u1", call("c1", "write", { path: "src/parse.ts" }), call("c2", "edit", { path: "src/main.ts" })),
			result("r1", "a1", "c1", { path: "src/parse.ts" }),
			result("r2", "r1", "c2", { path: "src/main.ts" }),
			msg("u2", "r2", { role: "user", content: "now the docs" }),
			assistant("a2", "u2", call("c3", "edit", { path: "README.md" })),
			result("r3", "a2", "c3", { path: "README.md" }),
		];
		expect(turns(entries)).toEqual([
			{ id: "u1", number: 1, label: "add the parser", files: [{ path: "src/parse.ts" }, { path: "src/main.ts" }] },
			{ id: "u2", number: 2, label: "now the docs", files: [{ path: "README.md" }] },
		]);
	});

	test("a call that failed, never answered, or is not an edit changed nothing; a turn of such calls is not listed", () => {
		const entries = [
			msg("u1", null, { role: "user", content: "try" }),
			assistant(
				"a1",
				"u1",
				call("c1", "edit", { path: "bad.ts" }),
				call("c2", "write", { path: "pending.ts" }),
				call("c3", "bash", { command: "touch made-by-bash.ts" }),
			),
			result("r1", "a1", "c1", { path: "bad.ts" }, true),
			result("r3", "r1", "c3", {}),
		];
		expect(turns(entries)).toEqual([]);
	});

	test("a file a turn changed twice is listed once, and a moved file says where it was", () => {
		const entries = [
			msg("u1", null, { role: "user", content: "rename" }),
			assistant(
				"a1",
				"u1",
				call("c1", "edit", { path: "a.ts" }),
				call("c2", "edit", { path: "a.ts" }),
				call("c3", "edit", { path: "old.ts" }),
			),
			result("r1", "a1", "c1", { path: "a.ts" }),
			result("r2", "r1", "c2", { path: "a.ts" }),
			result("r3", "r2", "c3", { perFileResults: [{ path: "old.ts", move: "new.ts" }] }),
		];
		expect(turns(entries)[0]?.files).toEqual([{ path: "a.ts" }, { path: "new.ts", from: "old.ts" }]);
	});

	test("a command the user ran ends a turn, and a conversation that starts with a reply has a first turn without a label", () => {
		const entries = [
			assistant("a0", "root", call("c0", "write", { path: "first.ts" })),
			result("r0", "a0", "c0", { path: "first.ts" }),
			msg("b1", "r0", { role: "bashExecution", command: "echo hi", output: "hi\n", exitCode: 0 }),
			assistant("a1", "b1", call("c1", "write", { path: "second.ts" })),
			result("r1", "a1", "c1", { path: "second.ts" }),
		];
		expect(turns(entries).map((t) => [t.number, t.label, t.files.map((f) => f.path)])).toEqual([
			[1, "", ["first.ts"]],
			[2, "", ["second.ts"]],
		]);
	});

	test("a long first line of a prompt is cut to a label", () => {
		const entries = [
			msg("u1", null, { role: "user", content: `\n  ${"x".repeat(200)}\nsecond line` }),
			assistant("a1", "u1", call("c1", "write", { path: "x.ts" })),
			result("r1", "a1", "c1", { path: "x.ts" }),
		];
		const label = turns(entries)[0]?.label ?? "";
		expect(label.length).toBe(90);
		expect(label.endsWith("…")).toBe(true);
	});
});

describe("a path as a path inside a folder", () => {
	const roots = ["/work/project", "/private/work/project/"];

	test("an absolute path under either spelling of the folder is relative to it", () => {
		expect(relativeIn(roots, "/work/project/src/a.ts")).toBe("src/a.ts");
		expect(relativeIn(roots, "/private/work/project/src/a.ts")).toBe("src/a.ts");
	});

	test("a path elsewhere, the folder itself, and one that climbs are not inside it", () => {
		expect(relativeIn(roots, "/work/other/a.ts")).toBeNull();
		expect(relativeIn(roots, "/work/project-two/a.ts")).toBeNull();
		expect(relativeIn(roots, "/work/project")).toBeNull();
		expect(relativeIn(roots, "../a.ts")).toBeNull();
		expect(relativeIn(roots, "src/../../a.ts")).toBeNull();
		expect(relativeIn(roots, "~/a.ts")).toBeNull();
		expect(relativeIn(roots, "")).toBeNull();
	});

	test("a relative path is tidied", () => {
		expect(relativeIn(roots, "./src//a.ts")).toBe("src/a.ts");
	});
});
