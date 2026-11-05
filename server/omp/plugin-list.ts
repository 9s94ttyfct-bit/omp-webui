import { lstatSync } from "node:fs";
import { isRecord } from "../../shared/guards.ts";

/**
 * `omp plugin list --json` (omp 18.16), as every view of it reads it (the Plugins page, the Loaded dialog, the update
 * check): `npm` plugins (git installs and links to a folder too) and `marketplace` ones, with omp's quirks read in one place.
 */

/** One plugin as omp lists it. */
export interface ListedPlugin {
	kind: "npm" | "marketplace";
	/** An npm plugin's package name; a marketplace plugin's `name@marketplace`. */
	id: string;
	version: string | null;
	/** As omp names it (`user`, `project`); null where it names none. */
	scope: string | null;
	enabled: boolean;
	path: string | null;
	/** A user plugin the folder has too: the folder's is the one that loads. */
	shadowedBy?: "project";
	/** An npm plugin's manifest; `{}` for a marketplace plugin and where omp lists none. */
	manifest: Record<string, unknown>;
	/** An npm plugin's chosen features, as omp lists them. */
	enabledFeatures: unknown;
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** Every plugin of `omp plugin list --json`; throws when omp answered something else. */
export function parsePluginList(doc: unknown): ListedPlugin[] {
	if (!isRecord(doc)) throw new Error("omp plugin list answered in a form this does not know");
	const out: ListedPlugin[] = [];
	for (const p of Array.isArray(doc.npm) ? doc.npm : []) {
		if (!isRecord(p) || typeof p.name !== "string") continue;
		out.push({
			kind: "npm",
			id: p.name,
			version: str(p.version),
			scope: str(p.scope),
			enabled: p.enabled !== false,
			path: str(p.path),
			manifest: isRecord(p.manifest) ? p.manifest : {},
			enabledFeatures: p.enabledFeatures,
		});
	}
	for (const p of Array.isArray(doc.marketplace) ? doc.marketplace : []) {
		if (!isRecord(p) || typeof p.id !== "string") continue;
		// Its version, folder and switch are on its entries (`omp plugin disable` writes the switch there).
		const entry = Array.isArray(p.entries) && isRecord(p.entries[0]) ? p.entries[0] : {};
		out.push({
			kind: "marketplace",
			id: p.id,
			version: str(entry.version),
			scope: str(p.scope) ?? str(entry.scope),
			enabled: p.enabled !== false && entry.enabled !== false,
			path: str(entry.installPath),
			...(p.shadowedBy === "project" ? { shadowedBy: "project" as const } : {}),
			manifest: {},
			enabledFeatures: undefined,
		});
	}
	return out;
}

/** Whether a path is a link: a plugin `omp plugin link` or a path install put in place, the person's own folder. */
export function isLink(path: string | null): boolean {
	if (!path) return false;
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}
