import {
	BUILTIN_GUIDANCE,
	GUIDANCE_NAME_MAX,
	type GuidanceNameProblem,
	type GuidanceTemplate,
	guidanceSummary,
	guidanceText,
} from "@shared/model-guidance.ts";
import type { MessageKey, Translate } from "../i18n/index.ts";
import { GuidanceApiError } from "./guidance-api.ts";

/**
 * How the shipped guidance templates are shown in the page's language. A template is data the person owns (they rename
 * and rewrite it, and its text is what the model reads), so only one still as shipped is shown by these strings: a
 * renamed one keeps its own name, a rewritten one its own summary line. The text sent to the model is never translated.
 */
const BUILT_IN: Record<string, { name: MessageKey; summary: MessageKey }> = {
	"builtin-one-of-each": { name: "guidance.builtinOneOfEachName", summary: "guidance.builtinOneOfEachSummary" },
	"builtin-simple-complex": {
		name: "guidance.builtinSimpleComplexName",
		summary: "guidance.builtinSimpleComplexSummary",
	},
};

const shippedOf = (tpl: Pick<GuidanceTemplate, "id">) => BUILTIN_GUIDANCE.find((b) => b.id === tpl.id);

/** The name a template is shown by. */
export function templateName(tpl: Pick<GuidanceTemplate, "id" | "name">, t: Translate): string {
	const shipped = shippedOf(tpl);
	const keys = BUILT_IN[tpl.id];
	return shipped && keys && tpl.name === shipped.name ? t(keys.name) : tpl.name;
}

/** The one line that says what a template is about. */
export function templateSummary(tpl: Pick<GuidanceTemplate, "id" | "text">, t: Translate): string {
	const shipped = shippedOf(tpl);
	const keys = BUILT_IN[tpl.id];
	return shipped && keys && guidanceText(tpl.text) === guidanceText(shipped.text)
		? t(keys.summary)
		: guidanceSummary(tpl.text);
}

/** Why a template's name is refused, in the page's language. */
export function nameProblemText(problem: GuidanceNameProblem, t: Translate): string {
	if (problem === "nameEmpty") return t("guidance.nameEmpty");
	if (problem === "nameTooLong") return t("guidance.nameTooLong", { max: GUIDANCE_NAME_MAX });
	return t("guidance.nameRepeated");
}

/** A change the server refused, in the page's language where it says why (a template deleted or renamed meanwhile). */
export function refusalText(e: unknown, t: Translate): string {
	if (e instanceof GuidanceApiError) {
		if (e.problem === "gone") return t("guidance.templateGone");
		if (e.problem === "nameEmpty" || e.problem === "nameTooLong" || e.problem === "nameRepeated")
			return nameProblemText(e.problem, t);
	}
	return e instanceof Error ? e.message : String(e);
}
