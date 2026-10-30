import "./browser-globals.ts";
import { afterAll, beforeAll, beforeEach, expect, type Mock, spyOn, test } from "bun:test";
import { useApp } from "../../web/src/store/app.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

/**
 * The session list before and after its first load: a failure with nothing to show is an error the sidebar
 * says (with a Retry), not an empty or endless list; once there is a list, a failed refresh keeps it.
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);

let broken = true;
let fetchSpy: Mock<typeof fetch> | undefined;
beforeEach(() => {
	fetchSpy?.mockRestore();
	broken = true;
	fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) =>
		String(input) === "/api/sessions" && broken
			? Response.json({ error: "Internal Server Error" }, { status: 500 })
			: Response.json([])) as typeof fetch);
	useApp.setState({ sessions: [], sessionsLoaded: false, sessionsError: null, toasts: [] });
});

test("a first load that fails leaves the list unloaded, with the reason and no toast", async () => {
	await useApp.getState().loadSessions();
	const s = useApp.getState();
	expect(s.sessionsLoaded).toBe(false);
	expect(s.sessionsError).toBe("Internal Server Error");
	expect(s.toasts).toEqual([]);
});

test("a retry starts clean and, once it works, loads the list", async () => {
	await useApp.getState().loadSessions();
	expect(useApp.getState().sessionsError).toBe("Internal Server Error");

	broken = false;
	const retry = useApp.getState().loadSessions();
	// While it runs there is no error to show: the sidebar is back to its spinner.
	expect(useApp.getState().sessionsError).toBeNull();
	await retry;
	expect(useApp.getState().sessionsLoaded).toBe(true);
	expect(useApp.getState().sessionsError).toBeNull();
});

test("a retry that fails again shows the error again", async () => {
	await useApp.getState().loadSessions();
	const retry = useApp.getState().loadSessions();
	expect(useApp.getState().sessionsError).toBeNull();
	await retry;
	expect(useApp.getState().sessionsLoaded).toBe(false);
	expect(useApp.getState().sessionsError).toBe("Internal Server Error");
});

test("a refresh that fails after the list loaded keeps the list and says so in a toast", async () => {
	broken = false;
	await useApp.getState().loadSessions();
	expect(useApp.getState().sessionsLoaded).toBe(true);

	broken = true;
	await useApp.getState().loadSessions();
	const s = useApp.getState();
	expect(s.sessionsLoaded).toBe(true);
	expect(s.sessionsError).toBeNull();
	expect(s.toasts.map((t) => t.text)).toEqual(["Could not load sessions: Internal Server Error"]);
});
