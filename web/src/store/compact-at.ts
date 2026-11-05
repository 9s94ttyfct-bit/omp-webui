import type { CompactAt, CompactSettings } from "@shared/compact-at.ts";
import { sessionActions } from "../lib/api.ts";
import { ompOverride } from "./omp-override.ts";

/**
 * Where a conversation compacts ("Compact at": omp's `compaction.thresholdPercent` / `thresholdTokens`) — omp's own
 * default and the point single conversations chose (see `ompOverride`). A conversation's own point is its overlay's,
 * which omp reloads by itself, so a change applies from its next turn.
 */
const compactAt = ompOverride<CompactSettings, CompactAt, CompactAt | null>({
	get: (file) => sessionActions.compactAt(file),
	setDefault: (at) => sessionActions.setCompactAt(at),
	setSession: (file, at) => sessionActions.setSessionCompactAt(file, at),
	shownDefault: (at) =>
		at
			? { percent: "percent" in at ? at.percent : -1, tokens: "tokens" in at ? at.tokens : -1 }
			: { percent: -1, tokens: -1 },
});

export const useCompactAt = compactAt.use;
/** Set omp's own point, as `omp config set` does; null: omp's default again. */
export const setCompactAtDefault = compactAt.setDefault;
/** `at` null: the conversation follows omp's configuration again. */
export const setConversationCompactAt = compactAt.setConversation;
