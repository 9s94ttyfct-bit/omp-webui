import { GUIDANCE_MAX, type GuidanceTemplate, type LiveGuidance } from "@shared/model-guidance.ts";
import { Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { useT } from "../i18n/index.ts";
import { GuidanceApiError, guidanceApi } from "../lib/guidance-api.ts";
import { templateName } from "../lib/guidance-names.ts";
import { useGuidanceStrings } from "../lib/guidance-strings.ts";
import { useApp } from "../store/app.ts";
import { Button, Select, Spinner } from "./ui.tsx";

/**
 * A conversation's *Guidance* tab (#715): what it carries of the model guidance (#641), edited where it is shown. The menu
 * picks a template, none, or text of the conversation's own; the box holds the text it carries now and is edited in place.
 * Saving text that came from a template asks whether the edit is this conversation's alone or the template's too (which
 * every conversation using it then carries at its next turn).
 *
 * A running conversation is changed in its process, which reads its file at each turn. One with no process (`file` only)
 * has the change kept for when it is opened next. A page that is not on the computer omp-webui runs on reads only.
 */
export function GuidanceEditor({ liveId, file }: { liveId: string | null; file: string | null }) {
	const t = useT();
	const ready = useGuidanceStrings();
	const local = useApp((s) => s.meta?.local !== false);
	// The running conversation's guidance as the live frames keep it; a closed one's is what the server kept.
	const liveGuidance = useApp((s) => (liveId ? s.lives[liveId]?.info.guidance : undefined));
	const [kept, setKept] = useState<LiveGuidance | null>(null);
	const [templates, setTemplates] = useState<GuidanceTemplate[] | null>(null);
	const [text, setText] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	// Saving a template's text that was edited: which of the two the person means.
	const [asking, setAsking] = useState(false);
	// "Custom" picked while the conversation carries nothing yet: the box is for text of its own, saved with Save.
	const [customMode, setCustomMode] = useState(false);
	const key = liveId ?? file;
	useEffect(() => {
		if (!key) return;
		let live = true;
		setError(null);
		setTemplates(null);
		const read = liveId ? guidanceApi.ofLive(liveId) : guidanceApi.ofFile(file as string);
		read.then(
			(answer) => {
				if (!live) return;
				setKept(answer.guidance);
				setTemplates(answer.templates.templates);
			},
			(e: unknown) => {
				if (live) setError((e as Error).message);
			},
		);
		return () => {
			live = false;
		};
	}, [key, liveId, file]);
	const value: LiveGuidance | null = liveId ? (liveGuidance ?? null) : kept;
	const carried = value?.text ?? "";
	// The box follows what the conversation carries until the person types something else.
	const [touched, setTouched] = useState(false);
	useEffect(() => {
		if (!touched) setText(carried);
	}, [carried, touched]);
	if (!ready || !key) return null;
	const template = value?.template ? (templates?.find((x) => x.id === value.template) ?? null) : null;
	const changed = text.trim() !== carried.trim();
	const tooLong = text.length > GUIDANCE_MAX;
	const readOnly = !local || busy;

	const apply = async (next: { template?: string; text?: string } | null) => {
		setBusy(true);
		setError(null);
		try {
			const now = liveId
				? ((await guidanceApi.change(liveId, next)) ?? null)
				: await guidanceApi.changeFile(file as string, next);
			setKept(now);
			setTouched(false);
			setText(now?.text ?? "");
			setAsking(false);
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	};
	const saveTemplateToo = async () => {
		if (!template) return;
		setBusy(true);
		setError(null);
		try {
			const set = await guidanceApi.update({ ...template, text });
			setTemplates(set.templates);
		} catch (e) {
			// The one refusal only the server can find: the template was deleted meanwhile (#715).
			setError(
				e instanceof GuidanceApiError && e.problem === "gone" ? t("guidance.templateGone") : (e as Error).message,
			);
			setBusy(false);
			return;
		}
		setBusy(false);
		await apply({ template: template.id, text });
	};
	const save = () => {
		if (!text.trim()) return void apply(null);
		// Text that came from a template: the person says whether the template changes too.
		if (template) return setAsking(true);
		void apply({ text });
	};
	const shown = value?.template && template ? value.template : value || customMode ? "custom" : "";

	return (
		<div className="space-y-3" data-testid="guidance-editor">
			<p className="flex items-start gap-1.5 text-xs text-muted">
				<Sparkles size={13} className="mt-0.5 shrink-0 text-accent" aria-hidden />
				{t("guidance.changeIntro")}
			</p>
			{!local ? (
				<p className="text-xs text-muted" data-testid="guidance-readonly-remote">
					{t("guidance.readOnlyRemote")}
				</p>
			) : null}
			{error ? (
				<p className="text-xs text-danger" data-testid="guidance-error">
					{t("guidance.saveFailed", { error })}
				</p>
			) : null}
			{!templates ? (
				error ? null : (
					<div className="flex items-center gap-2 py-4 text-xs text-muted">
						<Spinner size={12} />
					</div>
				)
			) : (
				<>
					<label className="block text-sm">
						<span className="mb-1 block text-muted">{t("guidance.templateLabel")}</span>
						<Select
							data-testid="guidance-template"
							value={shown}
							disabled={readOnly}
							onChange={(e) => {
								const id = e.target.value;
								setAsking(false);
								if (id === "custom") {
									// A template's text becomes the conversation's own, so that editing it needs no question;
									// with nothing carried yet, the box waits for text and Save.
									if (carried.trim()) void apply({ text: carried });
									else setCustomMode(true);
									return;
								}
								setCustomMode(false);
								if (!id) return void apply(null);
								const found = templates.find((x) => x.id === id);
								if (found) void apply({ template: found.id, text: found.text });
							}}
						>
							<option value="">{t("guidance.pickNone")}</option>
							{templates.map((x) => (
								<option key={x.id} value={x.id}>
									{templateName(x, t)}
								</option>
							))}
							<option value="custom">{t("guidance.custom")}</option>
						</Select>
					</label>
					<label className="block text-sm">
						<span className="mb-1 block text-muted">{t("guidance.textLabel")}</span>
						<textarea
							className="h-56 w-full resize-y rounded-xl border border-border bg-bg-soft p-3 font-mono text-xs outline-none focus:border-faint"
							data-testid="guidance-text"
							value={text}
							placeholder={t("guidance.empty")}
							readOnly={readOnly}
							onChange={(e) => {
								setTouched(true);
								setText(e.target.value);
								setAsking(false);
							}}
						/>
					</label>
					<div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
						<span data-testid="guidance-chars">
							{tooLong
								? t("guidance.tooLong", { max: GUIDANCE_MAX })
								: t("guidance.chars", { n: text.length, max: GUIDANCE_MAX })}
						</span>
						{changed && !readOnly ? (
							<span className="flex gap-2">
								<Button
									size="sm"
									data-testid="guidance-revert"
									onClick={() => {
										setTouched(false);
										setText(carried);
										setAsking(false);
									}}
								>
									{t("guidance.revert")}
								</Button>
								<Button size="sm" variant="primary" data-testid="guidance-save" disabled={tooLong} onClick={save}>
									{t("guidance.save")}
								</Button>
							</span>
						) : busy ? (
							<Spinner size={12} />
						) : null}
					</div>
					{asking && template ? (
						<div
							className="space-y-2 rounded-lg border border-border bg-bg-soft p-2.5 text-xs"
							data-testid="guidance-save-choice"
						>
							<p>{t("guidance.saveWhere", { name: templateName(template, t) })}</p>
							<div className="flex flex-wrap gap-2">
								<Button size="sm" data-testid="guidance-save-this" onClick={() => void apply({ text })}>
									{t("guidance.saveThis")}
								</Button>
								<Button
									size="sm"
									variant="primary"
									data-testid="guidance-save-template"
									onClick={() => void saveTemplateToo()}
								>
									{t("guidance.saveTemplate", { name: templateName(template, t) })}
								</Button>
							</div>
						</div>
					) : null}
					{value?.skipped ? (
						<p className="text-xs text-warning" data-testid="guidance-skipped">
							{value.skipped === "trustedExtension"
								? t("guidance.skippedTrusted")
								: value.skipped === "inherited"
									? t("guidance.skippedInherited")
									: t("guidance.skippedUnavailable")}
						</p>
					) : liveId && value && !value.live ? (
						<p className="text-xs text-warning" data-testid="guidance-readonly">
							{t("guidance.readOnly")}
						</p>
					) : !liveId ? (
						<p className="text-xs text-faint" data-testid="guidance-applies-next">
							{t("guidance.appliesNext")}
						</p>
					) : null}
				</>
			)}
		</div>
	);
}
