import { GUIDANCE_MAX, type SessionGuidance } from "@shared/model-guidance.ts";
import { isRememberedGuidance } from "@shared/prefs.ts";

/**
 * The guidance New chat starts with (v0.17.0 §4): the one the last new chat was started with (`ompw.guidanceLast`), else
 * the template Settings makes the default for new chats (`ompw.guidanceDefault`). A remembered template deleted since is
 * not it: Settings' default is. `templateIds` null: the templates are not known yet, and the id is trusted (the server reads
 * its text; one deleted carries nothing).
 */
export function initialGuidance(
	last: string | null,
	settingsDefault: string | null,
	templateIds: ReadonlySet<string> | null,
): SessionGuidance | null {
	const byDefault = settingsDefault ? { template: settingsDefault } : null;
	const remembered = parse(last);
	if (!remembered) return byDefault;
	if ("none" in remembered) return null;
	if ("text" in remembered) return { text: remembered.text };
	return templateIds === null || templateIds.has(remembered.template) ? { template: remembered.template } : byDefault;
}

/** What a conversation started from New chat with `guidance` leaves remembered: a template by its id, text, or none. */
export function guidanceToRemember(guidance: SessionGuidance | null): string {
	if (guidance?.template) return JSON.stringify({ template: guidance.template });
	if (guidance?.text) return JSON.stringify({ text: guidance.text.slice(0, GUIDANCE_MAX) });
	return JSON.stringify({ none: true });
}

function parse(value: string | null) {
	if (!value) return null;
	try {
		const v: unknown = JSON.parse(value);
		return isRememberedGuidance(v) ? v : null;
	} catch {
		return null;
	}
}
