import { sessionActions } from "../lib/api.ts";
import { ompOverride } from "./omp-override.ts";

/**
 * Whether a failed turn waits out its provider's usage limit: omp's own setting (`retry.waitForUsageReset`, the same
 * one `omp config` shows and changes) and the choices made for single conversations (see `ompOverride`).
 */
const usageWait = ompOverride<boolean, boolean, boolean>({
	get: (file) => sessionActions.usageWait(file),
	setDefault: (enabled) => sessionActions.setUsageWait(enabled),
	setSession: (file, enabled) => sessionActions.setSessionUsageWait(file, enabled),
	shownDefault: (enabled) => enabled,
});

export const watchUsageWait = usageWait.watch;
export const useUsageWait = usageWait.use;
/** Set omp's own `retry.waitForUsageReset`, as `omp config set` does. */
export const setUsageWaitDefault = usageWait.setDefault;
/** `enabled` null: the conversation follows omp's setting again. */
export const setConversationUsageWait = usageWait.setConversation;
