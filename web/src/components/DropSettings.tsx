import { ATTACH_LIMITS, canAttachKind, type DropAction, type DropChoices, type DropKind } from "@shared/attachment.ts";
import { useEffect, useState } from "react";
import { type MessageKey, useT } from "../i18n/index.ts";
import { sizeText } from "../lib/drop-flow.ts";
import { choicesKey, readChoices, setChoice } from "../lib/drop-prefs.ts";
import "../lib/drop-strings.ts";
import { onPrefsChanged } from "../lib/prefs.ts";
import { CardHeader, Select } from "./ui.tsx";

const KINDS: { kind: DropKind; label: MessageKey }[] = [
	{ kind: "text", label: "drop.settingsKindText" },
	{ kind: "image", label: "drop.settingsKindImage" },
	{ kind: "document", label: "drop.settingsKindDocument" },
	{ kind: "other", label: "drop.settingsKindOther" },
	{ kind: "folder", label: "drop.settingsKindFolder" },
];

/** What a select shows for a kind: the remembered action, or "ask" for none. */
const shown = (choices: DropChoices, kind: DropKind): DropAction | "ask" => choices[kind] ?? "ask";

/**
 * What happens to files dropped, pasted or picked in the message box (#617): ask each time (the default), or the action the
 * person asked to remember for that kind of file. The choice in the message box's popover writes the same preference
 * (`choicesKey`: one for the macOS app, one for a page in a browser); this is where it is changed or forgotten. A folder, or a file that is none
 * of text, picture, PDF or Word, has nothing a message can carry, so "Attach" is not offered for those.
 */
export function DropSettings() {
	const t = useT();
	const [choices, setChoices] = useState(readChoices);
	// Remembered in the message box, or chosen in another window.
	useEffect(() => onPrefsChanged((keys) => keys.includes(choicesKey()) && setChoices(readChoices())), []);
	return (
		<section className="rounded-2xl border border-border bg-surface p-4" data-testid="drop-settings">
			<CardHeader title={t("drop.settingsTitle")} hint={t("drop.settingsIntro")} />
			<div className="space-y-2">
				{KINDS.map(({ kind, label }) => (
					<label key={kind} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 text-sm">
						<span className="min-w-0 flex-1 basis-56">{t(label)}</span>
						<Select
							className="w-full sm:w-48"
							value={shown(choices, kind)}
							data-testid={`drop-choice-${kind}`}
							onChange={(e) => {
								const value = e.target.value;
								setChoice(kind, value === "attach" || value === "path" ? value : null);
								setChoices(readChoices());
							}}
						>
							<option value="ask">{t("drop.choiceAsk")}</option>
							{canAttachKind(kind) ? <option value="attach">{t("drop.choiceAttach")}</option> : null}
							<option value="path">{t("drop.choicePath")}</option>
						</Select>
					</label>
				))}
			</div>
			<p className="mt-3 text-xs text-muted">
				{t("drop.settingsNote", {
					file: sizeText(ATTACH_LIMITS.textFileBytes),
					total: sizeText(ATTACH_LIMITS.textTotalBytes),
				})}
			</p>
		</section>
	);
}
