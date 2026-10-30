import "./browser-globals.ts";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { OmpJob, OmpState } from "../../shared/omp-install.ts";
import { onServer, useApp } from "../../web/src/store/app.ts";
import {
	dismissedNotices,
	dismissNotice,
	logLines,
	ompScreen,
	onOmpMessage,
	setOmpSnapshot,
	useOmp,
} from "../../web/src/store/omp.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

/** What the page makes of what the server says about omp: which screen, the output of a job, the notices put away. */

beforeAll(installGlobals);
afterAll(restoreGlobals);
beforeEach(() => useOmp.setState({ state: null, loaded: false, log: "" }));

const job = (id: string, state: OmpJob["state"] = "running"): OmpJob => ({
	id,
	kind: "install",
	method: "homebrew",
	command: "brew install can1357/tap/omp",
	state,
	exitCode: null,
	error: null,
	startedAt: 0,
	endedAt: null,
	auto: false,
	waiting: { working: 0, asking: 0, paused: 0 },
	anyway: false,
	version: null,
});

const state = (over: Partial<OmpState> = {}): OmpState => ({
	status: "ready",
	bin: "/opt/homebrew/bin/omp",
	version: "18.12.1",
	error: null,
	searched: [],
	install: null,
	options: [],
	compat: { range: ">=18.11.0 <19.0.0", verdict: "supported" },
	release: null,
	releaseError: null,
	checking: false,
	autoUpdate: false,
	autoWaitingFor: null,
	onboarding: false,
	job: null,
	boot: "run-1",
	rev: 1,
	...over,
});

test("the app is held back until the server has answered, then shown, or replaced by the screen omp needs", () => {
	expect(ompScreen({ state: null, loaded: false })).toBe("loading");
	// Loaded without an answer (the server could not be asked): the app shows, with its own reconnecting notice.
	expect(ompScreen({ state: null, loaded: true })).toBeNull();
	expect(ompScreen({ state: state(), loaded: true })).toBeNull();
	expect(ompScreen({ state: state({ status: "missing", bin: null, version: null }), loaded: true })).toBe("first-run");
	expect(ompScreen({ state: state({ status: "broken", error: "dyld" }), loaded: true })).toBe("first-run");
	expect(ompScreen({ state: state({ onboarding: true }), loaded: true })).toBe("onboarding");
});

test("output is read as a terminal shows it: a carriage return starts the line over", () => {
	expect(logLines("==> Fetching\n==> Installing\n")).toEqual(["==> Fetching", "==> Installing"]);
	expect(logLines("10%\r50%\r100%\ndone\n")).toEqual(["100%", "done"]);
	expect(logLines("")).toEqual([]);
	expect(logLines("no newline yet")).toEqual(["no newline yet"]);
});

test("a job's output is its own: it grows with its messages and starts over with the next job", () => {
	onOmpMessage({ t: "omp", state: state({ status: "missing", job: job("J1") }) });
	onOmpMessage({ t: "omp_log", job: "J1", text: "one\n" });
	onOmpMessage({ t: "omp_log", job: "J1", text: "two\n" });
	// Output of a job the page does not show is not added.
	onOmpMessage({ t: "omp_log", job: "J0", text: "stale\n" });
	expect(useOmp.getState().log).toBe("one\ntwo\n");
	// The same job's state changing keeps its output.
	onOmpMessage({ t: "omp", state: state({ status: "missing", job: job("J1", "failed") }) });
	expect(useOmp.getState().log).toBe("one\ntwo\n");
	// Another job: the last one's output is not its.
	onOmpMessage({ t: "omp", state: state({ status: "missing", job: job("J2") }) });
	expect(useOmp.getState().log).toBe("");
	onOmpMessage({ t: "omp", state: state({ status: "missing", job: null }) });
	expect(useOmp.getState().log).toBe("");
});

test("an answer to a request does not shorten output that already arrived over the socket", () => {
	onOmpMessage({ t: "omp", state: state({ job: job("J1") }) });
	onOmpMessage({ t: "omp_log", job: "J1", text: "abc\ndef\n" });
	// The reply to a request made before `def` was printed.
	setOmpSnapshot({ state: state({ job: job("J1") }), log: "abc\n" });
	expect(useOmp.getState().log).toBe("abc\ndef\n");
	// A page that has seen nothing takes the server's account.
	useOmp.setState({ state: null, log: "" });
	setOmpSnapshot({ state: state({ job: job("J1") }), log: "abc\ndef\n" });
	expect(useOmp.getState().log).toBe("abc\ndef\n");
});

test("an answer that a newer socket message overtook does not put the page back: a failed update is not shown as running", () => {
	// An update that fails at once: `failed` is pushed before the answer to the request that started it is read.
	onOmpMessage({ t: "omp", state: state({ rev: 2, job: job("J1", "failed") }) });
	setOmpSnapshot({ state: state({ rev: 1, job: job("J1", "running") }), log: "" });
	expect(useOmp.getState().state?.job?.state).toBe("failed");
	// The other way round: a push older than an answer that was already taken.
	setOmpSnapshot({ state: state({ rev: 4, job: job("J1", "done") }), log: "" });
	onOmpMessage({ t: "omp", state: state({ rev: 3, job: job("J1", "running") }) });
	expect(useOmp.getState().state?.job?.state).toBe("done");
	// What is later is taken, and so is what is as late as what the page holds (an answer about the state a push told).
	onOmpMessage({ t: "omp", state: state({ rev: 5, job: null }) });
	expect(useOmp.getState().state?.job).toBeNull();
	setOmpSnapshot({ state: state({ rev: 5, job: null, autoUpdate: true }), log: "" });
	expect(useOmp.getState().state?.autoUpdate).toBe(true);
});

test("a server that started again counts from the start: its states are not taken for old ones", () => {
	onOmpMessage({ t: "omp", state: state({ boot: "run-1", rev: 40, version: "18.12.0" }) });
	onOmpMessage({ t: "omp", state: state({ boot: "run-2", rev: 1, version: "18.13.0" }) });
	expect(useOmp.getState().state?.version).toBe("18.13.0");
	setOmpSnapshot({ state: state({ boot: "run-2", rev: 2, version: "18.14.0" }), log: "" });
	expect(useOmp.getState().state?.version).toBe("18.14.0");
});

test("the server's message reaches the store, and the version Settings shows follows an update", () => {
	useApp.setState({
		meta: {
			ompVersion: "18.12.0",
			serverVersion: "0.9.1",
			agentDir: "",
			sessionsDir: "",
			home: "",
			user: "",
			remote: false,
			local: true,
			macs: [],
		},
	});
	onServer({ t: "omp", state: state({ version: "18.13.0" }) });
	expect(useOmp.getState().state?.version).toBe("18.13.0");
	expect(useApp.getState().meta?.ompVersion).toBe("18.13.0");
	// Missing omp: the version is unknown, not stale.
	onServer({ t: "omp", state: state({ status: "missing", version: null, bin: null }) });
	expect(useApp.getState().meta?.ompVersion).toBe("unknown");
});

test("a notice put away stays away for that version only", () => {
	expect(dismissedNotices()).toEqual({ update: undefined, compat: undefined });
	dismissNotice("update", "18.13.0");
	expect(dismissedNotices().update).toBe("18.13.0");
	// The compat warning is its own: putting one away does not hide the other.
	dismissNotice("compat", "19.2.0");
	expect(dismissedNotices()).toEqual({ update: "18.13.0", compat: "19.2.0" });
	// A newer release is not the one put away.
	expect(dismissedNotices().update === "18.14.0").toBe(false);
});
