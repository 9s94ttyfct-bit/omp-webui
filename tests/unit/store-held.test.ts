import "./browser-globals.ts";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ListPref } from "../../server/sessions/actions.ts";
import type { LiveInfo, OmpFrame, ServerMessage } from "../../shared/protocol.ts";
import { onServer, useApp } from "../../web/src/store/app.ts";
import { applyFrame, initialLive } from "../../web/src/store/live.ts";
import { seedTurnClock, useTurnClocks } from "../../web/src/store/turn-clock.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

/**
 * What omp says once and the server keeps for a page that attaches later (#587): the page shows it from the frames it is
 * sent, drops what the server does not name any more (`attached`), and times a turn it did not see begin from the server's
 * stamp. A list the person changes on one page (archived, loved models) is every page's.
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);

const info: LiveInfo = {
	liveId: "LH1",
	pid: 1,
	cwd: "/",
	sessionFile: "/sessions/h.jsonl",
	sessionId: "s",
	args: [],
	startedAt: 0,
	streaming: false,
	exited: false,
	subscribers: 1,
	pausedAt: null,
	mode: "full",
};

const status = (key: string, text: string): OmpFrame => ({
	type: "extension_ui_request",
	id: `s-${key}`,
	method: "setStatus",
	statusKey: key,
	statusText: text,
});
const widget = (key: string, lines: string[]): OmpFrame => ({
	type: "extension_ui_request",
	id: `w-${key}`,
	method: "setWidget",
	widgetKey: key,
	widgetLines: lines,
});
const live = () => useApp.getState().lives.LH1;

beforeEach(() => {
	useApp.setState({ lives: { LH1: initialLive(info) }, bash: {} });
	useTurnClocks.setState({}, true);
});

test("an attach names what the server holds: a status, a widget or a compaction the page shows beyond it ended while it was away", () => {
	let s = initialLive(info);
	s = applyFrame(s, status("lint", "Lint: 3 warnings"));
	s = applyFrame(s, status("build", "Building"));
	s = applyFrame(s, widget("todo", ["one"]));
	s = applyFrame(s, { type: "auto_compaction_start", reason: "threshold", action: "context-full" });
	useApp.setState({ lives: { LH1: s } });

	onServer({
		t: "attached",
		liveId: "LH1",
		dialogs: [],
		message: null,
		held: { compacting: true, statuses: ["lint"], widgets: [], bashes: [] },
	});
	expect(Object.keys(live().statuses)).toEqual(["lint"]);
	expect(live().widgets).toEqual({});
	// The server still holds the compaction: the page goes on showing it.
	expect(live().compacting).not.toBeNull();

	onServer({
		t: "attached",
		liveId: "LH1",
		dialogs: [],
		message: null,
		held: { compacting: false, statuses: ["lint"], widgets: [], bashes: [] },
	});
	expect(live().compacting).toBeNull();
	expect(Object.keys(live().statuses)).toEqual(["lint"]);
});

test("an attach from a server that predates `held` names nothing it keeps, and the page reads it without throwing", () => {
	let s = initialLive(info);
	s = applyFrame(s, status("lint", "Lint: 3 warnings"));
	useApp.setState({ lives: { LH1: s } });
	// No `held` at all, as a server that predates the field sends it: the frame must not throw, and names nothing held.
	const frame: ServerMessage = { t: "attached", liveId: "LH1", dialogs: [], message: null };
	expect(() => onServer(frame)).not.toThrow();
	expect(live().statuses).toEqual({});
});

test("an attach that names all the page shows changes nothing: the state is the same object", () => {
	let s = applyFrame(initialLive(info), status("lint", "Lint: 3 warnings"));
	s = { ...s, needsInput: false };
	useApp.setState({ lives: { LH1: s } });
	onServer({
		t: "attached",
		liveId: "LH1",
		dialogs: [],
		message: null,
		held: { compacting: false, statuses: ["lint"], widgets: [], bashes: [] },
	});
	expect(live()).toBe(s);
});

test("a turn the page did not see begin is timed from the server's stamp, and what the agent had worked before it is the saved entries'", () => {
	const began = Date.parse("2026-02-01T00:10:00Z");
	const entry = (id: string, at: string, role: "user" | "assistant") =>
		({
			type: "message",
			id,
			parentId: null,
			timestamp: at,
			message: { role, content: [{ type: "text", text: id }], timestamp: Date.parse(at) },
		}) as never;
	const entries = [
		entry("p1", "2026-02-01T00:00:00Z", "user"),
		entry("r1", "2026-02-01T00:00:30Z", "assistant"),
		// The prompt of the turn that runs: written after the turn began, so not part of what came before.
		entry("p2", "2026-02-01T00:10:01Z", "user"),
	];
	seedTurnClock("LH1", 1_000, began, entries);
	const clock = useTurnClocks.getState().LH1;
	expect(clock.startedAt).toBe(1_000);
	expect(clock.activeBefore).toBe(30_000);

	// A clock that frames started is not replaced.
	seedTurnClock("LH1", 5_000, began, entries);
	expect(useTurnClocks.getState().LH1.startedAt).toBe(1_000);
});

test("the loved models another page changed are the list this page shows", () => {
	useApp.setState({ favoriteModels: ["a/b"] });
	onServer({ t: "favorite_models", models: ["c/d", "a/b"] });
	expect(useApp.getState().favoriteModels).toEqual(["c/d", "a/b"]);
});

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompw-listpref-held-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

test("a list that is changed tells those who listen, once per change, and says nothing of a change that changes nothing", () => {
	const told: string[][] = [];
	const archived = new ListPref(dir, "archived");
	archived.onChange((list) => told.push(list));
	archived.set(["/s/a.jsonl"], true);
	archived.set(["/s/a.jsonl"], true);
	archived.set(["/s/b.jsonl"], true);
	archived.set(["/s/gone.jsonl"], false);
	archived.set(["/s/a.jsonl"], false);
	expect(told).toEqual([["/s/a.jsonl"], ["/s/b.jsonl", "/s/a.jsonl"], ["/s/b.jsonl"]]);
});
