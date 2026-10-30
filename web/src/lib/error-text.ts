import { type ErrorParams, isErrorCode } from "@shared/error-info.ts";
import { BACKEND_NAMES, isBackend } from "@shared/offline.ts";
import type { OmpJob } from "@shared/omp-install.ts";
import { type MessageKey, t, type Vars } from "../i18n/index.ts";

/** What the list settings are called to a person (`field` of `settingsListInvalid`). */
const FIELD_LABELS: Record<string, MessageKey> = {
	mcp: "mode.mcpLabel",
	skills: "mode.skillsLabel",
	tools: "mode.toolsLabel",
};

/**
 * An error the server explains with a code and parameters, in the page's language; `fallback` (the server's English
 * sentence) when the code is none this page knows. `backend` gives `{name}`, the local server's name.
 */
export function codedText(code: string | undefined, params: ErrorParams | undefined, fallback: string): string {
	if (!isErrorCode(code)) return fallback;
	const vars: Vars = { ...params };
	const backend = params?.backend;
	if (typeof backend === "string") vars.name = isBackend(backend) ? BACKEND_NAMES[backend] : backend;
	const field = params?.field;
	if (typeof field === "string" && field in FIELD_LABELS) vars.field = t(FIELD_LABELS[field] as MessageKey);
	return t(`errors.${code}`, vars);
}

/** What to show for a failed request, socket command or save: the coded sentence, else the error's own message. */
export function errorText(e: unknown): string {
	if (!(e instanceof Error)) return String(e);
	const { code, params } = e as Error & { code?: string; params?: ErrorParams };
	return codedText(code, params, e.message);
}

/** Why an install or update job failed. */
export function jobErrorText(job: Pick<OmpJob, "error" | "errorInfo">): string {
	return job.errorInfo ? codedText(job.errorInfo.code, job.errorInfo.params, job.error ?? "") : (job.error ?? "");
}
