import { describe, expect, test } from "bun:test";
import { buildRows, type RowConversation } from "../../server/disk-space/rows.ts";

/**
 * Which projects the Disk space page lists, and whose conversations each holds
 * (docs/superpowers/specs/2026-11-26-disk-space-page-design.md, "Which rows"). Paths are made up; links and gone folders
 * are a map the test gives `realOf`.
 */

const HOME = "/u/me";
const PF = "/u/me/omp";
const PROTECTED = new Set([HOME, "/u", "/"]);

function rows(
	subfolders: string[],
	conversations: [file: string, cwd: string][],
	links: Record<string, string | null> = {},
	projectsFolder: string | null = PF,
) {
	const list: RowConversation[] = conversations.map(([file, cwd]) => ({ file, cwd, title: file, modifiedAt: 1 }));
	return buildRows({
		projectsFolder,
		subfolders,
		conversations: list,
		realOf: (p) => (p in links ? links[p] : p),
		isProtected: (real) => PROTECTED.has(real),
	});
}

describe("buildRows", () => {
	test("each subfolder of the projects folder is a row, with or without conversations", () => {
		expect(rows([`${PF}/a`, `${PF}/b`], [])).toEqual([
			{ folder: `${PF}/a`, real: `${PF}/a`, kind: "project", files: [] },
			{ folder: `${PF}/b`, real: `${PF}/b`, kind: "project", files: [] },
		]);
	});

	test("a conversation in a project subfolder or deeper belongs to that row", () => {
		const r = rows([`${PF}/a`], [["c1", `${PF}/a/src`]]);
		expect(r).toEqual([{ folder: `${PF}/a`, real: `${PF}/a`, kind: "project", files: ["c1"] }]);
	});

	test("a conversation whose folder is a link to a project folder belongs to that project", () => {
		const r = rows([`${PF}/a`], [["c1", "/elsewhere/link"]], { "/elsewhere/link": `${PF}/a` });
		expect(r).toEqual([{ folder: `${PF}/a`, real: `${PF}/a`, kind: "project", files: ["c1"] }]);
	});

	test("other folders are rows; one inside another rolls up into the outermost", () => {
		const r = rows(
			[],
			[
				["c2", "/x/p/q"],
				["c1", "/x/p"],
			],
		);
		expect(r).toEqual([{ folder: "/x/p", real: "/x/p", kind: "other", files: ["c2", "c1"] }]);
	});

	test("protected folders and the projects folder (and above it) keep only their own conversations", () => {
		const r = rows(
			[],
			[
				["home", HOME],
				["pf", PF],
				["code", `${HOME}/code/r`],
			],
			{},
			`${HOME}/omp`,
		);
		expect(r).toEqual([
			{ folder: HOME, real: HOME, kind: "protected", files: ["home"] },
			{ folder: `${HOME}/code/r`, real: `${HOME}/code/r`, kind: "other", files: ["code"] },
			{ folder: PF, real: PF, kind: "protected", files: ["pf"] },
		]);
		// A folder above a custom projects folder is protected-like too, and a project inside it stays its own row.
		const custom = rows(
			["/d/omp/a"],
			[
				["above", "/d"],
				["a", "/d/omp/a"],
			],
			{},
			"/d/omp",
		);
		expect(custom).toEqual([
			{ folder: "/d", real: "/d", kind: "protected", files: ["above"] },
			{ folder: "/d/omp/a", real: "/d/omp/a", kind: "project", files: ["a"] },
		]);
	});

	test("a folder that is gone stays a row while it has conversations", () => {
		expect(rows([], [["c1", "/gone/x"]], { "/gone/x": null })).toEqual([
			{ folder: "/gone/x", real: null, kind: "other", files: ["c1"] },
		]);
	});

	test("each conversation is in exactly one row", () => {
		const input: [string, string][] = [
			["a1", `${PF}/a`],
			["a2", `${PF}/a/deep`],
			["h", HOME],
			["o1", "/o"],
			["o2", "/o/in"],
			["g", "/gone"],
			["l", "/link"],
		];
		const r = rows([`${PF}/a`, `${PF}/b`], input, { "/gone": null, "/link": "/o/in" });
		const files = r.flatMap((row) => row.files).sort();
		expect(files).toEqual(input.map(([f]) => f).sort());
	});
});
