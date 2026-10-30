import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { guiSkipNotice, guiTests } from "../support/gui-tests.ts";

/**
 * What the macOS shell does when it is asked to quit (macos/quit.swift, #604): the question has three answers, Run in
 * Background (the default) / Quit / Cancel, with a "Don't ask again" box; a person who chose for good is not asked; a window
 * that is already in the background is only asked whether to quit; and the end of the session (log out, restart, shut down)
 * never asks. The harness (tests/support/swift/quit/main.swift) runs the shell's own functions and, for the last, real quit
 * Apple events sent to a real `NSApplication` and read in its `applicationShouldTerminate`, as logout delivers them.
 */

const here = import.meta.dir;
const dir = mkdtempSync(join(tmpdir(), "ompw-quit-"));
const harness = join(dir, "quit-harness");
const mac = process.platform === "darwin" && Bun.which("swiftc") !== null;
guiSkipNotice("macos-quit (the pending-quit question)");

interface Context {
	working: number;
	paused: number;
	waiting: number;
	job: string | null;
	reachable: boolean;
	remote: boolean;
	action: string;
	language: string;
}

interface Dialog {
	informational: boolean;
	message: string;
	detail: string;
	buttons: { title: string; choice: string; destructive: boolean }[];
	remember: string | null;
}

interface Report {
	context: Record<string, Context>;
	first: Record<string, string>;
	dialogs: Record<string, Dialog>;
	warnings: Record<string, boolean>;
	session: { asked: number; ending: Record<string, boolean> };
}

let report: Report;

beforeAll(async () => {
	if (!mac) return;
	const built = Bun.spawnSync(
		[
			"swiftc",
			"-O",
			"-swift-version",
			"5",
			join(here, "../../macos/quit.swift"),
			join(here, "../support/swift/quit/main.swift"),
			"-o",
			harness,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (built.exitCode !== 0) throw new Error(`swiftc failed:\n${built.stderr.toString()}`);
	const run = Bun.spawn([harness], { stdout: "pipe", stderr: "pipe" });
	const out = await new Response(run.stdout).text();
	expect(await run.exited).toBe(0);
	report = JSON.parse(out) as Report;
}, 180_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const titles = (d: Dialog) => d.buttons.map((b) => b.title);
const choices = (d: Dialog) => d.buttons.map((b) => b.choice);

test.skipIf(!mac)("the server's answers say what is running, what is chosen and in which language", () => {
	const c = report.context;
	// Counts are of processes that are still there; a usage-limit wait whose turn has started is working, not waiting.
	expect([c.working.working, c.working.paused, c.working.waiting]).toEqual([1, 0, 0]);
	expect([c.paused.working, c.paused.paused, c.paused.waiting]).toEqual([0, 1, 0]);
	expect([c.waiting.working, c.waiting.paused, c.waiting.waiting]).toEqual([0, 0, 1]);
	expect([c.resumedWait.working, c.resumedWait.waiting]).toEqual([1, 0]);
	// An install or update counts while it runs, not after it ended.
	expect(c.job.job).toBe("install");
	expect(c.jobEnded.job).toBeNull();
	// A server that answers nothing is not reachable and has nothing running: quitting never hangs on it.
	expect(c.silent.reachable).toBe(false);
	expect([c.silent.working, c.silent.paused, c.silent.waiting, c.silent.job]).toEqual([0, 0, 0, null]);
	expect(c.empty.reachable).toBe(true);
	// Remote access counts while the tunnel is up or coming up, not while it is off or failing.
	expect([c.remoteConnected.remote, c.remoteStarting.remote, c.remoteError.remote, c.remoteOff.remote]).toEqual([
		true,
		true,
		false,
		false,
	]);
	// What the person chose; anything the shell does not know asks.
	expect([c.background.action, c.quit.action, c.ask.action]).toEqual(["background", "quit", "ask"]);
	expect([c.unknownAction.action, c.noAction.action, c.empty.action]).toEqual(["ask", "ask", "ask"]);
	// The page's own order: the saved language, else the first language the Mac prefers.
	expect([c.savedZh.language, c.savedEn.language, c.macZh.language, c.macEn.language]).toEqual([
		"zh",
		"en",
		"zh",
		"en",
	]);
});

test.skipIf(!mac)(
	"a quit asks, runs in the background or quits as the person chose, and a window in the background only quits",
	() => {
		const f = report.first;
		expect(f["ask/front/up"]).toBe("ask");
		expect(f["background/front/up"]).toBe("runInBackground");
		expect(f["quit/front/up"]).toBe("quit");
		// Running in the background again makes no sense: whatever was chosen, a window that is out of sight asks to quit.
		for (const action of ["ask", "background", "quit"]) expect(f[`${action}/background/up`]).toBe("quit");
		// A server that does not answer is quit at once, never hidden: a windowless app without a server is of no use.
		for (const action of ["ask", "background", "quit"]) {
			expect(f[`${action}/front/down`]).toBe("quit");
			expect(f[`${action}/background/down`]).toBe("quit");
		}
	},
);

test.skipIf(!mac)("the question's default is Run in Background, Escape is Cancel, and Quit says what it stops", () => {
	for (const lang of ["en", "zh"]) {
		for (const situation of [
			"nothing",
			"oneWorking",
			"manyWorking",
			"onePaused",
			"pausedAndWaiting",
			"install",
			"remoteOnly",
		]) {
			const d = report.dialogs[`${lang}/${situation}/background`];
			expect(choices(d).slice(0, 3)).toEqual(["runInBackground", "cancel", "quit"]);
			expect(d.remember).toBe(lang === "en" ? "Don't ask again" : "不再询问");
			expect(d.detail.length).toBeGreaterThan(0);
		}
	}
	const en = report.dialogs["en/manyWorking/background"];
	expect(titles(en)).toEqual(["Run in Background", "Cancel", "Quit Anyway"]);
	expect(en.buttons[2].destructive).toBe(true);
	expect(en.informational).toBe(false);
	expect(en.message).toBe("3 conversations are still working");
	expect(en.detail).toContain("Run in Background closes the window but keeps omp-webui running");
	// The way back is the menu bar icon: with no window the app has no Dock icon (#627).
	expect(en.detail).toContain("Click the omp-webui icon in the menu bar to open the window again.");
	expect(en.detail).not.toContain("Dock");
	const zh = report.dialogs["zh/manyWorking/background"];
	expect(zh.detail).toContain("点击菜单栏里的 omp-webui 图标即可重新打开窗口。");
	expect(zh.detail).not.toContain("程序坞");
	expect(en.detail).toContain("Quitting stops them.");
	expect(report.dialogs["en/oneWorking/background"].detail).toContain("Quitting stops it.");

	const idle = report.dialogs["en/nothing/background"];
	expect(idle.message).toBe("Quit omp-webui?");
	expect(titles(idle)).toEqual(["Run in Background", "Cancel", "Quit"]);
	expect(idle.informational).toBe(true);
	expect(idle.buttons[2].destructive).toBe(false);
});

test.skipIf(!mac)("the question says that remote access stays on only while it is on", () => {
	expect(report.dialogs["en/remoteOnly/background"].detail).toContain(
		"conversations carry on and remote access stays on",
	);
	expect(report.dialogs["en/nothing/background"].detail).not.toContain("remote");
	expect(report.dialogs["zh/remoteOnly/background"].detail).toContain("远程访问也保持开启");
	expect(report.dialogs["zh/nothing/background"].detail).not.toContain("远程");
});

test.skipIf(!mac)(
	"the paused and waiting conversations that stay are told, and the ones a quit can end are offered",
	() => {
		const paused = report.dialogs["en/onePaused/background"];
		expect(paused.message).toBe("1 conversation is paused");
		expect(titles(paused)).toEqual(["Run in Background", "Cancel", "Quit", "Quit and End It"]);
		expect(paused.buttons[3]).toEqual({ title: "Quit and End It", choice: "quitEndingKept", destructive: true });
		expect(paused.detail).toContain("It stays frozen in the background");
		const many = report.dialogs["en/manyPaused/background"];
		expect(titles(many).at(-1)).toBe("Quit and End Paused");
		expect(titles(report.dialogs["en/oneWaiting/background"]).at(-1)).toBe("Quit and End It");
		expect(titles(report.dialogs["en/pausedAndWaiting/background"]).at(-1)).toBe("Quit and End Them");
		// Nothing that is working: no warning style.
		expect(paused.informational).toBe(true);
		// Both are one-off answers: the box is for Run in Background and Quit alone, which is what the shell applies it to.
		expect(report.dialogs["en/install/background"].message).toBe("omp is being installed");
		expect(report.dialogs["en/update/background"].message).toBe("omp is being updated");
	},
);

test.skipIf(!mac)("the question that only asks whether to quit is what it always was, with no box to tick", () => {
	const working = report.dialogs["en/manyWorking/quitOnly"];
	expect(titles(working)).toEqual(["Cancel", "Quit Anyway"]);
	expect(working.detail).toBe("Quit anyway? Quitting stops them.");
	expect(working.remember).toBeNull();
	expect(working.informational).toBe(false);
	expect(titles(report.dialogs["en/onePaused/quitOnly"])).toEqual(["Quit", "Cancel", "Quit and End It"]);
	expect(titles(report.dialogs["en/install/quitOnly"])).toEqual(["Cancel", "Quit"]);
	expect(report.dialogs["en/install/quitOnly"].detail).toBe(
		"The install is not stopped by quitting: it finishes in the background, and omp-webui shows how it ended when you open it again.",
	);
	expect(report.dialogs["en/oneWorkingOnePaused/quitOnly"].detail).toBe(
		"Quit anyway? Quitting stops it. The paused conversation stays frozen in the background, with running tools, and continues where it stopped when you open omp-webui again.",
	);
	for (const key of Object.keys(report.dialogs).filter((k) => k.endsWith("/quitOnly"))) {
		expect(report.dialogs[key].remember).toBeNull();
	}
	// Only what is working, paused, waiting or running is worth a question when the app is only to be quit.
	expect(report.warnings).toMatchObject({
		nothing: false,
		remoteOnly: false,
		oneWorking: true,
		onePaused: true,
		oneWaiting: true,
		install: true,
		update: true,
	});
});

test.skipIf(!mac)("the Chinese question says 对话, never 会话, and the same things the English one does", () => {
	const all = Object.entries(report.dialogs).filter(([key]) => key.startsWith("zh/"));
	expect(all.length).toBeGreaterThan(10);
	for (const [key, d] of all) {
		const text = [d.message, d.detail, ...titles(d), d.remember ?? ""].join("\n");
		expect(text, key).not.toContain("会话");
		// No English left over: every word on the screen is the language the page is in (omp and the app's name stay).
		expect(text.replace(/omp-webui|omp/g, ""), key).not.toMatch(/[A-Za-z]{3,}/);
	}
	const zh = report.dialogs["zh/manyWorking/background"];
	expect(titles(zh)).toEqual(["在后台运行", "取消", "仍然退出"]);
	expect(zh.message).toBe("有 3 个对话仍在工作");
	expect(titles(report.dialogs["zh/onePaused/quitOnly"])).toEqual(["退出", "取消", "退出并结束它"]);
	expect(report.dialogs["zh/manyWorking/quitOnly"].detail).toBe("仍要退出吗？退出会停止它们。");
});

test.skipIf(!mac)(
	"the end of the session is told from the quit event's reason, and nothing else is taken for it",
	() => {
		const { asked, ending } = report.session;
		// Every quit was delivered to the application's delegate: a plain Apple event, ⌘Q (`terminate`), and the reasons.
		expect(asked).toBe(9);
		for (const reason of ["logOut", "reallyLogOut", "restartDialog", "shutdownDialog", "restart", "shutdown"]) {
			expect(ending[reason], reason).toBe(true);
		}
		// Dock › Quit and `osascript … quit` are a quit event without a reason; ⌘Q has no event at all; another reason is not one.
		for (const other of ["appleEvent", "terminate", "userReason"]) expect(ending[other], other).toBe(false);
	},
);

// A question that is open is a modal panel on the screen: these two are among the tests that open real windows, which run only
// with OMPW_GUI_TESTS=1 (`bun run test:gui`, tests/support/gui-tests.ts).

/** Run the harness's pending-quit phase: a quit is waiting for the question that is open, and the session ends. */
async function whileAsking(mode: "modal" | "modal-event") {
	const run = Bun.spawn([harness, mode], { stdout: "pipe", stderr: "pipe" });
	const out = await new Response(run.stdout).text();
	return { exit: await run.exited, report: JSON.parse(out) as Record<string, unknown> };
}

test.skipIf(!guiTests)(
	"the system's announcement of a logout closes the question that is open, and the quit that waits for it is answered: quit",
	async () => {
		const { exit, report } = await whileAsking("modal");
		// -1001 is a modal session that was aborted, not answered by anyone.
		expect(report).toEqual({ closedWith: -1001, endingAfter: true, ended: true, quitsSeen: 1 });
		// And the application ended, which is what the system waits for.
		expect(exit).toBe(0);
	},
	60_000,
);

test.skipIf(!guiTests)(
	"a quit event with the shutdown reason, sent while the question is open, reaches no delegate, but AppKit's own announcement of it closes the question",
	async () => {
		const { exit, report } = await whileAsking("modal-event");
		// A second quit while one is pending never reaches `applicationShouldTerminate` (it was asked once): what ends the question
		// is the end of the session announced by AppKit as it takes the event, which is what `SessionEnd` is for.
		expect(report).toEqual({ closedWith: -1001, endingAfter: true, ended: true, quitsSeen: 1 });
		expect(exit).toBe(0);
	},
	60_000,
);
