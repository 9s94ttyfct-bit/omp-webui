import { isRecord } from "./guards.ts";

/**
 * The Plugins page (`#/plugins`): omp's plugins as omp's own CLI (`omp plugin …`) reports them, and the changes the page
 * asks the server to make with it. See `server/omp/plugins.ts`.
 */

export type PluginScope = "user" | "project";
export const PLUGIN_SCOPES: readonly PluginScope[] = ["user", "project"];
export const isPluginScope = (v: unknown): v is PluginScope => v === "user" || v === "project";

/** Something the server could not read from omp, in omp's own words. */
export interface PluginsFailure {
	error: string;
}

export function isPluginsFailure(v: unknown): v is PluginsFailure {
	return isRecord(v) && typeof v.error === "string";
}

/** One optional feature of a plugin (its `omp.features` in `package.json`). */
export interface PluginFeature {
	name: string;
	description: string | null;
	/** On when the person has not chosen the plugin's features. */
	default: boolean;
	/** On now: the chosen features, or the defaults when none were chosen. */
	enabled: boolean;
}

/**
 * One installed plugin. `npm` covers git installs too, as `omp plugin list` groups them; `linked` is a local folder
 * (`omp plugin link`, or `omp plugin install <path>`); `marketplace` came from a marketplace's catalog.
 */
export interface InstalledPlugin {
	/** What omp's CLI names it by: the package name, or `name@marketplace`. */
	id: string;
	name: string;
	source: "npm" | "linked" | "marketplace";
	marketplace: string | null;
	scope: PluginScope;
	version: string | null;
	description: string | null;
	enabled: boolean;
	/** A user-scoped marketplace plugin that the folder also has: the folder's copy is the one omp loads. */
	shadowedBy?: "project";
	/** Where omp has it on disk. */
	path: string | null;
	/** Its optional features; empty when it has none (marketplace plugins have none omp can switch). */
	features: PluginFeature[];
	/** Whether it declares settings (`omp plugin config`). */
	hasSettings: boolean;
	/** A newer version in its marketplace's catalog (`omp plugin upgrade --dry-run`); null: none, or not a marketplace plugin. */
	upgrade: { from: string | null; to: string } | null;
}

/**
 * One plugin of a configured marketplace's catalog (`omp plugin discover <marketplace>`), with what the marketplace's
 * cached catalog (`marketplace.json`, which omp writes) says of it besides: empty where it says nothing.
 */
export interface CatalogPlugin {
	name: string;
	version: string | null;
	description: string | null;
	marketplace: string;
	/** The scopes it is installed in (as `name@marketplace`). */
	installed: PluginScope[];
	/** The catalog's category (`development`, `security`…), lower case. */
	category: string | null;
	author: string | null;
	homepage: string | null;
	/** The catalog's `tags` and `keywords`, lower case, each once. */
	tags: string[];
	/** How many skills it brings, as its catalog entry lists them (0 when it lists none). */
	skills: number;
}

/** A configured marketplace (`omp plugin marketplace list`). */
export interface PluginMarketplace {
	name: string;
	/** Where omp fetches its catalog from: `owner/repo`, a URL or a local folder. */
	source: string;
	/** Why its catalog could not be read (`omp plugin discover`); its plugins are then not listed. */
	error?: string;
}

/** `GET /api/plugins`: each part on its own, so that one omp could not answer does not hide the rest. */
export interface PluginsData {
	/** The folder omp's CLI ran in: its project-scoped plugins are listed with the user's. */
	cwd: string;
	/** The folder is the home folder: there is no project, so nothing can be installed for one. */
	home: boolean;
	installed: InstalledPlugin[] | PluginsFailure;
	marketplaces: PluginMarketplace[] | PluginsFailure;
	catalog: CatalogPlugin[] | PluginsFailure;
	/** Why the check for newer versions failed; null when it answered (each plugin's `upgrade` says what it found). */
	upgradeError: string | null;
}

/** One check of `omp plugin doctor`. */
export interface PluginCheck {
	name: string;
	status: "ok" | "warning" | "error";
	message: string;
	fixed?: boolean;
}

/** One setting a plugin declares, as the page shows it: the value of a secret one is never sent to a page. */
export interface PluginSetting {
	key: string;
	type: string | null;
	description: string | null;
	env: string | null;
	secret: boolean;
	/** Set by the person (not only its default). */
	set: boolean;
	/** The value in force (its default when not set), as text; null for a secret one and for one with no value. */
	value: string | null;
}

/** What a running conversation did after a change: reloaded its plugins, or needs a restart (or a resume) to see it. */
export interface PluginReload {
	liveId: string;
	sessionFile: string | null;
	state: "reloaded" | "restart" | "paused";
}

/** The changes the page makes through a job (`POST /api/plugins/jobs`). */
export const PLUGIN_JOB_ACTIONS = [
	"install",
	"uninstall",
	"upgrade",
	"doctor-fix",
	"marketplace-add",
	"marketplace-remove",
	"marketplace-update",
	"skill-install",
	"skill-uninstall",
	"update",
] as const;
export type PluginJobAction = (typeof PLUGIN_JOB_ACTIONS)[number];

/** One change carried out by omp's CLI, with what it printed so far (`GET /api/plugins/jobs/<id>`). */
export interface PluginJob {
	id: string;
	action: PluginJobAction;
	/** The command, as it would be typed in a terminal; several on lines of their own for a job of several steps. */
	command: string;
	state: "running" | "done" | "failed";
	/** What omp printed so far (its last part when it printed a lot). */
	output: string;
	/** omp's own words for why it failed (for a job of several steps: each step that failed). */
	error: string | null;
	startedAt: number;
	endedAt: number | null;
	/** What each running conversation did with the change (empty when the change is not one a conversation loads). */
	reloads: PluginReload[];
	/**
	 * What omp asks before it does it again: `scripts`, a registry skill that ships scripts, which omp installs from a page
	 * only with `--yes` (it cannot ask there). The page lists what omp printed and asks the person.
	 */
	confirm?: "scripts";
	/** Started by the automatic update (`ompw.extensionsAutoUpdate`), not by the person. */
	auto?: boolean;
}

// ------------------------------------------------------------------ updates

/**
 * A newer version of something installed: a marketplace plugin (its catalog's version, `omp plugin upgrade --dry-run`), an
 * npm plugin (the npm registry's `latest`), or a registry skill (skills.omp.sh's `latest`). `folder`: the project folder of
 * a project-scoped one, null for the user's.
 */
export interface PluginUpdate {
	/** What the page names it by when it asks for it to be updated (`POST /api/plugins/jobs`, `update`). */
	key: string;
	kind: "plugin" | "skill";
	/** `name@marketplace`, an npm package name, or `@scope/name`. */
	id: string;
	source: "marketplace" | "npm" | "registry";
	scope: PluginScope;
	folder: string | null;
	from: string | null;
	to: string;
}

/** Something installed that is not checked for a newer version, and why (the page says it, with what to do instead). */
export interface UncheckedUpdate {
	kind: "plugin" | "skill";
	id: string;
	scope: PluginScope;
	folder: string | null;
	/** `git`: an npm plugin installed from git or a folder spec, whose newer version is known only by reinstalling it. */
	reason: "git" | "error";
	detail: string | null;
}

/** `GET /api/plugins/updates`: the last check, and the automatic update. */
export interface UpdatesState {
	/** A check runs now (refreshing the marketplaces first). */
	checking: boolean;
	checkedAt: number | null;
	updates: PluginUpdate[];
	unchecked: UncheckedUpdate[];
	/** What could not be read in the last check, in omp's words (one line each). */
	errors: string[];
	/** The project folders the check looked in (those of recent conversations with plugins or skills of their own). */
	folders: string[];
	auto: {
		/** `ompw.extensionsAutoUpdate`: check every 6 hours and install what is newer once nothing is busy. */
		on: boolean;
		nextCheckAt: number | null;
		/** What an install that is due waits for; null when it waits for nothing. */
		waitingFor: { working: number; asking: number; paused: number; waiting: number } | null;
		/** The last automatic install: when, how many, and why it failed (null when it did not). */
		last: { at: number; count: number; error: string | null } | null;
	};
}

// ------------------------------------------------------------------ skills

/** One skill omp discovers (`omp skill list --json`), wherever it comes from. */
export interface InstalledSkill {
	name: string;
	description: string | null;
	/** Where omp found it, as omp names the provider: `skillshare` (its registry), `claude-plugins`, `custom`, `agents`… */
	provider: string;
	/** `user` or `project`, as omp reports it. */
	level: string;
	/** Its `SKILL.md`. */
	path: string | null;
	/** Hidden from the model's list (its frontmatter says so); it can still be asked for by name. */
	hidden: boolean;
	/** A skill installed from omp's registry (`omp skill install`): its id and version, what Uninstall needs. */
	registry: { id: string; version: string } | null;
	/** `skill:<name>` is in the global `disabledExtensions` (what every folder without a list of its own uses). */
	offGlobally: boolean;
	/**
	 * Whether the project folder's own list (`<folder>/.omp/config.yml`), which replaces the global one there, turns it
	 * off; null when the folder has no list of its own (or is the home folder).
	 */
	offInProject: boolean | null;
	/** Known only by name: a list turns it off and omp no longer finds it. */
	nameOnly: boolean;
}

/** One skill of omp's registry, skills.omp.sh (`omp skill search --json`). */
export interface SkillHit {
	/** `@scope/name`: what `omp skill install` takes. */
	id: string;
	version: string | null;
	description: string | null;
	weeklyDownloads: number | null;
	publisher: string | null;
	keywords: string[];
	deprecated: string | null;
}

/** `GET /api/plugins/skills/search`. */
export interface SkillSearch {
	total: number;
	hits: SkillHit[];
}

/** `GET /api/plugins/skills`: every skill omp finds, on and off, for the folder the page looks at. */
export interface SkillsData {
	installed: InstalledSkill[];
	/** The folder is a project (not the home folder): it can have a list of its own. */
	project: boolean;
	/** The project folder has its own `disabledExtensions`, which replaces the global list there. */
	projectList: boolean;
}

/** Where a skill is switched (`POST /api/plugins/skills/enable`): every folder's list, or one project folder's. */
export type SkillSwitchScope = "global" | "project";

/** `GET /api/plugins/skills/file`: a skill's `SKILL.md`, at most 256 KiB of it (`cut`: there is more). */
export interface SkillFile {
	path: string;
	text: string;
	cut: boolean;
}

/** Whether a skill is on in the folder the page looks at: the project's own list decides where there is one. */
export const skillOn = (s: InstalledSkill): boolean => !(s.offInProject ?? s.offGlobally);
