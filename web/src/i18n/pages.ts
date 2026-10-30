/**
 * Strings for the pages surfaces: new chat, settings, usage, commands/terminal, accounts.
 *
 * Only the strings a module of the first page load asks for: `tests/unit/i18n-first-load.test.ts` holds this
 * file to that. The rest are in `pages-later.ts`.
 */
export const en = {
	// NewChat
	greetingLate: "Working late",
	greetingMorning: "Good morning",
	greetingAfternoon: "Good afternoon",
	greetingEvening: "Good evening",
	newStarting: "omp is still starting…",
	newChooseFolder: "Choose a folder",
	newOptions: "Options",
	newOptionsCount: "Options ({n})",
	newPlaceholder: "How can omp help you today?",
	newGoalTitle: "Guided goal: omp interviews you first, then keeps working until the goal is done",
	newGoal: "Goal",
	newGoalDirect: "Skip interview",
	newGoalDirectTitle: "Skip the interview: your message becomes the goal and omp starts working on it right away",
	newGoalPlaceholder: "What do you want to get done? A rough idea is enough: omp will interview you.",
	newGoalDirectPlaceholder: "Describe the goal. omp starts working on it right away.",
	newGoalNoImages:
		"A goal that starts at once cannot carry images, so nothing was sent. Remove them, or turn off “Skip interview” to start a guided goal with them.",
	newStartingOmp: "Starting omp…",
	newPickLost: "Your choice of {what} could not be kept for the restarted omp: {error}",
	newSessionOptions: "Session options",
	newOptionsFrom: "from",
	newOptionsApplied: "; applied when the session starts",
	newFilterAria: "Filter options",
	newFilter: "Filter…",
	newPickFolder: "Choose a folder to start omp",
};
