import type { PluginMarketplace } from "./plugins.ts";

/**
 * Well-known places to get plugins, skills and MCP servers from, which the Plugins page offers to add with one click (the
 * marketplaces) or links to (the web catalogs). Each marketplace was checked to hold a `.claude-plugin/marketplace.json`
 * under that name (2026-11-03), so `omp plugin marketplace add <repo>` adds it as `name`. Their descriptions are the
 * page's strings (`plugins.rec_*`, English and Chinese), keyed by `name`.
 *
 * Not listed: `anthropics/claude-code` (`claude-code-plugins`), which Anthropic deprecated for `claude-plugins-official`.
 */

export type RecommendedKind = "plugins" | "skills";

export interface RecommendedMarketplace {
	/** `owner/repo` on GitHub: what `omp plugin marketplace add` is given. */
	repo: string;
	/** The name its catalog gives itself: what goes after `@` in `plugin@marketplace`. */
	name: string;
	/** What it mostly offers: plugins, or skills (a skill library is a marketplace of plugins that carry skills). */
	kind: RecommendedKind;
	/** Published by Anthropic. */
	anthropic: boolean;
	/** Anthropic's official marketplace. */
	official: boolean;
}

export const RECOMMENDED_MARKETPLACES = [
	{
		repo: "anthropics/claude-plugins-official",
		name: "claude-plugins-official",
		kind: "plugins",
		anthropic: true,
		official: true,
	},
	{
		repo: "anthropics/claude-plugins-community",
		name: "claude-community",
		kind: "plugins",
		anthropic: true,
		official: false,
	},
	{
		repo: "anthropics/knowledge-work-plugins",
		name: "knowledge-work-plugins",
		kind: "plugins",
		anthropic: true,
		official: false,
	},
	{ repo: "wshobson/agents", name: "claude-code-workflows", kind: "plugins", anthropic: false, official: false },
	{
		repo: "obra/superpowers-marketplace",
		name: "superpowers-marketplace",
		kind: "plugins",
		anthropic: false,
		official: false,
	},
	{
		repo: "EveryInc/compound-engineering-plugin",
		name: "compound-engineering-plugin",
		kind: "plugins",
		anthropic: false,
		official: false,
	},
	{
		repo: "jeremylongshore/claude-code-plugins-plus-skills",
		name: "claude-code-plugins-plus",
		kind: "plugins",
		anthropic: false,
		official: false,
	},
	{
		repo: "ChromeDevTools/chrome-devtools-mcp",
		name: "chrome-devtools-plugins",
		kind: "plugins",
		anthropic: false,
		official: false,
	},
	{ repo: "anthropics/skills", name: "anthropic-agent-skills", kind: "skills", anthropic: true, official: false },
	{ repo: "trailofbits/skills", name: "trailofbits", kind: "skills", anthropic: false, official: false },
	{
		repo: "addyosmani/web-quality-skills",
		name: "addy-web-quality-skills",
		kind: "skills",
		anthropic: false,
		official: false,
	},
] as const satisfies readonly RecommendedMarketplace[];

export type RecommendedName = (typeof RECOMMENDED_MARKETPLACES)[number]["name"];

/** `owner/repo` of a marketplace's source as omp lists it: `owner/repo`, a GitHub URL (with or without `.git`). */
function githubRepo(source: string): string | null {
	const s = source
		.trim()
		.replace(/\/+$/, "")
		.replace(/\.git$/, "");
	const m = /^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:|github:)?([\w.-]+\/[\w.-]+)$/i.exec(s);
	return m ? m[1].toLowerCase() : null;
}

/**
 * The configured marketplace a recommended one already is: the same name (omp's names are unique, so adding it again would
 * fail), or the same GitHub repository however its source is written. Null: not added.
 */
export function addedMarketplace(
	rec: Pick<RecommendedMarketplace, "repo" | "name">,
	configured: readonly PluginMarketplace[],
): PluginMarketplace | null {
	const repo = rec.repo.toLowerCase();
	return configured.find((m) => m.name === rec.name || githubRepo(m.source) === repo) ?? null;
}

/** A catalog that lives on the web: the page links to it, it is not searched from here. */
export interface WebCatalog {
	name: string;
	url: string;
}

/** Where people browse plugins, skills and MCP servers on the web. */
export const WEB_CATALOGS: Record<"plugins" | "skills" | "mcp", readonly WebCatalog[]> = {
	plugins: [{ name: "claude.com/marketplace", url: "https://claude.com/marketplace/plugins" }],
	skills: [{ name: "skills.omp.sh", url: "https://skills.omp.sh/" }],
	// Smithery's own registry API needs an API key, so it is not searched here: its site is.
	mcp: [
		{ name: "Smithery", url: "https://smithery.ai/" },
		{ name: "Glama", url: "https://glama.ai/mcp/servers" },
		{ name: "mcp.so", url: "https://mcp.so/" },
	],
};
