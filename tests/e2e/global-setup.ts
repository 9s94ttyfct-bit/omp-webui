import { canCallModel, exportModelLogin } from "../support/omp-env.ts";

/**
 * The credential is looked up once for the run, here, and handed to every worker through the environment (workers are
 * started after this): a worker never asks omp itself, so one that would have failed the lookup cannot boot on the
 * placeholder key while the flag below says live-model specs run. A lookup that fails stops the run at startup.
 * Each worker fixture still owns its server and authenticated browser state.
 */
export default function globalSetup() {
	exportModelLogin();
	// This flag is needed while Playwright collects `test.skip` declarations, before worker fixtures run.
	process.env.OMPW_E2E_HAS_TOKEN = canCallModel() ? "1" : "";
}
