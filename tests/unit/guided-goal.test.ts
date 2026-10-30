import { expect, test } from "bun:test";
import { parseSessionText, summarize } from "../../server/sessions/parse.ts";
import {
	goalObjective,
	hostResult,
	INTERVIEW_LANGUAGES,
	interviewLabel,
	interviewPrompt,
	PROPOSAL_RESULTS,
	PROPOSE_GOAL_TOOL,
	parseInterviewPrompt,
	proposeGoalTool,
	readProposal,
} from "../../shared/guided-goal.ts";
import { panelEn as en } from "../support/i18n-en.ts";

/** The guided goal's contract with the model: the tool it ends with, the message that starts it, what comes back. */

test("the tool is in the model's tool list from the next turn, and asks for an objective and criteria", () => {
	const tool = proposeGoalTool();
	expect(tool.name).toBe(PROPOSE_GOAL_TOOL);
	// A host tool defaults to `discoverable`, which the model would have to search for: found out by probing omp.
	expect(tool.loadMode).toBe("essential");
	const schema = tool.parameters as {
		required: string[];
		additionalProperties: boolean;
		properties: Record<string, { type: string; minimum?: number }>;
	};
	expect(schema.required).toEqual(["objective", "acceptance_criteria"]);
	expect(schema.additionalProperties).toBe(false);
	expect(schema.properties.acceptance_criteria.type).toBe("array");
	expect(schema.properties.token_budget).toMatchObject({ type: "integer", minimum: 10_000 });
	// The model may not start goal mode itself: the description says the user decides.
	expect(tool.description).toMatch(/confirm, edit or reject/);
});

test("a proposal is read from the call's arguments, trimmed and tolerant of what a model may send", () => {
	expect(
		readProposal({
			objective: "  Make the tests pass  ",
			acceptance_criteria: [" `bun test` exits 0 ", "", "  ", 7, null, "No test is skipped"],
			token_budget: 150_000.9,
			i: "Proposing the goal",
		}),
	).toEqual({
		objective: "Make the tests pass",
		criteria: ["`bun test` exits 0", "No test is skipped"],
		tokenBudget: 150_000,
	});
	expect(readProposal({ objective: "Ship", acceptance_criteria: [] })).toEqual({ objective: "Ship", criteria: [] });
	expect(readProposal({ objective: "Ship" })).toEqual({ objective: "Ship", criteria: [] });
});

test("a budget that is not a positive number is no budget", () => {
	for (const token_budget of [0, -5, Number.NaN, "50000", null, 0.4, Number.POSITIVE_INFINITY]) {
		expect(readProposal({ objective: "Ship", token_budget })).toEqual({ objective: "Ship", criteria: [] });
	}
});

test("without an objective there is no proposal", () => {
	for (const args of [undefined, null, "Ship it", 3, [], {}, { objective: "   " }, { objective: 5 }]) {
		expect(readProposal(args)).toBeNull();
	}
});

test("goal mode takes one string: the objective, then the criteria as a list", () => {
	expect(goalObjective({ objective: " Ship the release ", criteria: [" Tests pass ", "", "Notes written"] })).toBe(
		"Ship the release\n\nAcceptance criteria:\n- Tests pass\n- Notes written",
	);
	expect(goalObjective({ objective: "Ship the release", criteria: [] })).toBe("Ship the release");
	expect(goalObjective({ objective: "Ship the release", criteria: ["  "] })).toBe("Ship the release");
});

test("the interview starts from the user's words, or asks what they want, in their language", () => {
	const withIdea = interviewPrompt("  make the tests faster ", "English");
	expect(withIdea.split("\n")[0]).toBe("Help me define a goal. My rough idea: make the tests faster");
	expect(withIdea).toContain("one focused question at a time");
	expect(withIdea).toContain("`ask` tool");
	expect(withIdea).toContain(`\`${PROPOSE_GOAL_TOOL}\``);
	expect(withIdea).toContain("Do not start the work");
	expect(withIdea).toContain("use English");

	const without = interviewPrompt("   ", "Simplified Chinese");
	expect(without.split("\n")[0]).toContain("I do not have a precise idea yet");
	expect(without.split("\n")[0]).toContain("start by asking what I want to achieve");
	expect(without).not.toContain("My rough idea");
	expect(without).toContain("use Simplified Chinese");
});

test("what the model hears after the user decided", () => {
	expect(PROPOSAL_RESULTS.confirmed("Ship it")).toMatch(/confirmed the goal[\s\S]*Ship it[\s\S]*Begin working/);
	expect(PROPOSAL_RESULTS.cancelled).toMatch(/cancelled[\s\S]*No goal was created/);
	expect(PROPOSAL_RESULTS.revise("Add a time limit")).toMatch(
		/wants changes:\nAdd a time limit[\s\S]*propose_goal again/,
	);
	// Set by hand while the proposal was open: neither confirmed nor cancelled, and the model must not propose again.
	expect(PROPOSAL_RESULTS.replaced("Ship it")).toMatch(
		/set a goal directly instead[\s\S]*Ship it[\s\S]*do not propose another goal/,
	);
});

test("a result is text for the model, an error only when it says so", () => {
	expect(hostResult("done")).toEqual({ result: { content: [{ type: "text", text: "done" }] } });
	expect(hostResult("no", true)).toEqual({ result: { content: [{ type: "text", text: "no" }] }, isError: true });
});

// ------------------------------------------------------------------ the prompt read back

test("the interview prompt is read back as the idea behind it and the language it started in", () => {
	expect(parseInterviewPrompt(interviewPrompt("  make the tests faster ", "English"))).toEqual({
		rough: "make the tests faster",
		language: "English",
	});
	expect(parseInterviewPrompt(interviewPrompt("", "Simplified Chinese"))).toEqual({
		rough: "",
		language: "Simplified Chinese",
	});
});

test("an idea of several lines, or one that quotes the instructions, is read back whole", () => {
	const rough =
		"first line\n\nGuided goal setup: interview me first, then propose the goal for me to confirm.\n- a list";
	expect(parseInterviewPrompt(interviewPrompt(rough, "English"))?.rough).toBe(rough);
});

test("any other message is not an interview prompt", () => {
	for (const text of [
		"",
		"make the tests faster",
		"Help me define a goal. My rough idea: x",
		interviewPrompt("x", "English").replace("Guided goal setup", "Setup"),
		// A user who writes a message that merely starts the same way.
		"Help me define a goal. My rough idea: x\n\nand more",
		// The instructions without the opening line.
		interviewPrompt("x", "English").split("\n").slice(2).join("\n"),
		// Missing its last line: not what the web UI sent.
		interviewPrompt("x", "English").split("\n").slice(0, -1).join("\n"),
	]) {
		expect(parseInterviewPrompt(text)).toBeNull();
	}
});

test("a guided setup is called by what it is in the language it was started in", () => {
	expect(interviewLabel(INTERVIEW_LANGUAGES.en)).toBe("Guided goal setup");
	expect(interviewLabel(INTERVIEW_LANGUAGES["zh-CN"])).toBe("引导式目标设定");
	// A language the web UI does not offer still gets a label.
	expect(interviewLabel("French")).toBe("Guided goal setup");
});

test("the server's names for a guided setup are the interface's own", async () => {
	const zh = await import("../../web/src/i18n/zh-CN/panel.ts");
	expect(interviewLabel(INTERVIEW_LANGUAGES.en)).toBe(en.guidedSetup);
	expect(interviewLabel(INTERVIEW_LANGUAGES["zh-CN"])).toBe(zh.zh.guidedSetup);
});

test("a conversation that began as a guided goal is named by the idea, or by a label, never by the instructions", () => {
	const session = (first: string) =>
		summarize(
			"/f.jsonl",
			parseSessionText(
				[
					JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "2026-01-01T00:00:00Z", cwd: "/w/proj" }),
					JSON.stringify({
						type: "message",
						id: "u1",
						parentId: null,
						timestamp: "2026-01-01T00:00:01Z",
						message: { role: "user", content: [{ type: "text", text: first }] },
					}),
				].join("\n"),
			),
			{ mtimeMs: 1, size: 2 },
			0,
		);
	expect(session(interviewPrompt("make the tests faster", "English"))?.preview).toBe("make the tests faster");
	expect(session(interviewPrompt("", "English"))?.preview).toBe("Guided goal setup");
	expect(session(interviewPrompt("", "Simplified Chinese"))?.preview).toBe("引导式目标设定");
	// An ordinary first message is unchanged.
	expect(session("hello there")?.preview).toBe("hello there");
});
