/**
 * The lookup behind the `webui_docs` tool (`extension.ts`): list, search and read the agent-facing documentation of
 * omp-webui (`docs/agents/*.md`). It works on the text of those files as it is handed them, a record of file name to
 * Markdown, and on nothing else: it reads no file, so a topic name can never be a path. A name that is not one of the
 * topics is refused, whatever it holds.
 *
 * It is copied into the app's data folder beside the extension (`install.ts`) and runs in omp's own process, so it imports
 * nothing. The server's tests read the same files through it (`tests/unit/agent-docs-*.test.ts`).
 */

/** What a topic is called: its file name without `.md`. Letters, digits and dashes, so a name is never a path. */
export const TOPIC_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The most hits a search returns when it is not told otherwise, and the most it ever returns. */
export const SEARCH_LIMIT = 10;
export const SEARCH_LIMIT_MAX = 30;

/** The most characters of a topic one read returns: a topic is far below it. */
export const READ_MAX = 60_000;

/** A question the docs cannot answer as asked (an unknown topic, a name that is a path): the tool's error. */
export class DocsError extends Error {}

export interface Section {
	/** The heading's text, without its `#`s. */
	heading: string;
	/** 1 for `#`, 2 for `##`, and so on. */
	level: number;
	/** The heading in lower case, words joined by dashes (what a Markdown anchor is). */
	slug: string;
	/** The section's own lines, from its heading to the next heading of any level. */
	own: string;
	/** The section with its subsections: from its heading to the next heading of its level or above. */
	whole: string;
}

export interface Topic {
	name: string;
	title: string;
	summary: string;
	/** The ids of the Settings entries the topic covers (`web/src/lib/settings-search.ts`). */
	settings: string[];
	/** The Markdown after the front matter. */
	body: string;
	sections: Section[];
}

export const slugOf = (heading: string): string =>
	heading
		.toLowerCase()
		.replace(/[`*_~[\]()<>"'.,:;!?/\\|&+=#@$%^{}]/g, "")
		.trim()
		.replace(/\s+/g, "-");

/** The front matter (`---` lines around `key: value` lines) and the rest. */
function frontMatter(text: string): { fields: Record<string, string>; body: string } {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	if (lines[0] !== "---") return { fields: {}, body: lines.join("\n") };
	const end = lines.indexOf("---", 1);
	if (end < 0) return { fields: {}, body: lines.join("\n") };
	const fields: Record<string, string> = {};
	for (const line of lines.slice(1, end)) {
		const at = line.indexOf(":");
		if (at > 0) fields[line.slice(0, at).trim()] = line.slice(at + 1).trim();
	}
	return { fields, body: lines.slice(end + 1).join("\n") };
}

/** The sections of `body` by its ATX headings; a fenced code block's `#` lines are not headings. */
function sectionsOf(body: string): Section[] {
	const lines = body.split("\n");
	const heads: { at: number; level: number; heading: string }[] = [];
	let fenced = false;
	lines.forEach((line, at) => {
		if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
		if (fenced) return;
		const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
		if (m) heads.push({ at, level: m[1].length, heading: m[2] });
	});
	return heads.map((h, i) => {
		const next = heads[i + 1]?.at ?? lines.length;
		const closer = heads.slice(i + 1).find((o) => o.level <= h.level)?.at ?? lines.length;
		return {
			heading: h.heading,
			level: h.level,
			slug: slugOf(h.heading),
			own: lines.slice(h.at, next).join("\n").trimEnd(),
			whole: lines.slice(h.at, closer).join("\n").trimEnd(),
		};
	});
}

/** One topic from its file's name and text. */
export function parseTopic(name: string, text: string): Topic {
	const { fields, body } = frontMatter(text);
	const sections = sectionsOf(body);
	const settings = (fields.settings ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s !== "");
	return {
		name,
		title: fields.title || sections.find((s) => s.level === 1)?.heading || name,
		summary: fields.summary ?? "",
		settings,
		body: body.trim(),
		sections,
	};
}

/** The topics of `files` (file name → Markdown), by name; a file whose name is not a topic's is left out. */
export function topicsOf(files: Readonly<Record<string, string>>): Map<string, Topic> {
	const topics = new Map<string, Topic>();
	for (const file of Object.keys(files).sort()) {
		if (!file.endsWith(".md")) continue;
		const name = file.slice(0, -".md".length);
		if (TOPIC_NAME.test(name)) topics.set(name, parseTopic(name, files[file]));
	}
	return topics;
}

export interface SearchHit {
	topic: string;
	section: string;
	snippet: string;
	score: number;
}

export interface Lookup {
	/** Every topic, with its title and summary. */
	list(): string;
	/** The sections that hold every word of `query`, best first. */
	search(query: unknown, limit?: unknown): string;
	/** A topic whole, or one of its sections (with its subsections). */
	read(topic: unknown, section?: unknown): string;
	/** The hits of `search`, as data. */
	hits(query: string, limit?: number): SearchHit[];
}

const words = (query: string): string[] =>
	query
		.toLowerCase()
		.split(/\s+/)
		.map((w) => w.trim())
		.filter((w) => w !== "");

const count = (text: string, word: string): number => {
	let n = 0;
	for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + word.length)) n++;
	return n;
};

/** The line of `text` that best shows the match: the first that holds the most words, cut to a readable length. */
function snippetOf(text: string, ws: string[]): string {
	let best = "";
	let most = 0;
	for (const line of text.split("\n").slice(1)) {
		const lower = line.toLowerCase();
		const n = ws.filter((w) => lower.includes(w)).length;
		if (n > most) {
			most = n;
			best = line.trim();
		}
	}
	return best.length > 240 ? `${best.slice(0, 237)}...` : best;
}

/** The topic a name asks for, or the tool's error: a name that is not a topic's (a path, a typo) never reaches a file. */
function topicNamed(topics: Map<string, Topic>, asked: unknown): Topic {
	if (typeof asked !== "string" || asked.trim() === "")
		throw new DocsError("`topic` is required: one of the names `list` returns.");
	const name = asked.trim().replace(/\.md$/i, "").toLowerCase();
	if (!TOPIC_NAME.test(name))
		throw new DocsError(
			`"${asked}" is not a topic name: a topic is one of the names \`list\` returns (letters, digits and dashes; no paths).`,
		);
	const topic = topics.get(name);
	if (!topic) throw new DocsError(`Unknown topic "${name}". Topics: ${[...topics.keys()].join(", ")}.`);
	return topic;
}

function sectionNamed(topic: Topic, asked: string): Section {
	const want = asked.trim().replace(/^#+\s*/, "");
	const lower = want.toLowerCase();
	const slug = slugOf(want);
	const exact = topic.sections.find((s) => s.heading.toLowerCase() === lower || s.slug === slug);
	if (exact) return exact;
	const partial = topic.sections.filter((s) => s.heading.toLowerCase().includes(lower));
	if (partial.length === 1) return partial[0];
	const headings = topic.sections.filter((s) => s.level > 1).map((s) => s.heading);
	throw new DocsError(
		partial.length > 1
			? `Section "${want}" of "${topic.name}" is ambiguous: ${partial.map((s) => s.heading).join("; ")}.`
			: `"${topic.name}" has no section "${want}". Sections: ${headings.join("; ")}.`,
	);
}

const capped = (text: string): string =>
	text.length > READ_MAX ? `${text.slice(0, READ_MAX)}\n\n[cut at ${READ_MAX} characters: read one section]` : text;

export function createLookup(files: Readonly<Record<string, string>>): Lookup {
	const topics = topicsOf(files);
	const hits = (query: string, limit = SEARCH_LIMIT): SearchHit[] => {
		const ws = words(query);
		const found: SearchHit[] = [];
		for (const topic of topics.values()) {
			for (const section of topic.sections) {
				const text = section.own.toLowerCase();
				const head = `${topic.title} ${section.heading}`.toLowerCase();
				if (!ws.every((w) => text.includes(w) || head.includes(w))) continue;
				const score = ws.reduce((s, w) => s + count(text, w) + (head.includes(w) ? 5 : 0), 0);
				found.push({ topic: topic.name, section: section.heading, snippet: snippetOf(section.own, ws), score });
			}
		}
		return found.sort((a, b) => b.score - a.score || a.topic.localeCompare(b.topic)).slice(0, limit);
	};
	return {
		list() {
			const lines = [...topics.values()].map((t) => `- ${t.name}: ${t.title}${t.summary ? ` — ${t.summary}` : ""}`);
			return `${topics.size} topics of omp-webui's documentation. Read one with {"action":"read","topic":"<name>"}.\n${lines.join("\n")}`;
		},
		search(query, limit) {
			if (typeof query !== "string" || words(query).length === 0)
				throw new DocsError("`query` is required: one or more keywords, all of which a section must contain.");
			const n =
				typeof limit === "number" && Number.isInteger(limit) && limit > 0
					? Math.min(limit, SEARCH_LIMIT_MAX)
					: SEARCH_LIMIT;
			const found = hits(query, n);
			if (found.length === 0)
				return `No section holds every word of "${query.trim()}". Try fewer or other words, or {"action":"list"}.`;
			const lines = found.map((h) => `- ${h.topic} › ${h.section}${h.snippet ? `\n  ${h.snippet}` : ""}`);
			return `${found.length} section(s) for "${query.trim()}". Read one with {"action":"read","topic":"<topic>","section":"<section>"}.\n${lines.join("\n")}`;
		},
		read(topicName, section) {
			const topic = topicNamed(topics, topicName);
			if (section === undefined || section === null || (typeof section === "string" && section.trim() === ""))
				return capped(topic.body);
			if (typeof section !== "string") throw new DocsError("`section` must be a heading of the topic.");
			return capped(sectionNamed(topic, section).whole);
		},
		hits,
	};
}
