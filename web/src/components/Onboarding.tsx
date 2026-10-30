import { APPROVAL_MODES, type ApprovalMode } from "@shared/approval.ts";
import { parseSelector } from "@shared/model-config.ts";
import { CircleCheck, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { sessionActions } from "../lib/api.ts";
import { modelConfig, useModelConfig } from "../lib/model-config.ts";
import { modelLabel } from "../lib/models.ts";
import { useApp } from "../store/app.ts";
import type { ModelInfo } from "../store/live.ts";
import { ompApi } from "../store/omp.ts";
import { Accounts } from "./Accounts.tsx";
import { APPROVAL_META } from "./ApprovalPicker.tsx";
import { ModelSelect } from "./ModelSelect.tsx";
import { Button, cx, Spinner } from "./ui.tsx";

const STEPS = ["account", "model", "approval", "done"] as const;
type Step = (typeof STEPS)[number];

const STEP_NAMES = {
	account: "omp.setupStepAccount",
	model: "omp.setupStepModel",
	approval: "omp.setupStepApproval",
	done: "omp.setupStepDone",
} as const;

/**
 * The first-time setup after omp was installed from here: sign in to a provider (the Accounts of Settings), choose
 * the default model (omp's `modelRoles`, written through `/api/model-config`), choose the permission mode new
 * conversations start in, and finish in a new chat. Every step can be skipped, and so can all of it; the
 * server keeps the setup pending until it is finished or skipped, so closing the window half way resumes it.
 */
export function Onboarding() {
	const t = useT();
	const toast = useApp((s) => s.toast);
	const setView = useApp((s) => s.setView);
	const [step, setStep] = useState<Step>("account");
	const [signedIn, setSignedIn] = useState<number | null>(null);
	const [models, setModels] = useState<ModelInfo[] | null>(null);
	const [modelsFailed, setModelsFailed] = useState<string | null>(null);
	const [model, setModel] = useState("");
	const [modelSaved, setModelSaved] = useState<string | null>(null);
	const [approval, setApproval] = useState<ApprovalMode>("write");
	const [approvalSaved, setApprovalSaved] = useState<ApprovalMode | null>(null);
	const [busy, setBusy] = useState(false);
	const { config } = useModelConfig("");
	const index = STEPS.indexOf(step);
	const heading = useRef<HTMLHeadingElement>(null);
	const shown = useRef(step);

	// A step the user opens with Continue or Back is where focus goes — to its heading, which a screen reader reads — as the
	// button that was pressed is gone with the step before it. Not at first load, when nothing was pressed.
	useEffect(() => {
		if (shown.current === step) return;
		shown.current = step;
		heading.current?.focus();
	}, [step]);

	// The models are asked for each time the step opens: a provider may have been signed in to a moment ago.
	useEffect(() => {
		if (step !== "model") return;
		let alive = true;
		setModels(null);
		setModelsFailed(null);
		ompApi
			.models()
			.then((list) => alive && setModels(list))
			.catch((e: Error) => alive && setModelsFailed(e.message));
		return () => {
			alive = false;
		};
	}, [step]);

	// Start from what omp already uses, when it is a model it lists.
	useEffect(() => {
		if (model || !models || !config) return;
		const current = parseSelector(config.roles.default ?? "");
		if (current && models.some((m) => m.provider === current.provider && m.id === current.id)) {
			setModel(`${current.provider}/${current.id}`);
		}
	}, [model, models, config]);

	useEffect(() => {
		void sessionActions
			.approvalDefault()
			.then((d) => d.mode && setApproval(d.mode))
			.catch(() => {});
	}, []);

	const finish = async (andStart: boolean) => {
		setBusy(true);
		try {
			await ompApi.setOnboarding(false);
			if (andStart) setView({ kind: "new" });
		} catch (e) {
			toast("error", t("omp.setupFinishFailed", { error: (e as Error).message }));
		} finally {
			setBusy(false);
		}
	};

	const saveModel = async () => {
		if (!model) return setStep("approval");
		setBusy(true);
		try {
			// The roles as they are now, read here: the copy this page holds may not have arrived yet, or may be old, and
			// writing `default` over nothing would drop every other role omp has (smol, slow, plan…).
			const current = await modelConfig.read();
			await modelConfig.setRoles({ ...current.roles, default: model });
			setModelSaved(model);
			setStep("approval");
		} catch (e) {
			toast("error", t("omp.setupModelFailed", { error: (e as Error).message }));
		} finally {
			setBusy(false);
		}
	};

	const saveApproval = async () => {
		setBusy(true);
		try {
			await sessionActions.setApprovalDefault(approval);
			setApprovalSaved(approval);
			setStep("done");
		} catch (e) {
			toast("error", t("omp.setupApprovalFailed", { error: (e as Error).message }));
		} finally {
			setBusy(false);
		}
	};

	const modelName = (selector: string) => {
		const found = models?.find((m) => `${m.provider}/${m.id}` === selector);
		return found ? modelLabel(found) : selector;
	};

	const back = index > 0 && step !== "done" ? STEPS[index - 1] : null;
	return (
		<main className="flex h-full overflow-y-auto p-6" data-testid="onboarding" data-step={step}>
			<div className="m-auto w-full max-w-xl rounded-2xl border border-border bg-surface p-6 shadow-xl">
				<div className="mb-4 flex items-center justify-between gap-3">
					<h1 className="flex items-center gap-2 text-lg font-semibold">
						<Sparkles size={19} className="text-accent" /> {t("omp.setupTitle")}
					</h1>
					{/* The last step is the finish: "Skip setup" there would offer to skip what is done (Start chatting ends it). */}
					{step === "done" ? null : (
						<Button
							size="sm"
							variant="ghost"
							data-testid="setup-skip"
							disabled={busy}
							onClick={() => void finish(true)}
						>
							{t("omp.setupSkip")}
						</Button>
					)}
				</div>
				<ol className="mb-1 flex gap-1.5" aria-label={t("omp.setupStep", { n: index + 1, total: STEPS.length })}>
					{STEPS.map((s, i) => (
						<li
							key={s}
							aria-current={s === step ? "step" : undefined}
							className={cx("h-1 flex-1 rounded-full", i <= index ? "bg-accent" : "bg-border")}
						/>
					))}
				</ol>
				{/* Announced when the step changes; focus goes to the new step's heading (below). */}
				<p className="mb-4 text-xs text-muted" data-testid="setup-step" role="status">
					{t("omp.setupStep", { n: index + 1, total: STEPS.length })} · {t(STEP_NAMES[step])}
				</p>

				{step === "account" ? (
					<div data-testid="setup-account">
						<h2 ref={heading} tabIndex={-1} className="mb-1 text-base font-semibold focus:outline-none">
							{t("omp.setupAccountTitle")}
						</h2>
						<p className="mb-3 text-sm text-muted">{t("omp.setupAccountIntro")}</p>
						<Accounts onSignedIn={setSignedIn} openAtStart />
						{signedIn ? (
							<p className="mt-3 flex items-center gap-1.5 text-sm text-success" data-testid="setup-signed-in">
								<CircleCheck size={15} /> {t("omp.setupAccountSignedIn")}
							</p>
						) : null}
					</div>
				) : null}

				{step === "model" ? (
					<div data-testid="setup-model">
						<h2 ref={heading} tabIndex={-1} className="mb-1 text-base font-semibold focus:outline-none">
							{t("omp.setupModelTitle")}
						</h2>
						<p className="mb-3 text-sm text-muted">{t("omp.setupModelIntro")}</p>
						{modelsFailed ? (
							<p className="text-sm text-danger">{t("omp.setupModelListFailed", { error: modelsFailed })}</p>
						) : !models ? (
							<p className="flex items-center gap-2 text-sm text-muted">
								<Spinner size={14} /> {t("omp.setupModelLoading")}
							</p>
						) : models.length === 0 ? (
							<p className="text-sm text-warning" data-testid="setup-no-models">
								{t("omp.setupModelNone")}
							</p>
						) : (
							<ModelSelect
								value={model}
								models={models}
								onChange={setModel}
								label={t("omp.setupModelLabel")}
								testid="setup-model-select"
							/>
						)}
					</div>
				) : null}

				{step === "approval" ? (
					<div data-testid="setup-approval">
						<h2 ref={heading} tabIndex={-1} className="mb-1 text-base font-semibold focus:outline-none">
							{t("omp.setupApprovalTitle")}
						</h2>
						<p className="mb-3 text-sm text-muted">{t("omp.setupApprovalIntro")}</p>
						<fieldset className="space-y-1">
							<legend className="sr-only">{t("omp.setupApprovalTitle")}</legend>
							{APPROVAL_MODES.map((mode) => {
								const on = approval === mode;
								return (
									<label
										key={mode}
										className={cx(
											"flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
											on ? "border-accent bg-accent-soft" : "border-border hover:bg-hover",
											mode === "yolo" && on && "border-warning bg-warning/10",
										)}
									>
										<input
											type="radio"
											name="setup-approval"
											className="mt-1 accent-[var(--accent)]"
											data-testid={`setup-approval-${mode}`}
											checked={on}
											onChange={() => setApproval(mode)}
										/>
										<span>
											{t(APPROVAL_META[mode].label)}
											<span className="block text-xs text-muted">{t(APPROVAL_META[mode].hint)}</span>
										</span>
									</label>
								);
							})}
						</fieldset>
					</div>
				) : null}

				{step === "done" ? (
					<div data-testid="setup-done">
						<h2
							ref={heading}
							tabIndex={-1}
							className="mb-1 flex items-center gap-2 text-base font-semibold focus:outline-none"
						>
							<CircleCheck size={18} className="text-success" /> {t("omp.setupDoneTitle")}
						</h2>
						<p className="mb-3 text-sm text-muted">{t("omp.setupDoneIntro")}</p>
						<ul className="space-y-1 text-sm">
							{modelSaved ? <li>{t("omp.setupSummaryModel", { model: modelName(modelSaved) })}</li> : null}
							{approvalSaved ? (
								<li>{t("omp.setupSummaryApproval", { mode: t(APPROVAL_META[approvalSaved].label) })}</li>
							) : null}
							{!modelSaved && !approvalSaved ? <li className="text-muted">{t("omp.setupSummaryNone")}</li> : null}
						</ul>
					</div>
				) : null}

				<div className="mt-5 flex items-center justify-between gap-2">
					<div>
						{back ? (
							<Button variant="ghost" data-testid="setup-back" disabled={busy} onClick={() => setStep(back)}>
								{t("omp.setupBack")}
							</Button>
						) : null}
					</div>
					<div className="flex items-center gap-2">
						{step === "account" ? (
							<Button
								variant={signedIn ? "primary" : "ghost"}
								data-testid="setup-next"
								onClick={() => setStep("model")}
							>
								{signedIn ? t("omp.setupContinue") : t("omp.setupSkipStep")}
							</Button>
						) : null}
						{step === "model" ? (
							<>
								{model ? null : (
									<Button variant="ghost" data-testid="setup-skip-step" onClick={() => setStep("approval")}>
										{t("omp.setupSkipStep")}
									</Button>
								)}
								<Button
									variant="primary"
									data-testid="setup-next"
									disabled={busy || !model}
									onClick={() => void saveModel()}
								>
									{busy ? <Spinner size={14} /> : null} {t("omp.setupContinue")}
								</Button>
							</>
						) : null}
						{step === "approval" ? (
							<Button variant="primary" data-testid="setup-next" disabled={busy} onClick={() => void saveApproval()}>
								{busy ? <Spinner size={14} /> : null} {t("omp.setupContinue")}
							</Button>
						) : null}
						{step === "done" ? (
							<Button variant="primary" data-testid="setup-finish" disabled={busy} onClick={() => void finish(true)}>
								{busy ? <Spinner size={14} /> : null} {t("omp.setupStart")}
							</Button>
						) : null}
					</div>
				</div>
			</div>
		</main>
	);
}
