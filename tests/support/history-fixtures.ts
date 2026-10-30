import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FamilyMember } from "../../server/family.ts";
import { answerView } from "../../server/history.ts";
import type { IndexCache } from "../../server/history-index.ts";
import type { ViewRequest } from "../../server/history-request.ts";
import type { FamilyDocument, FamilyStatsDocument, SessionEntry, SessionFileData } from "../../shared/protocol.ts";
import { FIXTURE_CWD } from "./fixtures.ts";
import { assistant, result, user } from "./session-entries.ts";

/**
 * Conversations for the specs of the windows of the history (`server/history.ts`): files of a known shape written to a
 * scratch folder, and the answer of the view code over them as the page would read it.
 */

/** A folder of its own (real path: the macOS temp folder is a link). */
export function scratch(prefix = "ompw-history-"): string {
	return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export interface WriteOptions {
	/** The header's `parentSession`: the file is a fork or branch of that one. */
	parentSession?: string;
	/** A fixed-width title slot before the header, as omp writes it. */
	title?: string;
	/** Lines between the header and the entries, as they are (to put in what is not an entry, or an entry written another way). */
	raw?: string[];
}

/**
 * A session file of `entries` (objects, or lines written as they are) under `dir`, named `name`. Returns its path.
 * Each line ends with `\n`, unless `eol` says otherwise.
 */
export function writeSession(
	dir: string,
	name: string,
	entries: (SessionEntry | Record<string, unknown> | string)[],
	options: WriteOptions & { eol?: string } = {},
): string {
	const bucket = join(dir, "sessions", FIXTURE_CWD.replaceAll("/", "-"));
	mkdirSync(bucket, { recursive: true });
	const file = join(bucket, `${name}.jsonl`);
	const header = {
		type: "session",
		version: 3,
		id: `01a00000-0000-7000-8000-${Bun.hash(name).toString(16).padStart(12, "0").slice(-12)}`,
		timestamp: "2026-01-20T10:00:00.000Z",
		cwd: FIXTURE_CWD,
		...(options.parentSession ? { parentSession: options.parentSession } : {}),
	};
	const lines: string[] = [];
	if (options.title) {
		const slot = { type: "title", v: 1, title: options.title, source: "user", updatedAt: header.timestamp, pad: "" };
		slot.pad = " ".repeat(Math.max(0, 255 - Buffer.byteLength(JSON.stringify(slot))));
		lines.push(JSON.stringify(slot));
	}
	lines.push(JSON.stringify(header), ...(options.raw ?? []));
	for (const e of entries) lines.push(typeof e === "string" ? e : JSON.stringify(e));
	const eol = options.eol ?? "\n";
	writeFileSync(file, lines.join(eol) + eol);
	return file;
}

/** A member of a family, as the cache gives it to the worker. */
export function member(file: string, tag = "t"): FamilyMember {
	return { file, subagents: [], advisors: [], tag };
}

export interface TurnOptions {
	/** Prefix of the ids: `u<n>` for the prompts, `a<n>_<k>` for the steps, `r<n>_<k>` for their results, `f<n>` for the answers. */
	prefix?: string;
	/** The entry the first prompt follows. */
	parent?: string | null;
	/** Tool steps in each turn (an assistant message with a call, and its result). */
	steps?: number;
	/** Where in time the first entry is: seconds after the fixed start of `session-entries`. */
	at?: number;
	/** Text of each prompt. */
	text?: (n: number) => string;
}

/** What each request of a turn used: the figures of a conversation made of turns are not zero. */
const USAGE = { input: 10, output: 5, cacheRead: 100, cacheWrite: 1, totalTokens: 116, cost: { total: 0.001 } };

/** `count` agent turns in a chain: a prompt, `steps` tool steps, and an answer. */
export function turns(count: number, o: TurnOptions = {}): SessionEntry[] {
	const p = o.prefix ?? "";
	const steps = o.steps ?? 1;
	const text = o.text ?? ((n: number) => `prompt ${n}`);
	const out: SessionEntry[] = [];
	let parent: string | null = o.parent ?? null;
	let clock = o.at ?? 0;
	const add = (e: SessionEntry) => {
		out.push(e);
		parent = e.id;
	};
	for (let n = 0; n < count; n++) {
		add(user(`${p}u${n}`, parent, clock++, text(n)));
		for (let k = 0; k < steps; k++) {
			add(
				assistant(`${p}a${n}_${k}`, parent, clock++, {
					text: `step ${n}.${k}`,
					calls: { [`call${p}${n}_${k}`]: "bash" },
					extra: { usage: USAGE },
				}),
			);
			add(result(`${p}r${n}_${k}`, parent, clock++, `call${p}${n}_${k}`, `out ${n}.${k}`));
		}
		add(assistant(`${p}f${n}`, parent, clock++, { text: `answer ${n}`, extra: { usage: USAGE } }));
	}
	return out;
}

/** What `answerView` answered with, parsed: the document of a window, and its viewed file's member. */
export interface Answered {
	doc: FamilyDocument;
	own: SessionFileData;
	ids: string[];
}

export function ask(cache: IndexCache, file: string, family: string[], view: ViewRequest): Answered {
	const doc: FamilyDocument = JSON.parse(
		answerView(
			file,
			family.map((f) => member(f)),
			view,
			cache,
		).join(""),
	);
	const own = doc.members.find((m) => m.file === file) as SessionFileData;
	return { doc, own, ids: own.entries.map((e) => e.id) };
}

export function askStats(cache: IndexCache, file: string): FamilyStatsDocument {
	return JSON.parse(answerView(file, [member(file)], { kind: "stats" }, cache).join(""));
}

/** The ids of the path from the root to `leaf` among `entries`. */
export function pathTo(entries: SessionEntry[], leaf: string): string[] {
	const byId = new Map(entries.map((e) => [e.id, e]));
	const out: string[] = [];
	for (let e = byId.get(leaf); e; e = e.parentId ? byId.get(e.parentId) : undefined) out.unshift(e.id);
	return out;
}
