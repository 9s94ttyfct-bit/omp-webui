/** omp's setting of the permission mode, by its key. */
export const APPROVAL_MODE_KEY = "tools.approvalMode";

/**
 * What follows the overlay's name in the file the gate (`server/omp/gate/extension.ts`) keeps of the permission mode in
 * force in its process, written when the gate starts and again each time omp's value changes. The server answers a
 * conversation's switch once this file says it (`ProcessOverlay.set`), instead of guessing how long omp takes to reload
 * the overlay: a turn sent before would run in the mode the person just left. This module imports nothing: the gate is
 * installed with it (`server/omp/gate/install.ts`).
 */
export const APPROVAL_APPLIED_SUFFIX = ".approvalmode";
