import type { SessionSummary } from "@shared/protocol.ts";
import { shortPath } from "./format.ts";

/** How a project is named in a table: the words on the row, and the full address as its title. */
export interface ProjectLabel {
	label: string;
	title: string;
}

type Known = Pick<SessionSummary, "file" | "cwd" | "project" | "modifiedAt">;

/** The last part of a path: what the sidebar and the conversation list call a project. */
const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/**
 * What the usage tables call each of `folders`, which omp's stats give as the directory it files a project's
 * conversations in: the working directory with its separators turned into dashes (`-tmp-dev-acme-api`). The dashes cannot
 * be told from the dashes of a name, so the directory is not decoded; the conversations are asked instead: each lies in
 * that directory and records where it ran. A folder none of them lies in keeps its directory name. Projects that share a
 * last name (`/work/api`, `/old/api`) are told apart by their path.
 */
export function projectLabels(folders: string[], sessions: Known[], home?: string): Map<string, ProjectLabel> {
	// The folder each directory was last used for: the newest conversation says so, should two disagree.
	const ran = new Map<string, Known>();
	for (const s of sessions) {
		const directory = s.file.split(/[\\/]/).at(-2) ?? "";
		const seen = ran.get(directory);
		if (!seen || s.modifiedAt > seen.modifiedAt) ran.set(directory, s);
	}
	const labels = new Map<string, ProjectLabel>();
	for (const folder of folders) {
		const known = ran.get(folder);
		if (known) labels.set(folder, { label: known.project, title: shortPath(known.cwd, home) });
		// A path, as a test's stats give one (omp's own stats never do).
		else if (/^([\\/]|[A-Za-z]:)/.test(folder))
			labels.set(folder, { label: baseName(folder), title: shortPath(folder, home) });
		else labels.set(folder, { label: folder, title: folder });
	}
	const used = new Map<string, number>();
	for (const { label } of labels.values()) used.set(label, (used.get(label) ?? 0) + 1);
	for (const entry of labels.values()) if ((used.get(entry.label) ?? 0) > 1) entry.label = entry.title;
	return labels;
}
