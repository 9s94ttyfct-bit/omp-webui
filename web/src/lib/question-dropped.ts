import type { QuestionDropNote } from "@shared/unattended.ts";
import { t } from "../i18n/index.ts";
import { useApp } from "../store/app.ts";
import "../i18n/later.ts";
import { DROPPED_WHY } from "../components/NoticeRows.tsx";

/**
 * A conversation the user is not looking at could not keep the question it filed (#650): the toast says so and offers to open
 * it, where the transcript's row names the question and why it was not kept. It is a module of its own, loaded at the first
 * such failure: its words are the later strings (`chat.toastQuestionDropped`), which cost the first page 20 KiB and have no
 * business there for something a conversation only reaches when unattended mode's list is full.
 */
export function toastQuestionDropped(note: QuestionDropNote): void {
	const why = t(DROPPED_WHY[note.why]);
	useApp.getState().toast("warning", why ? `${t("chat.toastQuestionDropped")} ${why}` : t("chat.toastQuestionDropped"));
}
