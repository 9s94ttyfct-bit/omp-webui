import { PREF } from "@shared/prefs.ts";
import { INSTRUCTION_MAX, type UnattendedSettings as Settings } from "@shared/unattended.ts";
import { MoonStar, RotateCcw } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useT } from "../i18n/index.ts";
import { setPref } from "../lib/prefs.ts";
import { questionsApi } from "../lib/questions-api.ts";
import { useQuestionsStrings } from "../lib/questions-strings.ts";
import { useApp } from "../store/app.ts";
import { Button, CardHeader, Spinner } from "./ui.tsx";

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Settings › Unattended mode (#646): whether a conversation started from New chat is unattended from the start (each
 * conversation has its own switch beside the message box), and what the main agent is told while the mode is on. The text is
 * kept in the app's data folder (`unattended.json`) and reaches a running conversation at its next turn. Changing it is for the
 * page on this computer (see `isLocalOnlyRoute`): what it says is put into the instructions of every conversation that is
 * unattended. A chunk of its own, with its strings.
 */
export function UnattendedSettings() {
	const t = useT();
	const ready = useQuestionsStrings();
	const local = useApp((s) => s.meta?.local !== false);
	const [stored, setStored] = useState<Settings | null>(null);
	const [text, setText] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [byDefault, setByDefault] = useState(() => localStorage.getItem(PREF.unattended) === "on");
	const field = useId();
	useEffect(() => {
		let live = true;
		questionsApi.settings().then(
			(s) => {
				if (!live) return;
				setStored(s);
				setText(s.instruction);
			},
			(e: unknown) => live && setError(messageOf(e)),
		);
		return () => {
			live = false;
		};
	}, []);
	if (!ready) return null;
	const dirty = stored !== null && text.trim() !== stored.instruction.trim();
	const write = (next: string | null, done: string) => {
		setBusy(true);
		setError(null);
		setNotice(null);
		questionsApi.saveInstruction(next).then(
			(s) => {
				setBusy(false);
				setStored(s);
				setText(s.instruction);
				setNotice(done);
			},
			(e: unknown) => {
				setBusy(false);
				setError(t("questions.settingsFailed", { error: messageOf(e) }));
			},
		);
	};
	return (
		<section className="rounded-2xl border border-border bg-surface p-4" data-testid="unattended-settings">
			<CardHeader
				title={t("questions.settingsTitle")}
				icon={<MoonStar size={16} className="text-accent" />}
				hint={t("questions.settingsIntro")}
			/>
			<label className="flex cursor-pointer items-start gap-3 text-sm">
				<input
					type="checkbox"
					className="mt-1 accent-[var(--accent)]"
					data-testid="unattended-default"
					checked={byDefault}
					onChange={(e) => {
						setPref(PREF.unattended, e.target.checked ? "on" : "off");
						setByDefault(e.target.checked);
					}}
				/>
				<span>
					{t("questions.defaultLabel")}
					<span className="block text-xs text-muted">{t("questions.defaultHint")}</span>
				</span>
			</label>
			<div className="mt-4">
				<div className="flex items-center gap-2">
					<label htmlFor={field} className="text-sm font-medium">
						{t("questions.instructionLabel")}
					</label>
					{stored ? (
						<span className="text-xs text-muted" data-testid="unattended-instruction-state">
							{stored.custom ? t("questions.instructionEdited") : t("questions.instructionShipped")}
						</span>
					) : null}
				</div>
				<p className="mt-0.5 text-xs text-muted">{t("questions.instructionHint")}</p>
				{!stored && !error ? (
					<div className="flex justify-center py-6">
						<Spinner />
					</div>
				) : (
					<textarea
						id={field}
						rows={9}
						value={text}
						readOnly={!local}
						maxLength={INSTRUCTION_MAX}
						data-testid="unattended-instruction"
						className="mt-2 w-full resize-y rounded-xl border border-border bg-bg-soft px-3 py-2 font-mono text-xs outline-none focus:border-faint"
						onChange={(e) => {
							setText(e.target.value);
							setNotice(null);
						}}
					/>
				)}
				<div className="mt-2 flex flex-wrap items-center gap-2">
					<span className="text-xs text-muted tabular-nums">
						{t("questions.instructionCount", { n: text.length, max: INSTRUCTION_MAX })}
					</span>
					{!local ? <span className="text-xs text-muted">{t("questions.remoteNote")}</span> : null}
					<span className="flex-1" />
					{local ? (
						<>
							<Button
								size="sm"
								variant="ghost"
								data-testid="unattended-restore"
								disabled={busy || stored === null || !stored.custom}
								onClick={() => write(null, t("questions.restored"))}
							>
								<RotateCcw size={12} /> {t("questions.restore")}
							</Button>
							<Button
								size="sm"
								variant="primary"
								data-testid="unattended-save"
								disabled={busy || !dirty || text.trim() === ""}
								onClick={() => write(text, t("questions.saved"))}
							>
								{busy ? <Spinner size={12} /> : null}
								{t("questions.save")}
							</Button>
						</>
					) : null}
				</div>
				<div role="status" className="min-h-4 text-xs">
					{notice ? <span className="text-success">{notice}</span> : null}
					{error ? (
						<span className="text-danger" role="alert" data-testid="unattended-error">
							{error}
						</span>
					) : null}
				</div>
			</div>
		</section>
	);
}
