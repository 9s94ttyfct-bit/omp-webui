import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { readModeFile } from "../../server/offline/settings.ts";
import { parseTopic, type Topic } from "../../server/omp/docs-tool/lookup.ts";
import { isLocalOnlyRoute } from "../../server/this-computer.ts";
import { COMPACT_KEYS } from "../../shared/compact-at.ts";
import { DEFAULT_GUARD_CONFIG } from "../../shared/guard.ts";
import { DEFAULT_OFFLINE } from "../../shared/offline.ts";
import { PREF_KEYS } from "../../shared/prefs.ts";
import { DEFAULT_REMOTE_CONFIG } from "../../shared/remote.ts";
import { SESSION_DEFAULTS } from "../../shared/session-defaults.ts";
import { SETTINGS } from "../../web/src/lib/settings-search.ts";

/**
 * The agent-facing docs (`docs/agents/*.md`) and the code they describe are held to each other, both ways: a setting, a
 * Settings entry or an API route that the code has and no doc names fails here, and so does a doc that names one the code
 * no longer has. What counts as each is read from the modules that define it, not from a list kept here:
 *
 * - **Setting keys** (a table whose first column is `Key`): the web UI's synced preferences (`PREF_KEYS`), the guard's
 *   settings (`DEFAULT_GUARD_CONFIG`, `guard.json:<field>`), remote access (`DEFAULT_REMOTE_CONFIG`, `remote.json:<field>`),
 *   Full / Light (`mode.json:<field>`, `mode.json:offline.<field>`), the session controls a conversation can make omp's
 *   defaults (`SESSION_DEFAULTS`, `session:<name>`) and omp's compaction settings the app reads and writes
 *   (`COMPACT_KEYS`, `omp:<key>`). A table may also name a per-device key (`ompw.*` that is in the web UI's source).
 * - **Settings entries**: every id of the Settings page's catalogue (`web/src/lib/settings-search.ts`) is in exactly the
 *   `settings:` front matter of the topics.
 * - **API routes** (a table whose first column is `Route`): every `/api/…` path the server spells out, and its access
 *   column says `local-only` exactly for the routes `isLocalOnlyRoute` keeps to this computer.
 */

const root = join(import.meta.dir, "..", "..");
const docsDir = join(root, "docs", "agents");

const docFiles = readdirSync(docsDir)
	.filter((f) => f.endsWith(".md"))
	.sort();
const topics: Topic[] = docFiles.map((f) => parseTopic(f.slice(0, -3), readFileSync(join(docsDir, f), "utf8")));
const featureTopics = topics.filter((t) => t.name !== "index");

/** Every `.ts` file under `dir`. */
function sources(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) return sources(path);
		return name.endsWith(".ts") || name.endsWith(".tsx") || name.endsWith(".html") ? [path] : [];
	});
}
const serverText = [...sources(join(root, "server")), ...sources(join(root, "shared"))]
	.map((f) => readFileSync(f, "utf8"))
	.join("\n");
const webText = [...sources(join(root, "web")), ...sources(join(root, "shared"))]
	.map((f) => readFileSync(f, "utf8"))
	.join("\n");

interface Row {
	topic: string;
	cells: string[];
}

/** The rows of every Markdown table whose first header cell is `first`. */
function tableRows(first: string): Row[] {
	const rows: Row[] = [];
	for (const topic of topics) {
		const lines = topic.body.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const cells = splitRow(lines[i]);
			if (cells?.[0] !== first || !/^\|?\s*:?-{3,}/.test(lines[i + 1] ?? "")) continue;
			for (let j = i + 2; j < lines.length && lines[j].trim().startsWith("|"); j++) {
				rows.push({ topic: topic.name, cells: splitRow(lines[j]) ?? [] });
			}
		}
	}
	return rows;
}

function splitRow(line: string): string[] | null {
	const t = line.trim();
	if (!t.startsWith("|")) return null;
	// A `|` inside a code span (`a \| b`) is escaped in the docs, so a plain split is a cell split.
	return t
		.replace(/^\||\|$/g, "")
		.split(/(?<!\\)\|/)
		.map((c) => c.trim());
}

/** The one code span of a first cell: the key or route it names. */
function keyOf(cell: string): string | null {
	const spans = [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
	return spans.length === 1 ? spans[0] : null;
}

const codeKeys = new Set<string>([
	...PREF_KEYS,
	...Object.keys(DEFAULT_GUARD_CONFIG).map((k) => `guard.json:${k}`),
	...Object.keys(DEFAULT_REMOTE_CONFIG).map((k) => `remote.json:${k}`),
	...Object.keys(readModeFile({ version: 2 }))
		.filter((k) => k !== "offline" && k !== "migrated")
		.map((k) => `mode.json:${k}`),
	...Object.keys(DEFAULT_OFFLINE).map((k) => `mode.json:offline.${k}`),
	...Object.keys(SESSION_DEFAULTS).map((k) => `session:${k}`),
	...Object.values(COMPACT_KEYS).map((k) => `omp:${k}`),
]);
/** Keys of this browser alone (localStorage, never synced): a doc may name them, and they must be in the web UI's source. */
const deviceKeys = new Set([...webText.matchAll(/["'`](ompw\.[A-Za-z0-9._-]*[A-Za-z0-9])/g)].map((m) => m[1]));

const keyRows = tableRows("Key");
const documentedKeys = new Set(keyRows.map((r) => keyOf(r.cells[0])).filter((k): k is string => k !== null));

/**
 * The server's code without its comment lines: a comment names routes of other programs too (Ollama's `/api/tags`, which
 * the server asks a local model server for), and a route is what the code spells out.
 */
const serverCode = serverText
	.split("\n")
	.filter((line) => !/^\s*(\*|\/\*|\/\/)/.test(line))
	.join("\n");

/** Every route the server spells out, and the prefixes it builds the rest from (`/api/controls/` + an action). */
const literals = new Set([...serverCode.matchAll(/["'`](\/api\/[A-Za-z0-9/_.-]*)/g)].map((m) => m[1]));
const codeRoutes = [...literals].filter((r) => !r.endsWith("/") && r !== "/api").sort();
const routePrefixes = [...literals].filter((r) => r.endsWith("/") && r !== "/api/");

const routeRows = tableRows("Route");
const routeOf = (cell: string) => keyOf(cell)?.replace(/\?.*$/, "") ?? null;
const documentedRoutes = new Set(routeRows.map((r) => routeOf(r.cells[0])).filter((r): r is string => r !== null));

describe("docs/agents is complete and well formed", () => {
	test("every topic has front matter and the six sections, in order", () => {
		expect(featureTopics.length).toBeGreaterThan(10);
		const required = ["What it does", "Where it is", "Settings", "API routes", "Limits and caveats", "Security notes"];
		for (const t of featureTopics) {
			expect({ topic: t.name, title: t.title !== t.name, summary: t.summary.length > 0 }).toEqual({
				topic: t.name,
				title: true,
				summary: true,
			});
			const h2 = t.sections.filter((s) => s.level === 2).map((s) => s.heading);
			expect({ topic: t.name, sections: h2.filter((h) => required.includes(h)) }).toEqual({
				topic: t.name,
				sections: required,
			});
		}
	});

	test("the index and llms.txt link every topic, and nothing that is not one", () => {
		const index = readFileSync(join(docsDir, "index.md"), "utf8");
		const llms = readFileSync(join(root, "llms.txt"), "utf8");
		const linked = (text: string, prefix: string) =>
			new Set(
				[...text.matchAll(/\]\(([^)#]+\.md)(?:#[^)]*)?\)/g)]
					.map((m) => m[1])
					.filter((p) => p.startsWith(prefix))
					.map((p) => p.slice(prefix.length)),
			);
		const files = new Set(featureTopics.map((t) => `${t.name}.md`));
		expect([...linked(index, "")].sort()).toEqual([...files].sort());
		expect([...linked(llms, "docs/agents/")].sort()).toEqual([...files, "index.md"].sort());
		expect(llms.startsWith("# omp-webui\n")).toBe(true);
		expect(/^> .+/m.test(llms)).toBe(true);
	});
});

describe("settings: the code and docs/agents name the same keys", () => {
	test("every setting key in the code is documented in a Key table", () => {
		const missing = [...codeKeys].filter((k) => !documentedKeys.has(k)).sort();
		expect(missing).toEqual([]);
	});

	test("every key a Key table documents is one the code has", () => {
		const stale = [...documentedKeys].filter((k) => !codeKeys.has(k) && !deviceKeys.has(k)).sort();
		expect(stale).toEqual([]);
		const unreadable = keyRows.filter((r) => keyOf(r.cells[0]) === null).map((r) => `${r.topic}: ${r.cells[0]}`);
		expect(unreadable).toEqual([]);
	});

	test("every `ompw.*` key the docs mention anywhere exists in the code", () => {
		const mentioned = new Set(
			topics.flatMap((t) => [...t.body.matchAll(/`(ompw\.[A-Za-z0-9._-]*[A-Za-z0-9])`/g)].map((m) => m[1])),
		);
		const stale = [...mentioned].filter((k) => !codeKeys.has(k) && !deviceKeys.has(k)).sort();
		expect(stale).toEqual([]);
	});

	test("every Settings entry is covered by exactly one topic's front matter", () => {
		const covered = featureTopics.flatMap((t) => t.settings);
		const ids = SETTINGS.map((s) => s.id);
		expect([...new Set(covered)].sort()).toEqual([...ids].sort());
		expect(covered.length).toBe(new Set(covered).size);
	});

	test("every `OMP_WEBUI_*` variable the docs name is read by the code", () => {
		const named = new Set(
			topics.flatMap((t) => [...t.body.matchAll(/\b(OMP_WEBUI_[A-Z0-9_]*[A-Z0-9])\b/g)].map((m) => m[1])),
		);
		const stale = [...named].filter((v) => !new RegExp(`\\b${v}\\b`).test(serverText)).sort();
		expect(stale).toEqual([]);
	});
});

describe("API routes: the server and docs/agents name the same routes", () => {
	test("every route the server spells out is documented in a Route table", () => {
		const missing = codeRoutes.filter((r) => !documentedRoutes.has(r));
		expect(missing).toEqual([]);
	});

	test("every documented route is one the server has", () => {
		const known = (route: string) => {
			if (literals.has(route)) return true;
			// A route a constant is the base of: `${PUSH_API}/subscribe`, where `PUSH_API` is `/api/push`.
			const built = [...literals].some(
				(l) => !l.endsWith("/") && route.startsWith(`${l}/`) && serverCode.includes(`}/${route.slice(l.length + 1)}\``),
			);
			if (built) return true;
			const prefix = routePrefixes.find((p) => route.startsWith(p));
			if (!prefix) return false;
			const rest = route.slice(prefix.length);
			if (/[<{]/.test(rest)) return true;
			const segment = rest.split("/")[0];
			return (
				serverCode.includes(`"${segment}"`) || serverCode.includes(`"/${segment}"`) || serverCode.includes(`"/${rest}"`)
			);
		};
		const stale = [...documentedRoutes].filter((r) => !known(r)).sort();
		expect(stale).toEqual([]);
		const unreadable = routeRows.filter((r) => routeOf(r.cells[0]) === null).map((r) => `${r.topic}: ${r.cells[0]}`);
		expect(unreadable).toEqual([]);
	});

	test("a route's access says local-only exactly when the server keeps it to this computer", () => {
		const wrong = routeRows
			.map((r) => ({ topic: r.topic, route: routeOf(r.cells[0]) ?? "", access: r.cells[2] ?? "" }))
			.filter(({ route, access }) => {
				const concrete = route.replace(/[<{].*$/, "x");
				return access.toLowerCase().startsWith("local-only") !== isLocalOnlyRoute(concrete);
			})
			.map((r) => `${r.topic}: ${r.route} (${r.access})`);
		expect(wrong).toEqual([]);
	});
});

test("the docs directory is plain Markdown, one level deep", () => {
	for (const name of readdirSync(docsDir)) {
		expect(statSync(join(docsDir, name)).isFile()).toBe(true);
		expect(name).toMatch(/^[a-z0-9][a-z0-9-]*\.md$/);
	}
	expect(relative(root, docsDir)).toBe(join("docs", "agents"));
});
