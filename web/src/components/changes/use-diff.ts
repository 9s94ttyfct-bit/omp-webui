import type { ChangedFile, FileDiff } from "@shared/changes.ts";
import { useEffect, useState } from "react";
import { ApiError } from "../../lib/api.ts";
import { type FolderScope, folder } from "../../lib/folder-api.ts";

/**
 * What the Changes view and the large view share of a change: reading one file's diff, what makes one file's change
 * another, and the width below which two columns of code hold less than one.
 */

/** Below this width a change is drawn unified only: two columns of code would be narrower than a screenful of text. */
export const SPLIT_MIN_PX = 520;

export type Opened =
	| { state: "loading" }
	| { state: "error"; message: string; gone: boolean }
	| { state: "ok"; diff: FileDiff };

/** What makes one file's change another: its state and its counts. */
export const versionOf = (f: ChangedFile | undefined): string =>
	f ? `${f.state}:${f.staged}:${f.added ?? ""}:${f.removed ?? ""}:${f.binary ?? ""}` : "";

/** The change of the open file, read when it is opened and again when the list says the file's change is another. */
export function useDiff(scope: FolderScope, path: string | null, version: string): Opened {
	const [opened, setOpened] = useState<Opened>({ state: "loading" });
	// biome-ignore lint/correctness/useExhaustiveDependencies: `scope` is rebuilt from two ids
	useEffect(() => {
		if (path === null) return;
		const ctl = new AbortController();
		folder.diff(scope, path, ctl.signal).then(
			(diff) => setOpened({ state: "ok", diff }),
			(e: unknown) => {
				if (ctl.signal.aborted) return;
				const status = e instanceof ApiError ? e.status : 0;
				setOpened({ state: "error", message: e instanceof Error ? e.message : String(e), gone: status === 404 });
			},
		);
		return () => ctl.abort();
	}, [scope.live, scope.file, path, version]);
	// Another file's change is not the one on screen while it is read.
	useEffect(() => {
		if (path !== null) setOpened((o) => (o.state === "ok" && o.diff.path !== path ? { state: "loading" } : o));
	}, [path]);
	return opened;
}
