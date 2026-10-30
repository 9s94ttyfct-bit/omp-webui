import { useEffect, useState } from "react";
import { type SavedApproval, sessionActions } from "./api.ts";

/**
 * The tool approval mode a saved conversation comes back in, from the server (what the user picked for it, else their
 * default, else omp's own setting for its folder). Asked while `enabled`, which is while no omp runs for it: a
 * running one says so itself. Null until the answer is here.
 */
export function useSavedApproval(file: string | null, enabled: boolean): SavedApproval | null {
	const [saved, setSaved] = useState<{ file: string; approval: SavedApproval } | null>(null);
	useEffect(() => {
		if (!file || !enabled) return;
		let current = true;
		sessionActions
			.sessionApproval(file)
			.then((approval) => current && setSaved({ file, approval }))
			.catch(() => {});
		return () => {
			current = false;
		};
	}, [file, enabled]);
	return saved?.file === file ? saved.approval : null;
}
