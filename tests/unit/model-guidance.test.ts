import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeOverlayFiles } from "../../server/omp/approval.ts";
import extension, {
	GUIDANCE_FILE_ENV,
	GUIDANCE_LOADED_SUFFIX,
	GUIDANCE_READ_MAX,
} from "../../server/omp/guidance/extension.ts";
import { guidancePaths, installGuidanceExtension } from "../../server/omp/guidance/install.ts";
import { GuidanceSessions, guidanceFileFor, writeGuidanceFile } from "../../server/omp/guidance/session.ts";
import { GuidanceStore, GuidanceStoreError } from "../../server/omp/guidance/store.ts";
import {
	BUILTIN_GUIDANCE,
	GUIDANCE_ID_MAX,
	GUIDANCE_MAX,
	GUIDANCE_NAME_MAX,
	GUIDANCE_TEMPLATES_MAX,
	guidanceNameProblem,
	guidanceSummary,
	guidanceTextOf,
	parseSessionGuidance,
} from "../../shared/model-guidance.ts";
import { tempDir } from "../support/temp-dirs.ts";

/**
 * The model guidance of #641, without omp: the templates the person saves (and what a damaged file does), the file each
 * conversation's extension reads, and the extension the server puts in the data folder. What omp does with the text is a
 * contract test (`tests/contract/model-guidance.test.ts`).
 */

const dir = () => tempDir("ompw-guidance-");

describe("the templates", () => {
	test("a data dir with no file holds the shipped templates, and writes nothing until something changes", () => {
		const data = dir();
		const store = new GuidanceStore(data);
		const { templates, rev } = store.snapshot();
		expect(templates.map((t) => t.id)).toEqual(BUILTIN_GUIDANCE.map((t) => t.id));
		expect(templates.every((t) => t.builtin === true)).toBe(true);
		expect(rev).toBe(0);
		expect(() => statSync(join(data, "model-guidance.json"))).toThrow();
	});

	test("a template is saved with the shipped ones around it, the file is 0600, and the revision goes up", () => {
		const data = dir();
		const store = new GuidanceStore(data);
		const saved = store.save({ id: "mine", name: "Mine", text: "At most one Sonnet subagent." });
		expect(saved.rev).toBe(1);
		expect(saved.templates.find((t) => t.id === "mine")).toEqual({
			id: "mine",
			name: "Mine",
			text: "At most one Sonnet subagent.",
		});
		const file = join(data, "model-guidance.json");
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(file, "utf8")).templates).toHaveLength(BUILTIN_GUIDANCE.length + 1);
	});

	test("an update of a template deleted meanwhile is refused, and does not add it again (#715)", () => {
		const store = new GuidanceStore(dir());
		store.save({ id: "mine", name: "Mine", text: "One." });
		expect(
			store.save({ id: "mine", name: "Mine", text: "Two." }, true).templates.find((t) => t.id === "mine")?.text,
		).toBe("Two.");
		store.remove("mine");
		let problem = "";
		try {
			store.save({ id: "mine", name: "Mine", text: "Three." }, true);
		} catch (e) {
			problem = (e as GuidanceStoreError).problem;
		}
		expect(problem).toBe("gone");
		expect(store.list().some((t) => t.id === "mine")).toBe(false);
	});

	test("a name, or the text, cannot be empty, and a name cannot repeat another template's", () => {
		const store = new GuidanceStore(dir());
		const why = (input: unknown): string => {
			try {
				store.save(input);
			} catch (e) {
				expect(e).toBeInstanceOf(GuidanceStoreError);
				return (e as GuidanceStoreError).problem;
			}
			return "saved";
		};
		expect(why({ id: "a", name: "  ", text: "x" })).toBe("nameEmpty");
		expect(why({ id: "b", name: "B", text: "   " })).toBe("textEmpty");
		expect(why({ id: "c", name: BUILTIN_GUIDANCE[0]?.name, text: "x" })).toBe("nameRepeated");
		expect(why({ name: "no id", text: "x" })).toBe("unknown");
		expect(why({ id: "d", name: "D", text: "x".repeat(GUIDANCE_MAX + 1) })).toBe("textTooLong");
	});

	test("a file that cannot be read is kept aside as .damaged and the shipped templates stand in its place", () => {
		const data = dir();
		writeFileSync(join(data, "model-guidance.json"), "{ this is not json");
		const store = new GuidanceStore(data);
		expect(store.snapshot().templates.map((t) => t.id)).toEqual(BUILTIN_GUIDANCE.map((t) => t.id));
		expect(readFileSync(join(data, "model-guidance.json.damaged"), "utf8")).toBe("{ this is not json");
		// And a change writes a good file again.
		store.save({ id: "after", name: "After", text: "x" });
		expect(JSON.parse(readFileSync(join(data, "model-guidance.json"), "utf8")).templates.length).toBeGreaterThan(0);
	});

	test("a file that holds something else than templates is kept aside too, and never a list of nonsense", () => {
		const data = dir();
		writeFileSync(join(data, "model-guidance.json"), JSON.stringify({ rev: 3, templates: 7 }));
		const store = new GuidanceStore(data);
		expect(store.snapshot().templates.map((t) => t.id)).toEqual(BUILTIN_GUIDANCE.map((t) => t.id));
		expect(() => statSync(join(data, "model-guidance.json.damaged"))).not.toThrow();
	});

	test("a second damaged file never writes over the first one kept aside", () => {
		const data = dir();
		const file = join(data, "model-guidance.json");
		writeFileSync(file, "{ first damage");
		new GuidanceStore(data);
		writeFileSync(file, "{ second damage");
		new GuidanceStore(data);
		const aside = readdirSync(data).filter((f) => f.startsWith("model-guidance.json") && f.endsWith(".damaged"));
		expect(aside).toHaveLength(2);
		expect(readFileSync(join(data, "model-guidance.json.damaged"), "utf8")).toBe("{ first damage");
		const later = aside.find((f) => f !== "model-guidance.json.damaged") as string;
		expect(readFileSync(join(data, later), "utf8")).toBe("{ second damage");
	});

	test("restore defaults puts the shipped text back where it ships, and leaves the person's own templates alone", () => {
		const data = dir();
		const store = new GuidanceStore(data);
		store.save({ id: "builtin-one-of-each", name: "Renamed", text: "Something else entirely" });
		store.remove("builtin-simple-complex");
		store.save({ id: "mine", name: "Mine", text: "Mine" });
		const restored = store.restoreDefaults();
		expect(restored.templates.map((t) => t.id)).toEqual([...BUILTIN_GUIDANCE.map((t) => t.id), "mine"]);
		expect(restored.templates[0]?.text).toBe(BUILTIN_GUIDANCE[0]?.text);
		expect(restored.templates[0]?.name).toBe(BUILTIN_GUIDANCE[0]?.name);
		expect(restored.templates.every((t) => t.builtin === true || t.id === "mine")).toBe(true);
		expect(restored.rev).toBe(4);
	});

	test("a template that ships is only marked shipped while it still holds the shipped text", () => {
		const store = new GuidanceStore(dir());
		const edited = store.save({ id: "builtin-one-of-each", name: "Mine now", text: "Different" });
		expect(edited.templates.find((t) => t.id === "builtin-one-of-each")?.builtin).toBeUndefined();
	});

	test("no more than the most templates are kept", () => {
		const store = new GuidanceStore(dir());
		for (let i = 0; i < GUIDANCE_TEMPLATES_MAX - BUILTIN_GUIDANCE.length; i++) {
			store.save({ id: `t${i}`, name: `T${i}`, text: "x" });
		}
		expect(() => store.save({ id: "one-too-many", name: "One too many", text: "x" })).toThrow(GuidanceStoreError);
	});

	test("a template that ships after a file was written joins it once; one the person deleted stays deleted", () => {
		const data = dir();
		const file = join(data, "model-guidance.json");
		const [first, second] = BUILTIN_GUIDANCE;
		if (!first || !second) throw new Error("two shipped templates");
		// A file made with the first template only (as if the second shipped later): the second joins at its place.
		writeFileSync(
			file,
			JSON.stringify({ rev: 2, builtins: [first.id], templates: [first, { id: "mine", name: "Mine", text: "x" }] }),
		);
		expect(new GuidanceStore(data).snapshot().templates.map((t) => t.id)).toEqual([first.id, second.id, "mine"]);
		// A file made with both, which deleted the second: it stays deleted, and so does a file from before `builtins`.
		writeFileSync(file, JSON.stringify({ rev: 2, builtins: [first.id, second.id], templates: [first] }));
		expect(new GuidanceStore(data).snapshot().templates.map((t) => t.id)).toEqual([first.id]);
		writeFileSync(file, JSON.stringify({ rev: 2, templates: [first] }));
		expect(new GuidanceStore(data).snapshot().templates.map((t) => t.id)).toEqual([first.id]);
		// What the store writes says which templates it was made with.
		const store = new GuidanceStore(data);
		store.save({ id: "later", name: "Later", text: "y" });
		expect(JSON.parse(readFileSync(file, "utf8")).builtins).toEqual(BUILTIN_GUIDANCE.map((t) => t.id));
	});

	test("the text a conversation carries is the template as it stands now, else the text it was given", () => {
		const templates = [
			{ id: "a", name: "A", text: "First" },
			{ id: "b", name: "B", text: "Second" },
		];
		expect(guidanceTextOf(templates, { template: "a" })).toBe("First");
		expect(guidanceTextOf(templates, { template: "gone", text: "  kept  " })).toBe("kept");
		expect(guidanceTextOf(templates, { text: "  typed  " })).toBe("typed");
		expect(guidanceTextOf(templates, null)).toBe("");
		expect(guidanceTextOf(templates, {})).toBe("");
	});
});

describe("what a page sends as a conversation's guidance", () => {
	test("a template id, text, or both; nothing at all is none", () => {
		expect(parseSessionGuidance(null)).toBeNull();
		expect(parseSessionGuidance(undefined)).toBeNull();
		expect(parseSessionGuidance({})).toBeNull();
		expect(parseSessionGuidance({ template: "", text: "   " })).toBeNull();
		expect(parseSessionGuidance({ template: "a" })).toEqual({ template: "a" });
		expect(parseSessionGuidance({ text: "  hi  " })).toEqual({ text: "  hi  " });
		expect(parseSessionGuidance({ template: "a", text: "hi" })).toEqual({ template: "a", text: "hi" });
	});

	test("anything else is refused, rather than taken as none", () => {
		expect(() => parseSessionGuidance("a template")).toThrow();
		expect(() => parseSessionGuidance({ template: 7 })).toThrow();
		expect(() => parseSessionGuidance({ text: ["x"] })).toThrow();
		expect(() => parseSessionGuidance({ text: "x".repeat(GUIDANCE_MAX + 1) })).toThrow();
		// A template id is bounded as the store's are, so that a page cannot make the remembered choices (500 of them) large.
		expect(parseSessionGuidance({ template: "t".repeat(GUIDANCE_ID_MAX) })).toEqual({
			template: "t".repeat(GUIDANCE_ID_MAX),
		});
		expect(() => parseSessionGuidance({ template: "t".repeat(GUIDANCE_ID_MAX + 1) })).toThrow();
	});
});

describe("the file a conversation's omp reads", () => {
	test("it sits beside the conversation's settings overlay, or in the fallback folder when there is none", () => {
		expect(guidanceFileFor("L1", "/tmp/ompw-live-1/L1.yml", "/data/guidance/live")).toBe(
			"/tmp/ompw-live-1/L1.yml.guidance.md",
		);
		expect(guidanceFileFor("L1", null, "/data/guidance/live")).toBe("/data/guidance/live/L1.guidance.md");
	});

	test("writing it is 0600 and atomic, and no text takes the file away", () => {
		const data = dir();
		const file = join(data, "L1.yml.guidance.md");
		writeGuidanceFile(file, "  ## Model guidance\nOne at a time.  ");
		expect(readFileSync(file, "utf8")).toBe("## Model guidance\nOne at a time.\n");
		expect(statSync(file).mode & 0o777).toBe(0o600);
		writeGuidanceFile(file, "   ");
		expect(() => statSync(file)).toThrow();
	});
});

describe("the extension omp is started with", () => {
	test("the file written into the data folder is the guidance extension, not the gate's", () => {
		const data = dir();
		const path = installGuidanceExtension(data);
		expect(path).toBe(guidancePaths(data).extension);
		const text = readFileSync(path, "utf8");
		// What it does, and what only the gate does: the two extensions are told apart by both.
		expect(text).toContain("before_agent_start");
		expect(text).toContain("OMPW_GUIDANCE_FILE");
		expect(text).not.toContain("tool_call");
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	test("a file already as the server has it is not written again, and one that differs is", () => {
		const data = dir();
		const path = installGuidanceExtension(data);
		const first = statSync(path).mtimeMs;
		installGuidanceExtension(data);
		expect(statSync(path).mtimeMs).toBe(first);
		writeFileSync(path, "// changed on disk\n");
		installGuidanceExtension(data);
		expect(readFileSync(path, "utf8")).toContain("before_agent_start");
	});

	test("a data folder that cannot hold the files throws, for the caller to start without it", () => {
		const data = dir();
		mkdirSync(join(data, "guidance"), { recursive: true });
		// A file where the extension's folder has to be: mkdir fails, and so does the install.
		writeFileSync(join(data, "guidance", "server"), "not a folder");
		expect(() => installGuidanceExtension(data)).toThrow();
	});
});

describe("the extension's own side of the file", () => {
	/** Run the extension as omp would, on `file`, and answer what its handler does for `kind`'s turn. */
	async function load(file: string, kind: string | undefined): Promise<{ systemPrompt?: string[] } | undefined> {
		const before = process.env[GUIDANCE_FILE_ENV];
		process.env[GUIDANCE_FILE_ENV] = file;
		try {
			let handler: ((e: unknown, ctx: unknown) => Promise<unknown>) | undefined;
			extension({
				on: (_event, h) => {
					handler = h as typeof handler;
				},
			});
			return (await handler?.({ systemPrompt: ["omp's own"] }, kind ? { agent: { kind } } : {})) as
				| { systemPrompt?: string[] }
				| undefined;
		} finally {
			if (before === undefined) delete process.env[GUIDANCE_FILE_ENV];
			else process.env[GUIDANCE_FILE_ENV] = before;
		}
	}

	test("its length limit is the server's", () => {
		expect(GUIDANCE_READ_MAX).toBe(GUIDANCE_MAX);
	});

	test("a file the model made longer than the limit adds no more than the limit, and only to the main agent", async () => {
		const file = join(dir(), "L1.yml.guidance.md");
		writeFileSync(file, `${"é".repeat(GUIDANCE_MAX)}TAIL-PAST-THE-LIMIT${"x".repeat(100_000)}`);
		const main = await load(file, "main");
		const block = main?.systemPrompt?.[1] ?? "";
		expect(main?.systemPrompt?.[0]).toBe("omp's own");
		expect(block.startsWith("## Model guidance\n")).toBe(true);
		expect(block.length).toBe("## Model guidance\n".length + GUIDANCE_MAX);
		expect(block).not.toContain("TAIL-PAST-THE-LIMIT");
		expect(await load(file, "sub")).toBeUndefined();
		expect(await load(file, undefined)).toBeUndefined();
	});

	test("it says it started: the note is beside the file, 0600, and written even where the file was never", async () => {
		const data = dir();
		// The fallback folder does not exist until a text is written: the note makes it.
		const file = join(data, "guidance", "live", "L1.guidance.md");
		expect(await load(file, "main")).toBeUndefined();
		const note = `${file}${GUIDANCE_LOADED_SUFFIX}`;
		expect(readFileSync(note, "utf8")).toBe(String(process.pid));
		expect(statSync(note).mode & 0o777).toBe(0o600);
	});
});

describe("the guidance's files go with the conversation's settings overlay", () => {
	test("its text, its half-written text and the extension's note are taken away with the overlay", () => {
		const folder = dir();
		const overlay = join(folder, "L1.yml");
		const mine = [overlay, `${overlay}.guidance.md`, `${overlay}.guidance.md.tmp`, `${overlay}.guidance.md.loaded`];
		for (const f of mine) writeFileSync(f, "x");
		const other = join(folder, "other.yml.guidance.md");
		writeFileSync(other, "not this conversation's");
		removeOverlayFiles(overlay);
		for (const f of mine) expect(existsSync(f)).toBe(false);
		expect(existsSync(other)).toBe(true);
	});
});

describe("a template's line in a list", () => {
	test("is its first line of text, without Markdown's marks, cut with an ellipsis; a heading only when nothing else", () => {
		expect(guidanceSummary("\n\n## Subagents\n\nUse Haiku.")).toBe("Use Haiku.");
		expect(guidanceSummary("## Subagents\n\n")).toBe("Subagents");
		expect(guidanceSummary("- Give reading to a fast model\n- the rest to Opus")).toBe("Give reading to a fast model");
		expect(guidanceSummary("> 1. quoted step")).toBe("quoted step");
		expect(guidanceSummary("#hashtag is not a heading")).toBe("#hashtag is not a heading");
		const long = guidanceSummary("x".repeat(500), 20);
		expect(long).toHaveLength(20);
		expect(long.endsWith("…")).toBe(true);
		expect(guidanceSummary(" \n -  \n")).toBe("");
		// The shipped ones all start with the same heading: each is told apart by what it says.
		const lines = BUILTIN_GUIDANCE.map((b) => guidanceSummary(b.text));
		expect(new Set(lines).size).toBe(BUILTIN_GUIDANCE.length);
		for (const line of lines) expect(line).not.toBe("Model guidance");
	});
});

describe("a template's name, as the Guidance tab's Create new template and rename check it (v0.12.2)", () => {
	const templates = [
		{ id: "a", name: "Sonnet sparingly" },
		{ id: "b", name: "  Padded  " },
	];
	test("trimmed, not empty, at most the limit, and not another template's", () => {
		expect(guidanceNameProblem("", templates)).toBe("nameEmpty");
		expect(guidanceNameProblem("   \t", templates)).toBe("nameEmpty");
		expect(guidanceNameProblem("x".repeat(GUIDANCE_NAME_MAX), templates)).toBeNull();
		expect(guidanceNameProblem(`  ${"x".repeat(GUIDANCE_NAME_MAX)}  `, templates)).toBeNull();
		expect(guidanceNameProblem("x".repeat(GUIDANCE_NAME_MAX + 1), templates)).toBe("nameTooLong");
		expect(guidanceNameProblem(" Sonnet sparingly ", templates)).toBe("nameRepeated");
		expect(guidanceNameProblem("Padded", templates)).toBe("nameRepeated");
		expect(guidanceNameProblem("Something new", templates)).toBeNull();
	});
	test("a template keeps its own name: renaming it to what it is called is no repeat", () => {
		expect(guidanceNameProblem("Sonnet sparingly", templates, "a")).toBeNull();
		expect(guidanceNameProblem("Sonnet sparingly", templates, "b")).toBe("nameRepeated");
	});
	test("the store refuses what the tab refuses, and keeps the name trimmed", () => {
		const store = new GuidanceStore(dir());
		const why = (input: unknown, update = false): string => {
			try {
				store.save(input, update);
				return "saved";
			} catch (e) {
				return (e as GuidanceStoreError).problem;
			}
		};
		expect(why({ id: "mine", name: "  Mine  ", text: "One." })).toBe("saved");
		expect(store.snapshot().templates.find((t) => t.id === "mine")?.name).toBe("Mine");
		expect(why({ id: "other", name: "Mine ", text: "Two." })).toBe("nameRepeated");
		expect(why({ id: "other", name: "x".repeat(GUIDANCE_NAME_MAX + 1), text: "Two." })).toBe("nameTooLong");
		// A rename of the template itself (the pencil's update) keeps its text, and may keep its name.
		expect(why({ id: "mine", name: "Mine", text: "One." }, true)).toBe("saved");
		expect(why({ id: "mine", name: "Renamed", text: "One." }, true)).toBe("saved");
		expect(store.snapshot().templates.find((t) => t.id === "mine")).toEqual({
			id: "mine",
			name: "Renamed",
			text: "One.",
		});
	});
});

describe("who else uses a template (the Guidance tab asks before Save to template, v0.12.2)", () => {
	test("other conversations that still exist are counted by template; this one and the deleted ones are not", () => {
		const data = dir();
		const store = new GuidanceStore(data);
		const sessions = new GuidanceSessions(data, store);
		const folder = dir();
		const conversation = (name: string): string => {
			const file = join(folder, `${name}.jsonl`);
			writeFileSync(file, "");
			return file;
		};
		const mine = conversation("mine");
		const other = conversation("other");
		const third = conversation("third");
		const gone = join(folder, "gone.jsonl");
		sessions.remember(mine, { template: "builtin-one-of-each", text: "x" });
		sessions.remember(other, { template: "builtin-one-of-each", text: "x" });
		sessions.remember(third, { template: "builtin-simple-complex", text: "y" });
		sessions.remember(gone, { template: "builtin-one-of-each", text: "x" });
		sessions.remember(conversation("own-text"), { text: "Text of its own." });
		expect(sessions.usersByTemplate(mine)).toEqual({ "builtin-one-of-each": 1, "builtin-simple-complex": 1 });
		expect(sessions.usersByTemplate(null)).toEqual({ "builtin-one-of-each": 2, "builtin-simple-complex": 1 });
		// A conversation that changed to its own text (Save for this conversation) no longer uses the template.
		sessions.remember(other, { text: "Changed here only." });
		expect(sessions.usersByTemplate(mine)).toEqual({ "builtin-simple-complex": 1 });
	});
});
