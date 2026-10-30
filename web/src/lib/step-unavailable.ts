import type { StepUnavailable } from "@shared/compact-queue.ts";
import "../i18n/later.ts";
import type { MessageKey } from "../i18n/index.ts";

/** Why a compact asked to run between steps waits for the end of the turn instead, as the person is told (#651). */
export const STEP_UNAVAILABLE_TEXT: Record<StepUnavailable, MessageKey> = {
	trustedExtension: "chat.compactStepTrusted",
	notLoaded: "chat.compactStepNotLoaded",
	noContinue: "chat.compactStepNoContinue",
};
