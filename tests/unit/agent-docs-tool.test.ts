import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import docsData from "../../server/omp/docs-tool/docs-data.ts";
import webuiDocs, { answer, DOCS_TOOL } from "../../server/omp/docs-tool/extension.ts";
import { DocsToolService, docsToolPaths, installDocsTool } from "../../server/omp/docs-tool/install.ts";
import { createLookup, DocsError, READ_MAX, SEARCH_LIMIT_MAX } from "../../server/omp/docs-tool/lookup.ts";

/**
 * The `webui_docs` tool (`server/omp/docs-tool/`): the lookup it answers with (list, search, read, and what it refuses), the
 * extension as omp registers it, and the copy the server installs, which must hold every file of `docs/agents/` and run on
 * its own (it is what omp loads, from the data folder, in the packaged app too).
 */

const FILES: Record<string, string> = {
	"guard.md": [
		"---",
		"title: Guard",
		"summary: Reviews dangerous commands.",
		"settings: guard",
		"---",
		"",
		"# Guard",
		"",
		"## What it does",
		"The reviewer model reads each risky command.",
		"",
		"## Settings",
		"| Key | Values | Default | Effect |",
		"|---|---|---|---|",
		"| `guard.json:mode` | `reviewer`, `ask`, `off` | `reviewer` | Who decides. |",
		"",
		"### Reviewer",
		"Blank: the guard chooses a reviewer model.",
		"",
		"```sh",
		"# not a heading",
		"```",
		"",
		"## Security notes",
		"Only this computer changes the guard.",
	].join("\n"),
	"remote-access.md":
		"---\ntitle: Remote access\nsummary: The tunnel.\n---\n\n# Remote access\n\n## What it does\nA Cloudflare tunnel with Access.\n",
	"not a topic.md": "# skipped",
	"notes.txt": "skipped",
};

const lookup = createLookup(FILES);

describe("list", () => {
	test("names every topic with its title and summary, and nothing that is not one", () => {
		const text = lookup.list();
		expect(text).toContain("2 topics");
		expect(text).toContain("- guard: Guard — Reviews dangerous commands.");
		expect(text).toContain("- remote-access: Remote access — The tunnel.");
		expect(text).not.toContain("skipped");
	});
});

describe("search", () => {
	test("finds the sections that hold every keyword, case aside, with the line that shows it", () => {
		const hits = lookup.hits("REVIEWER model");
		expect(hits.map((h) => `${h.topic}/${h.section}`)).toEqual(["guard/Reviewer", "guard/What it does"]);
		expect(hits[1].snippet).toBe("The reviewer model reads each risky command.");
		const text = lookup.search("tunnel");
		expect(text).toContain("remote-access › What it does");
	});

	test("a section must hold every word; none found says so", () => {
		expect(lookup.hits("reviewer tunnel")).toEqual([]);
		expect(lookup.search("reviewer tunnel")).toContain("No section holds every word");
	});

	test("an empty query is refused; the limit is kept to its bounds", () => {
		expect(() => lookup.search("  ")).toThrow(DocsError);
		expect(() => lookup.search(undefined)).toThrow("`query` is required");
		expect(lookup.hits("guard", 1)).toHaveLength(1);
		expect(
			lookup
				.search("guard", 1000)
				.split("\n")
				.filter((l) => l.startsWith("- ")).length,
		).toBeLessThanOrEqual(SEARCH_LIMIT_MAX);
	});
});

describe("read", () => {
	test("a topic whole, without its front matter; its name may carry .md", () => {
		const text = lookup.read("guard");
		expect(text.startsWith("# Guard")).toBe(true);
		expect(text).not.toContain("summary:");
		expect(lookup.read("guard.md")).toBe(text);
		expect(lookup.read("GUARD")).toBe(text);
	});

	test("a section with its subsections, by heading or anchor; a fenced # is not a heading", () => {
		const settings = lookup.read("guard", "settings");
		expect(settings.startsWith("## Settings")).toBe(true);
		expect(settings).toContain("### Reviewer");
		expect(settings).toContain("# not a heading");
		expect(settings).not.toContain("## Security notes");
		expect(lookup.read("guard", "## Security notes")).toBe("## Security notes\nOnly this computer changes the guard.");
		expect(lookup.read("guard", "what-it-does")).toContain("reviewer model");
		expect(lookup.read("guard", "Revie")).toBe(
			"### Reviewer\nBlank: the guard chooses a reviewer model.\n\n```sh\n# not a heading\n```",
		);
	});

	test("an unknown topic is an error that lists the topics", () => {
		expect(() => lookup.read("memory")).toThrow('Unknown topic "memory". Topics: guard, remote-access.');
		expect(() => lookup.read(undefined)).toThrow("`topic` is required");
		expect(() => lookup.read(42)).toThrow(DocsError);
	});

	test("a path, or anything that is not a topic name, is refused before any lookup", () => {
		for (const bad of [
			"../guard",
			"../../etc/passwd",
			"/etc/passwd",
			"guard/../remote-access",
			"..\\guard",
			"~/.omp-webui/token",
			"guard\u0000",
			"not a topic",
			"..",
			".",
		]) {
			expect(() => lookup.read(bad)).toThrow("is not a topic name");
		}
	});

	test("an unknown or ambiguous section is an error that lists the sections", () => {
		expect(() => lookup.read("guard", "Nope")).toThrow(
			'"guard" has no section "Nope". Sections: What it does; Settings;',
		);
		expect(() => lookup.read("guard", "s")).toThrow("is ambiguous");
		expect(() => lookup.read("guard", 3)).toThrow("`section` must be a heading");
	});

	test("a huge topic is cut, and says so", () => {
		const big = createLookup({ "big.md": `# Big\n\n${"x".repeat(READ_MAX + 10)}` });
		expect(big.read("big")).toEndWith(`[cut at ${READ_MAX} characters: read one section]`);
	});
});

describe("the extension", () => {
	const registered: Registered[] = [];
	webuiDocs({ registerTool: (tool) => registered.push(tool as unknown as Registered) });
	const tool = registered[0];

	test("registers one read-only, discoverable tool named webui_docs", () => {
		expect(registered).toHaveLength(1);
		expect(tool.name).toBe(DOCS_TOOL);
		expect(DOCS_TOOL).toBe("webui_docs");
		expect(tool.loadMode).toBe("discoverable");
		expect(tool.approval).toBe("read");
		expect(tool.parameters.required).toEqual(["action"]);
	});

	test("answers from every file of docs/agents", async () => {
		const files = readdirSync(join(import.meta.dir, "..", "..", "docs", "agents")).filter((f) => f.endsWith(".md"));
		expect(Object.keys(docsData).sort()).toEqual(files.sort());
		const listed = (await tool.execute("1", { action: "list" })).content[0].text;
		for (const f of files) expect(listed).toContain(`- ${f.slice(0, -3)}: `);
		const read = (
			await tool.execute("2", { action: "read", topic: "webui-docs-tool", section: "How it reaches the agent" })
		).content[0].text;
		expect(read).toStartWith("### How it reaches the agent");
		expect(read).toContain("xd://webui_docs");
	});

	test("a call it cannot answer throws, which omp shows as the tool's error", async () => {
		await expect(tool.execute("3", { action: "write", topic: "index" })).rejects.toThrow("`action` must be");
		await expect(tool.execute("4", { action: "read", topic: "../../server/auth" })).rejects.toThrow(
			"is not a topic name",
		);
		expect(() => answer(lookup, null)).toThrow("`action` must be");
	});

	test("it imports nothing but its lookup and its docs: no file, process or network module", () => {
		const dir = join(import.meta.dir, "..", "..", "server", "omp", "docs-tool");
		for (const file of ["extension.ts", "lookup.ts"]) {
			const text = readFileSync(join(dir, file), "utf8");
			const specifiers = [...text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]);
			expect(specifiers.every((s) => s === "./lookup.ts" || s === "./docs-data.ts")).toBe(true);
			expect(text).not.toMatch(/\b(?:require\(|process\.|Bun\.|fetch\()/);
		}
	});
});

describe("the installed copy", () => {
	const data = mkdtempSync(join(tmpdir(), "ompw-docs-tool-"));
	afterAll(() => rmSync(data, { recursive: true, force: true }));

	test("holds every doc, private to the user, and runs from the data folder on its own", async () => {
		const path = installDocsTool(data);
		expect(path).toBe(docsToolPaths(data).extension);
		expect(path).toBe(join(data, "webui-docs", "server", "omp", "docs-tool", "extension.ts"));
		const dir = join(data, "webui-docs", "server", "omp", "docs-tool");
		expect(readdirSync(dir).sort()).toEqual(["docs-data.ts", "extension.ts", "lookup.ts"]);
		for (const f of readdirSync(dir)) expect(statSync(join(dir, f)).mode & 0o777).toBe(0o600);
		const installed = (await import(join(dir, "docs-data.ts"))).default as Record<string, string>;
		const docsDir = join(import.meta.dir, "..", "..", "docs", "agents");
		const onDisk = Object.fromEntries(
			readdirSync(docsDir)
				.filter((f) => f.endsWith(".md"))
				.map((f) => [f, readFileSync(join(docsDir, f), "utf8")]),
		);
		expect(installed).toEqual(onDisk);
		// The copy omp loads, imported from where omp finds it: it registers the tool and answers.
		const ext = (await import(path)).default as typeof webuiDocs;
		const tools: Registered[] = [];
		ext({ registerTool: (t) => tools.push(t as unknown as Registered) });
		const text = (await tools[0].execute("1", { action: "search", query: "webui_docs" })).content[0].text;
		expect(text).toMatch(/^\d+ section\(s\) for "webui_docs"/);
		expect(text).toContain(" › ");
	});

	test("a file is written again only when it differs; the service says whether it could", () => {
		const file = join(docsToolPaths(data).dir, "server", "omp", "docs-tool", "lookup.ts");
		const before = statSync(file).mtimeMs;
		installDocsTool(data);
		expect(statSync(file).mtimeMs).toBe(before);
		const service = new DocsToolService(data);
		expect(service.extension).toBe(docsToolPaths(data).extension);
		expect(service.ensure()).toBe(true);
		const blocked = join(data, "blocked");
		mkdirSync(blocked);
		writeFileSync(join(blocked, "webui-docs"), "not a folder");
		expect(new DocsToolService(blocked).ensure()).toBe(false);
	});
});

interface Registered {
	name: string;
	loadMode: string;
	approval: string;
	parameters: { required: string[]; properties: Record<string, unknown> };
	execute(id: string, params: unknown): Promise<{ content: { type: string; text: string }[] }>;
}
