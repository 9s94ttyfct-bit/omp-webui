import { expect, test } from "bun:test";
import { CHAT_ROLES } from "../../server/offline/agent.ts";
import { ROLE_ORDER } from "../../web/src/lib/model-roles.ts";

/**
 * The app keeps omp's model roles in two places: the roles editor (a name for each, the *Add role* suggestions) and Light
 * mode's mapping of every chat role to the local server's model. A role omp added (18.22's `widget`) was in neither for a
 * release (#330); a test that compared a list with itself could not notice, so these two are compared with each other.
 */

/** The roles that take models of other kinds than chat models: Light does not map them to the local server's model. */
const NOT_CHAT = ["image", "web", "speech", "dictation", "judge"];

test("every role the roles editor names is a chat role Light maps to the local model, or one of the other kinds", () => {
	expect(ROLE_ORDER.filter((role) => !NOT_CHAT.includes(role)).sort()).toEqual([...CHAT_ROLES].sort());
	for (const role of NOT_CHAT) expect(ROLE_ORDER).toContain(role);
});
