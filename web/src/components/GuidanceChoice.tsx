import { GUIDANCE_MAX, type GuidanceTemplate, type LiveGuidance } from "@shared/model-guidance.ts";
import { useEffect, useState } from "react";
import { useT } from "../i18n/index.ts";
import { templateName } from "../lib/guidance-names.ts";
import { useGuidanceStrings } from "../lib/guidance-strings.ts";
import { Button } from "./ui.tsx";

/**
 * Choose what a new conversation's main agent is told of how to use models for subagents (#641), or nothing: a saved
 * template, or text written here. New chat's picker opens it on "Write your own…"; a conversation that exists has its
 * own editor in its Guidance tab (`GuidanceEditor`, #715).
 */
export function GuidanceChoice({
	value,
	templates,
	onPick,
	onText,
	disabled,
	startWriting = false,
}: {
	/** What the conversation carries now (null: nothing); a template id that is gone shows as text. */
	value: LiveGuidance | null;
	templates: GuidanceTemplate[];
	/** A template was picked: its id, and the text it stands for now. */
	onPick: (template: GuidanceTemplate) => void;
	/** Text was written (or the guidance turned off: ""). */
	onText: (text: string) => void;
	disabled?: boolean;
	/** Open on the text box (New chat's "Write your own…"), starting from what the conversation carries. */
	startWriting?: boolean;
}) {
	const t = useT();
	const ready = useGuidanceStrings();
	const [custom, setCustom] = useState(startWriting);
	const [text, setText] = useState(value?.text ?? "");
	// What the conversation carries is the truth until the person types: a template renamed or edited elsewhere shows its
	// new name, and text written here starts from what is there.
	useEffect(() => {
		if (!custom) setText(value?.text ?? "");
	}, [value?.text, custom]);
	if (!ready) return null;
	const chosen = value?.template ?? "";
	const shown = custom || (value && !value.template && value.text) ? "custom" : chosen;
	return (
		<div className="space-y-3" data-testid="guidance-choice">
			<label className="block text-sm">
				<span className="mb-1 block text-muted">{t("guidance.templateLabel")}</span>
				<select
					className="w-full rounded-lg border border-border bg-bg px-2 py-1.5 text-sm"
					data-testid="guidance-template"
					value={shown}
					disabled={disabled}
					onChange={(e) => {
						const id = e.target.value;
						if (id === "custom") {
							setCustom(true);
							return;
						}
						setCustom(false);
						if (!id) onText("");
						else {
							const found = templates.find((x) => x.id === id);
							if (found) onPick(found);
						}
					}}
				>
					<option value="">{t("guidance.pickNone")}</option>
					{templates.map((x) => (
						<option key={x.id} value={x.id}>
							{templateName(x, t)}
						</option>
					))}
					<option value="custom">{t("guidance.pickCustom")}</option>
				</select>
			</label>
			{custom ? (
				<>
					<label className="block text-sm">
						<span className="mb-1 block text-muted">{t("guidance.textLabel")}</span>
						<textarea
							className="h-40 w-full resize-y rounded-lg border border-border bg-bg px-2 py-1.5 font-mono text-xs"
							data-testid="guidance-text"
							value={text}
							disabled={disabled}
							onChange={(e) => setText(e.target.value)}
						/>
					</label>
					<div className="flex items-center justify-between gap-3 text-xs text-muted">
						<span data-testid="guidance-chars">
							{text.length > GUIDANCE_MAX
								? t("guidance.tooLong", { max: GUIDANCE_MAX })
								: t("guidance.chars", { n: text.length, max: GUIDANCE_MAX })}
						</span>
						<Button
							data-testid="guidance-save"
							disabled={disabled || text.length > GUIDANCE_MAX}
							onClick={() => onText(text)}
						>
							{t("guidance.save")}
						</Button>
					</div>
				</>
			) : null}
			{value?.text ? (
				<>
					<pre className="max-h-40 overflow-auto rounded-lg border border-border bg-bg-soft p-2 font-mono text-xs whitespace-pre-wrap">
						{value.text}
					</pre>
					{value.skipped ? (
						<p className="text-xs text-warning" data-testid="guidance-skipped">
							{value.skipped === "trustedExtension"
								? t("guidance.skippedTrusted")
								: value.skipped === "inherited"
									? t("guidance.skippedInherited")
									: t("guidance.skippedUnavailable")}
						</p>
					) : !value.live ? (
						<p className="text-xs text-warning" data-testid="guidance-readonly">
							{t("guidance.readOnly")}
						</p>
					) : null}
				</>
			) : (
				<p className="text-xs text-faint">{t("guidance.empty")}</p>
			)}
		</div>
	);
}
