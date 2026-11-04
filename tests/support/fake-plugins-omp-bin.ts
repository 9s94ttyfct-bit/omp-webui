import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { RECOMMENDED_MARKETPLACES } from "../../shared/plugins-catalogs.ts";

/**
 * A stand-in for the `omp plugin …` and `omp skill …` the Plugins page runs, for its Discover, Skills and MCP tests with
 * no network: marketplaces are added by name only (a recommended repository gets its catalog's name), omp's skill registry
 * is two skills (one ships scripts). What it holds is kept in `~/.fake-plugins-omp.json` (the test's own HOME), written
 * whole by a change only (the server runs several listings at once), and every command line it was given is a line of
 * `~/.fake-plugins-omp.calls`. Printed as omp 18.16 prints it. Anything else is the long-run stand-in (`long-fake-omp.ts`).
 */

interface State {
	marketplaces: { name: string; source: string }[];
	/** Registry skills installed: id, version, and whether for the user (`-g`). */
	skills: { id: string; version: string; global: boolean }[];
	/** The global `disabledExtensions`. */
	disabled?: string[];
}

const REGISTRY_SKILLS = [
	{ scope: "acme", name: "pdf-tools", version: "1.2.0", description: "Fill in and read PDF forms.", scripts: false },
	{ scope: "acme", name: "shell-helpers", version: "0.3.1", description: "Small shell helpers.", scripts: true },
];

const argv = process.argv.slice(2);
const file = join(homedir(), ".fake-plugins-omp.json");
const state: State = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { marketplaces: [], skills: [] };
/** A change: the whole state written to a file of its own that then replaces it, so a listing never reads half of it. */
const save = () => {
	writeFileSync(`${file}.${process.pid}`, JSON.stringify(state, null, 2));
	renameSync(`${file}.${process.pid}`, file);
};
const fail = (text: string): never => {
	process.stderr.write(`${text}\n`);
	process.exit(1);
};

if (argv[0] !== "plugin" && argv[0] !== "skill" && argv[0] !== "config") {
	// Not the Plugins page's: the long-run stand-in answers it (a version, or a conversation's `--mode rpc`). It reads its
	// own arguments as it is loaded, so it is loaded only here (a static import would run it for every command).
	await import("./long-fake-omp.ts");
} else {
	appendFileSync(join(homedir(), ".fake-plugins-omp.calls"), `${JSON.stringify(argv)}\n`);
	const unchanged = JSON.stringify(state);
	const [, verb, ...rest] = argv;
	const words = rest.filter((a) => !a.startsWith("-"));
	if (argv[0] === "plugin") {
		if (verb === "marketplace" && words[0] === "list") {
			console.log(
				state.marketplaces.length
					? `Configured Marketplaces:\n\n${state.marketplaces.map((m) => `  ${m.name}  ${m.source}`).join("\n")}`
					: "No marketplaces configured.",
			);
		} else if (verb === "marketplace" && words[0] === "add") {
			const source = words[1];
			const name = RECOMMENDED_MARKETPLACES.find((m) => m.repo === source)?.name ?? source.split("/").at(-1) ?? source;
			if (state.marketplaces.some((m) => m.name === name)) fail(`Marketplace "${name}" already exists`);
			state.marketplaces.push({ name, source });
			writeCatalogs();
			console.log(`✔ Added marketplace ${name}`);
		} else if (verb === "marketplace" && words[0] === "remove") {
			state.marketplaces = state.marketplaces.filter((m) => m.name !== words[1]);
			writeCatalogs();
		} else if (verb === "discover") {
			console.log(`  example-plugin@1.0.0\n    An example plugin of ${words[0]}`);
		} else if (verb === "list") {
			console.log(JSON.stringify({ npm: [], marketplace: [] }));
		} else if (verb === "doctor") {
			console.log("[]");
		}
	} else if (argv[0] === "config") {
		// `disabledExtensions` only, as omp layers it: the folder's own `.omp/config.yml` replaces the global value there.
		const project = projectDisabled();
		if (verb === "get") console.log(JSON.stringify({ key: words[0], value: project ?? state.disabled ?? [] }));
		else if (verb === "list")
			console.log(JSON.stringify(project ? { disabledExtensions: { value: project, type: "array" } } : {}));
		else if (verb === "set") {
			state.disabled = JSON.parse(words[1]);
			console.log(
				JSON.stringify({ key: words[0], value: state.disabled, ...(project ? { overriddenBy: "project" } : {}) }),
			);
		}
	} else {
		const home = homedir();
		if (verb === "list") {
			const off = new Set(projectDisabled() ?? state.disabled ?? []);
			const skills = [
				{
					name: "house-style",
					description: "Write in the house style.",
					filePath: join(home, ".omp", "agent", "skills", "house-style", "SKILL.md"),
					source: "custom:user",
					hide: false,
				},
				...state.skills.map((s) => {
					const [scope, name] = s.id.slice(1).split("/");
					return {
						name,
						description: REGISTRY_SKILLS.find((r) => r.name === name)?.description,
						filePath: join(home, ".omp", "skillshare", `@${scope}`, name, s.version, "SKILL.md"),
						source: `skillshare:${s.global ? "user" : "project"}`,
						hide: false,
					};
				}),
			];
			const on = skills.filter((s) => !off.has(`skill:${s.name}`));
			console.log(JSON.stringify({ skills: on, warnings: [] }));
		} else if (verb === "search") {
			const q = words[0].toLowerCase();
			const hits = REGISTRY_SKILLS.filter((s) => `${s.scope}/${s.name} ${s.description}`.toLowerCase().includes(q)).map(
				(s) => ({
					scope: s.scope,
					name: s.name,
					version: s.version,
					description: s.description,
					weeklyDownloads: 12,
					updatedAt: Date.now(),
					publisher: { username: s.scope },
					keywords: [],
					deprecated: null,
				}),
			);
			console.log(JSON.stringify({ total: hits.length, page: 1, perPage: 20, hits }, null, 2));
		} else if (verb === "install") {
			const spec = words[0];
			const skill = REGISTRY_SKILLS.find((s) => spec.startsWith(`@${s.scope}/${s.name}`));
			if (!skill) fail(`error @${spec} was not found in the registry`);
			else {
				const id = `@${skill.scope}/${skill.name}`;
				if (skill.scripts && !rest.includes("-y"))
					fail(
						`error ${id}@${skill.version} ships scripts:\n  scripts/run.sh (executable)\nRefusing to install scripts without confirmation; re-run with --yes to allow them.`,
					);
				state.skills = state.skills.filter((s) => s.id !== id);
				state.skills.push({ id, version: skill.version, global: rest.includes("-g") });
				console.log(`+ ${id}@${skill.version}`);
			}
		} else if (verb === "uninstall") {
			if (!state.skills.some((s) => s.id === words[0])) fail(`error ${words[0]} is not installed`);
			state.skills = state.skills.filter((s) => s.id !== words[0]);
			console.log(`- ${words[0]}`);
		}
	}
	if (JSON.stringify(state) !== unchanged) save();
}

/** The folder's own `disabledExtensions` (`./.omp/config.yml`), or null where it sets none. */
function projectDisabled(): string[] | null {
	const path = join(process.cwd(), ".omp", "config.yml");
	if (!existsSync(path)) return null;
	const doc = Bun.YAML.parse(readFileSync(path, "utf8")) as Record<string, unknown> | null;
	return Array.isArray(doc?.disabledExtensions) ? (doc.disabledExtensions as string[]) : null;
}

/**
 * What omp keeps of its marketplaces besides: `~/.omp/marketplaces.json`, each with its cached catalog
 * (`marketplace.json`), where the example plugin has a category, an author, tags and keywords, and two skills.
 */
function writeCatalogs(): void {
	const root = join(homedir(), ".omp");
	const marketplaces = state.marketplaces.map((m) => {
		const dir = join(root, "plugins", "cache", "marketplaces", m.name);
		const catalogPath = join(dir, "marketplace.json");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			catalogPath,
			JSON.stringify({
				name: m.name,
				plugins: [
					{
						name: "example-plugin",
						source: "./",
						category: "Development",
						author: { name: "Example Author" },
						homepage: "https://example.com/plugin",
						tags: ["Testing"],
						keywords: ["testing", "lint"],
						skills: ["./skills/a", "./skills/b"],
					},
				],
			}),
		);
		return { name: m.name, sourceType: "github", sourceUri: m.source, catalogPath };
	});
	mkdirSync(root, { recursive: true });
	writeFileSync(join(root, "marketplaces.json"), JSON.stringify({ version: 1, marketplaces }));
}
