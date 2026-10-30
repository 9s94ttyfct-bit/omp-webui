import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * Route families the server loads when a request first needs them, not at start (#585): an idle server holds none of
 * their code, and a server that is only a relay holds none of the server's. What the server runs at start is what `main.ts`
 * imports with a static `import`, and what those files import in turn: that closure is read here from the sources, the way
 * Bun reads them (`import type` and a list of only inline `type` names are erased and load nothing; `import()` is a load
 * when it runs, not at start). A family's files must not be in it, and must be reached by `import()` from where they are
 * meant to be.
 *
 * The remote chain has its own test (`remote-ai-lazy.test.ts`); the updater and the migration code are imported by
 * `main.ts` with `import()` and need nothing else.
 */

const SERVER = join(import.meta.dir, "../../server");
const transpiler = new Bun.Transpiler({ loader: "ts" });

interface Edge {
	kind: "import-statement" | "dynamic-import";
	to: string;
}

/** The files a source imports (relative ones only), as absolute paths, by how they are imported. */
function importsOf(file: string): Edge[] {
	const edges: Edge[] = [];
	for (const found of transpiler.scanImports(readFileSync(file, "utf8"))) {
		if (!found.path.startsWith(".") || !found.path.endsWith(".ts")) continue;
		const to = resolve(dirname(file), found.path);
		if (!existsSync(to)) throw new Error(`${relative(SERVER, file)} imports ${found.path}, which is not there`);
		if (found.kind === "import-statement" || found.kind === "dynamic-import") edges.push({ kind: found.kind, to });
	}
	return edges;
}

/** Every file loaded when `entry` runs, before anything is asked: its static imports, and theirs. Paths relative to the server directory. */
function loadedAtStart(entry: string): Map<string, string> {
	const first = join(SERVER, entry);
	/** file -> the file that imports it first (to say how a family got in). */
	const seen = new Map<string, string>([[first, ""]]);
	const queue = [first];
	for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
		for (const edge of importsOf(file)) {
			if (edge.kind !== "import-statement" || seen.has(edge.to)) continue;
			seen.set(edge.to, file);
			queue.push(edge.to);
		}
	}
	return new Map([...seen].map(([to, from]) => [relative(SERVER, to), from && relative(SERVER, from)]));
}

/** The files (relative to the server directory) that import `target` with `import()`. */
function dynamicImporters(target: string): string[] {
	const found: string[] = [];
	for (const file of new Bun.Glob("**/*.ts").scanSync({ cwd: SERVER })) {
		if (importsOf(join(SERVER, file)).some((e) => e.kind === "dynamic-import" && e.to === join(SERVER, target))) {
			found.push(file);
		}
	}
	return found.sort();
}

interface Family {
	name: string;
	/** Every file that belongs to it. */
	files: string[];
	/** The files that are loaded with `import()`, and the files that do it. */
	loadedBy: Record<string, string[]>;
	/** What starts the process the family is not for. */
	entry: string;
}

const FAMILIES: Family[] = [
	{
		name: "the omp relay (code only a relay process runs)",
		files: ["omp/relay.ts", "omp/relay-backlog.ts"],
		loadedBy: { "omp/relay.ts": ["omp/relay-main.ts"] },
		entry: "main.ts",
	},
	{
		name: "the Files tab and the pickers (folder routes, watches, file completion, folder list)",
		files: ["folder-routes.ts", "folder.ts", "files.ts", "dirs.ts"],
		loadedBy: {
			"folder-routes.ts": ["folder-lazy.ts"],
			"files.ts": ["main.ts"],
			"dirs.ts": ["main.ts"],
		},
		entry: "main.ts",
	},
	{
		name: "git (the status line, the Files tab's marks)",
		files: ["git.ts", "git-vet.ts", "git-marks.ts"],
		loadedBy: { "git.ts": ["git-lazy.ts"] },
		entry: "main.ts",
	},
	{
		name: "the controls panel (toggles, todo list, session defaults)",
		files: ["omp/controls.ts", "omp/toggles.ts", "omp/todos.ts", "omp/session-defaults.ts", "omp/session-settings.ts"],
		loadedBy: { "omp/controls.ts": ["main.ts"] },
		entry: "main.ts",
	},
	{
		name: "the export of a conversation",
		files: ["export.ts", "export-harden.ts", "export-guard.ts"],
		loadedBy: { "export.ts": ["main.ts"] },
		entry: "main.ts",
	},
	{
		name: "omp's own statistics and the providers' usage",
		files: ["omp/stats.ts", "omp/usage.ts"],
		loadedBy: { "omp/stats.ts": ["main.ts"], "omp/usage.ts": ["main.ts"] },
		entry: "main.ts",
	},
];

describe("route families loaded on first use", () => {
	for (const family of FAMILIES) {
		test(`${family.name}: nothing the server loads at start imports it`, () => {
			const atStart = loadedAtStart(family.entry);
			const reached = family.files.filter((f) => atStart.has(f)).map((f) => `${f} (imported by ${atStart.get(f)})`);
			expect(reached).toEqual([]);
		});

		test(`${family.name}: it is loaded with import(), from where it is meant to be`, () => {
			const actual: Record<string, string[]> = {};
			for (const target of Object.keys(family.loadedBy)) actual[target] = dynamicImporters(target);
			expect(actual).toEqual(family.loadedBy);
			for (const target of Object.keys(family.loadedBy)) expect(family.files).toContain(target);
		});
	}

	test("a process that is a relay loads the relay, and the server does not load it for that", () => {
		// `relay-main.ts` is the first import of `main.ts`: what it loads statically, the server loads too.
		const atStart = loadedAtStart("omp/relay-main.ts");
		expect([...atStart.keys()].sort()).toEqual(["omp/relay-main.ts", "omp/relay-protocol.ts"]);
	});
});
