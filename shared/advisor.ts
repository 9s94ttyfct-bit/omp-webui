/**
 * The advisor: the second model omp can run beside a conversation's agent, which reviews each turn and writes notes into
 * it (omp's setting `advisor.enabled`, with the model of the `advisor` role). The web UI turns it on or off per
 * conversation, and New chat starts one with it on or off.
 *
 * The global value is omp's `config.yml`, as `omp config set` writes it (the session panel's "Set as default" star). A
 * conversation's own value is a line of its process's `--config` overlay (see `server/omp/approval.ts`), over the
 * configuration: omp reloads the overlay by itself, and a changed `advisor.enabled` starts or stops the advisor of that
 * process at once (omp's settings listener calls its `setAdvisorEnabled`), so the next turn is reviewed, or not, without a
 * restart; the server answers the change once the process says it is in force (`ADVISOR_APPLIED_SUFFIX`). Notes the
 * advisor already wrote stay in the conversation.
 */

/** omp's setting, by its key. */
export const ADVISOR_KEY = "advisor.enabled";

/**
 * What follows the overlay's name in the file the gate (`server/omp/gate/extension.ts`) keeps of the advisor's value in
 * force in its process: `true` or `false`, written when the gate starts and again each time omp's value changes (omp's
 * reload of the overlay is seen inside the process, not by the server). The server says a conversation's change is in
 * force once this file says it (`ProcessOverlay.setAdvisor`), instead of guessing how long omp takes to reload.
 */
export const ADVISOR_APPLIED_SUFFIX = ".advisor";

/** `v` as a choice of the advisor's (a record from disk, or a page's request), or null where it is none. */
export function advisorOf(v: unknown): boolean | null {
	return typeof v === "boolean" ? v : null;
}
