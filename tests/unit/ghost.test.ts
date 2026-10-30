import { describe, expect, test } from "bun:test";
import { accept, afterEdit, type Ghost, remaining, wantsPrediction } from "../../web/src/lib/ghost.ts";

const g: Ghost = { base: "Please refa", suffix: "ctoring" };

describe("ghost text", () => {
	test("typing the predicted characters narrows the ghost without feedback", () => {
		expect(remaining(g, "Please refact")).toBe("oring");
		expect(afterEdit(g, "Please refact")).toEqual({ ghost: g });
	});

	test("typing a different character rejects the prediction", () => {
		expect(afterEdit(g, "Please refam")).toEqual({
			ghost: null,
			feedback: { text: "Please refa", cursor: 11, suggestion: "ctoring", accepted: false },
		});
	});

	test("deleting back past the base rejects the prediction", () => {
		expect(afterEdit(g, "Please ref").feedback?.accepted).toBe(false);
	});

	test("typing the whole word counts as accepting it", () => {
		expect(afterEdit(g, "Please refactoring")).toEqual({
			ghost: null,
			feedback: { text: "Please refa", cursor: 11, suggestion: "ctoring", accepted: true },
		});
	});

	test("Tab accepts the remaining suffix with a space, → without", () => {
		expect(accept(g, "Please refac", true)?.text).toBe("Please refactoring ");
		expect(accept(g, "Please refac", false)?.text).toBe("Please refactoring");
		expect(accept(g, "Please refac", false)?.feedback).toEqual({
			text: "Please refa",
			cursor: 11,
			suggestion: "ctoring",
			accepted: true,
		});
	});

	test("accept does nothing once the user typed away", () => {
		expect(accept(g, "Please refx", true)).toBeNull();
		expect(accept(null, "anything", true)).toBeNull();
	});

	test("predictions are requested only while typing a word at the end", () => {
		expect(wantsPrediction("Please refa", 11)).toBe(true);
		expect(wantsPrediction("Please refa", 5)).toBe(false);
		expect(wantsPrediction("Please ", 7)).toBe(false);
		expect(wantsPrediction("", 0)).toBe(false);
		expect(wantsPrediction("/mod", 4)).toBe(false);
		expect(wantsPrediction("!ls", 3)).toBe(false);
	});
});
