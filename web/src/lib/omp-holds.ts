import type { Holds } from "@shared/omp-install.ts";
import type { MessageKey, Vars } from "../i18n/index.ts";

/** What an update waits for, in words, by what each conversation is doing: `2 working, 1 paused`; only the kinds there are. */
export function describeHolds(held: Holds, t: (key: MessageKey, vars?: Vars) => string): string {
	return [
		held.working > 0 ? t("omp.holdWorking", { n: held.working }) : "",
		held.asking > 0 ? t("omp.holdAsking", { n: held.asking }) : "",
		held.paused > 0 ? t("omp.holdPaused", { n: held.paused }) : "",
	]
		.filter(Boolean)
		.join(t("omp.holdSeparator"));
}

/** Conversations that stay until the user acts: a paused one, one waiting for an answer. Working ones end by themselves. */
export const needsYou = (held: Holds): number => held.paused + held.asking;
