import type { ConversationModels } from "@shared/model-config.ts";
import { useEffect, useState } from "react";
import { sessionActions } from "./api.ts";

/**
 * The model preset a saved conversation comes back with, from the server (the one it was switched to, which survives
 * a restart). Asked while `enabled`, which is while no omp runs for it: a running one says so itself. Null until the
 * answer is here, when the conversation has no preset of its own, and when the server cannot say.
 */
export function useSavedModels(file: string | null, enabled: boolean): ConversationModels | null {
	const [saved, setSaved] = useState<{ file: string; models: ConversationModels | null } | null>(null);
	useEffect(() => {
		if (!file || !enabled) return;
		let current = true;
		sessionActions
			.sessionModels(file)
			.then(({ models }) => current && setSaved({ file, models }))
			.catch(() => {});
		return () => {
			current = false;
		};
	}, [file, enabled]);
	return saved?.file === file ? saved.models : null;
}
