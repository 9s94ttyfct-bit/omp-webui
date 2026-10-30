import { beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { guiSkipNotice, guiTests } from "../support/gui-tests.ts";
import { tempDir } from "../support/temp-dirs.ts";

/**
 * Run in Background has no window at all (macos/background.swift, macos/mainwindow.swift, #627): the window and the page in it
 * are closed and released, the app is no longer a regular one (no Dock icon, not in ⌘-Tab or Stage Manager, and never made the
 * active app by the system to show a window it does not have), and a menu bar icon opens the window again, says what works and
 * what needs the person, and quits. What it replaced was a window kept ordered in at alpha 0 so that WebKit would not hold its
 * page back (#604): it showed in Stage Manager and came back whenever another app's last window closed.
 *
 * A harness (tests/support/swift/background/main.swift), compiled with the `swiftc` the app is built with, checks three things.
 * The menu's words and the icon's title for each count run anywhere. That `MainWindow` makes a real window with a loaded page,
 * and that once it is closed neither it nor the page is held by anything (a weak reference to each is gone), runs in a window
 * server session, with nothing ordered in. The real `BackgroundMode` (the activation policy, the status item, the window closed
 * and opened as the app does) puts a Dock icon and a menu bar icon on the screen of whoever runs it, for a moment: it is among
 * the tests that open real windows, which run only with OMPW_GUI_TESTS=1 (`bun run test:gui`, tests/support/gui-tests.ts).
 * What cannot be tested without a person is in docs/TECHNICAL.md, the manual test plan for this feature (Stage Manager,
 * ⌘-Tab, another app's window closing, ten minutes of notifications).
 */

const here = import.meta.dir;
const dir = tempDir("ompw-background-");
const harness = join(dir, "background-harness");
const mac = process.platform === "darwin" && Bun.which("swiftc") !== null;
// A window server session: a real window and a real page need one, a build on a remote shell or in CI has none.
const aqua = mac && Bun.spawnSync(["launchctl", "managername"]).stdout.toString().trim() === "Aqua";
guiSkipNotice("macos-background (the menu bar icon and the activation policy)");

beforeAll(() => {
	if (!mac) return;
	const built = Bun.spawnSync(
		[
			"swiftc",
			"-O",
			"-swift-version",
			"5",
			join(here, "../../macos/background.swift"),
			join(here, "../../macos/mainwindow.swift"),
			join(here, "../../macos/quit.swift"),
			join(here, "../support/swift/background/main.swift"),
			"-o",
			harness,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (built.exitCode !== 0) throw new Error(`swiftc failed:\n${built.stderr.toString()}`);
}, 240_000);

async function run<T>(variant: string, ...args: string[]): Promise<T> {
	const proc = Bun.spawn([harness, variant, ...args], { stdout: "pipe", stderr: "pipe" });
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`harness ${variant} exited ${code}: ${err}`);
	return JSON.parse(out) as T;
}

interface Line {
	role: string;
	title: string;
}
type Menus = Record<
	| "none"
	| "one"
	| "many"
	| "waiting"
	| "both"
	| "paused"
	| "mixed"
	| "quota"
	| "question"
	| "questions"
	| "finishedOne"
	| "finishedMany"
	| "everything",
	Line[]
>;

const open = (title: string): Line => ({ role: "open", title });
const info = (title: string): Line => ({ role: "info", title });
const rule: Line = { role: "separator", title: "" };
const quit = (title: string): Line => ({ role: "quit", title });
const pauseAll = (title: string): Line => ({ role: "pauseAll", title });
const resumeAll = (title: string): Line => ({ role: "resumeAll", title });
const questions = (title: string): Line => ({ role: "questions", title });

test.skipIf(!mac)(
	"the icon's menu opens the window, says what works, waits and is paused, pauses or resumes them all, shows the quota, and quits",
	async () => {
		const report = await run<{ en: Menus; zh: Menus; titles: string[]; watch: number[]; route: (string | null)[] }>(
			"model",
		);
		expect(report.en.none).toEqual([
			open("Open omp-webui"),
			rule,
			info("No conversations working"),
			rule,
			quit("Quit omp-webui"),
		]);
		// Something working: Pause all, after what is going on.
		expect(report.en.one).toEqual([
			open("Open omp-webui"),
			rule,
			info("1 conversation working"),
			pauseAll("Pause All Conversations"),
			rule,
			quit("Quit omp-webui"),
		]);
		expect(report.en.many[2]).toEqual(info("3 conversations working"));
		// A conversation that waits for an answer is told apart from one that works, and the menu says "no conversations working" only when nothing is.
		expect(report.en.waiting.slice(2, 4)).toEqual([
			info("1 conversation needs your input"),
			pauseAll("Pause All Conversations"),
		]);
		expect(report.en.both.slice(2, 4)).toEqual([
			info("2 conversations working"),
			info("2 conversations need your input"),
		]);
		// Only paused ones: nothing to pause, and Resume all; with one working too, both.
		expect(report.en.paused.slice(2, 4)).toEqual([
			info("2 conversations paused"),
			resumeAll("Resume All Paused Conversations"),
		]);
		expect(report.en.mixed.slice(2, 6)).toEqual([
			info("1 conversation working"),
			info("1 conversation paused"),
			pauseAll("Pause All Conversations"),
			resumeAll("Resume All Paused Conversations"),
		]);
		// The quota, one line per provider, between what is going on and Quit.
		expect(report.en.quota).toEqual([
			open("Open omp-webui"),
			rule,
			info("No conversations working"),
			rule,
			info("anthropic: 62% left"),
			info("zai: 30% left"),
			rule,
			quit("Quit omp-webui"),
		]);
		// In the page's language (the Chinese says 对话, never 会话).
		expect(report.zh.none).toEqual([
			open("打开 omp-webui"),
			rule,
			info("没有正在工作的对话"),
			rule,
			quit("退出 omp-webui"),
		]);
		expect(report.zh.one[2]).toEqual(info("1 个对话正在工作"));
		expect(report.zh.waiting[2]).toEqual(info("1 个对话需要你的输入"));
		expect(report.zh.both.slice(2, 5)).toEqual([
			info("2 个对话正在工作"),
			info("2 个对话需要你的输入"),
			pauseAll("暂停所有对话"),
		]);
		expect(report.zh.paused.slice(2, 4)).toEqual([info("2 个对话已暂停"), resumeAll("继续所有已暂停的对话")]);
		for (const menu of [...Object.values(report.en), ...Object.values(report.zh)])
			expect(menu.map((l) => l.title).join("")).not.toContain("会话");
		// The icon carries the number that wait for the person (dialogs and open questions together), a ✓ when a run finished
		// since the person looked, and nothing when none does.
		expect(report.titles).toEqual(["", " 1", " 12", " 2", " 5", " ✓", " 2 ✓"]);
		// Questions that wait: a line that opens the Questions page, after what is going on and before Pause all.
		expect(report.en.question).toEqual([
			open("Open omp-webui"),
			rule,
			info("No conversations working"),
			questions("1 question waiting"),
			rule,
			quit("Quit omp-webui"),
		]);
		expect(report.en.questions.slice(2, 5)).toEqual([
			info("1 conversation working"),
			questions("3 questions waiting"),
			pauseAll("Pause All Conversations"),
		]);
		expect(report.zh.question[3]).toEqual(questions("1 个问题等待回答"));
		expect(report.zh.questions[3]).toEqual(questions("3 个问题等待回答"));
		// Runs that finished since the person looked: a line that says it, and does nothing.
		expect(report.en.finishedOne[3]).toEqual(info("1 conversation finished"));
		expect(report.en.finishedMany[3]).toEqual(info("4 conversations finished"));
		expect(report.zh.finishedMany[3]).toEqual(info("4 个对话已完成"));
		// Everything at once, in order: what is going on, the questions, the finished runs, Pause all and Resume all, the quota.
		expect(report.en.everything).toEqual([
			open("Open omp-webui"),
			rule,
			info("1 conversation working"),
			info("1 conversation needs your input"),
			info("1 conversation paused"),
			questions("2 questions waiting"),
			info("2 conversations finished"),
			pauseAll("Pause All Conversations"),
			resumeAll("Resume All Paused Conversations"),
			rule,
			info("zai: 30% left"),
			rule,
			quit("Quit omp-webui"),
		]);
		// What the person has seen of the finished runs: a server's first count is seen, news until they look, and a new epoch
		// (a server that began again) starts over; a state with no epoch is of the one before.
		expect(report.watch).toEqual([0, 2, 2, 0, 1, 0, 1, 3]);
		// The window that is closed keeps the Questions page for its next page, once.
		expect(report.route).toEqual(["#/questions", null]);
	},
);

interface WindowReport {
	openBefore: boolean;
	windowsBefore: number;
	made: boolean;
	madeAgain: boolean;
	sameWindow: boolean;
	releasedWhenClosed: boolean;
	windowsOpen: number;
	pageLoaded: boolean;
	openAfterClose: boolean;
	windowNil: boolean;
	webViewNil: boolean;
	windowsClosed: number;
	webViewReleased: boolean;
	windowReleased: boolean;
	madeNew: boolean;
	differentWindow: boolean;
	windowsReopened: number;
}

test.skipIf(!aqua)(
	"closing the window releases it and its page: nothing of either is held, and opening makes new ones",
	async () => {
		const w = await run<WindowReport>("window");
		// Not made until asked, and asking twice makes one: it is the app's one window.
		expect(w).toMatchObject({
			openBefore: false,
			windowsBefore: 0,
			made: true,
			madeAgain: false,
			sameWindow: true,
			windowsOpen: 1,
		});
		// AppKit must not release a window the app releases too.
		expect(w.releasedWhenClosed).toBe(false);
		expect(w.pageLoaded).toBe(true);
		// Closed: no window object, no web view, and nothing keeps them alive (weak references to both are gone).
		expect(w).toMatchObject({
			openAfterClose: false,
			windowNil: true,
			webViewNil: true,
			windowsClosed: 0,
			webViewReleased: true,
			windowReleased: true,
		});
		// Opened again: new ones, and the one window again.
		expect(w).toMatchObject({ madeNew: true, differentWindow: true, windowsReopened: 1 });
	},
);

interface ModeReport {
	front: { policy: string; windows: number; icon: boolean; active: boolean };
	background: {
		policy: string;
		windows: number;
		window: boolean;
		page: boolean;
		icon: boolean;
		active: boolean;
		closing: number;
		titles: string[];
		buttonTitle: string;
		windowReleased: boolean;
		pageReleased: boolean;
		kinds: string[];
	};
	againClosing: number;
	attention: Record<
		"first" | "ran" | "looked" | "whileOpen" | "closed" | "one" | "active" | "epoch" | "chineseFinished",
		{ titles: string[]; buttonTitle: string }
	> & { asked: number; opened: number };
	counts: { titles: string[]; buttonTitle: string };
	chinese: { titles: string[] };
	afterInfo: { opened: number; quit: number; paused: number; resumed: number };
	pauseResume: { paused: number; resumed: number; opened: number; quit: number };
	reopened: { policy: string; windows: number; window: boolean; icon: boolean; active: boolean; opened: number };
	quit: { quit: number; policy: string; icon: boolean };
	end: { policy: string; icon: boolean; active: boolean };
	always: { beside: boolean; afterLeave: boolean; offInBackground: boolean; end: boolean };
}

test.skipIf(!guiTests)(
	"in the background the app is an accessory with no window and a menu bar icon; the icon opens a regular app with a window again",
	async () => {
		const m = await run<ModeReport>("mode");
		// A regular app with its window.
		expect(m.front).toEqual({ policy: "regular", windows: 1, icon: false, active: false });
		// Run in Background: the window is closed (once the app counts as being in the background, so that closing the last
		// window cannot end it), the app is an accessory (no Dock icon, not in ⌘-Tab or Stage Manager), no window object is
		// left (the window and the page that were on the screen are released, and the only windows the app has are the status
		// bar's), and the icon is there with the menu of nothing working. A second one changes nothing.
		expect(m.background).toMatchObject({
			policy: "accessory",
			windows: 0,
			window: true,
			page: true,
			windowReleased: true,
			pageReleased: true,
			icon: true,
			active: true,
			closing: 1,
			titles: ["Open omp-webui", "", "No conversations working", "", "Quit omp-webui"],
			buttonTitle: "",
		});
		expect(m.background.kinds.every((kind) => kind.startsWith("NSStatusBarWindow"))).toBe(true);
		expect(m.againClosing).toBe(1);
		// What the server says shows in the icon and, when the menu opens, in the menu.
		expect(m.counts).toEqual({
			titles: [
				"Open omp-webui",
				"",
				"2 conversations working",
				"1 conversation needs your input",
				"Pause All Conversations",
				"",
				"Quit omp-webui",
			],
			buttonTitle: " 1",
		});
		expect(m.chinese.titles).toEqual([
			"打开 omp-webui",
			"",
			"2 个对话正在工作",
			"1 个对话需要你的输入",
			"暂停所有对话",
			"",
			"退出 omp-webui",
		]);
		// Open questions and finished runs (#705). The icon counts the dialogs and the questions together; the menu says how many
		// questions wait (a line that opens the Questions page) and how many runs finished since the person looked. A server's
		// first count is what the person has seen already; the next is news, with a ✓ on the icon, until the menu opens or the
		// app becomes the active one. The menu that is open goes on saying what it said, and a new epoch starts over.
		const waiting = ["Open omp-webui", "", "1 conversation needs your input", "2 questions waiting"];
		const tail = ["Pause All Conversations", "", "Quit omp-webui"];
		expect(m.attention.first).toEqual({ titles: [...waiting, ...tail], buttonTitle: " 3" });
		expect(m.attention.ran).toEqual({ titles: [...waiting, "2 conversations finished", ...tail], buttonTitle: " 3 ✓" });
		expect(m.attention.looked).toEqual({
			titles: [...waiting, "2 conversations finished", ...tail],
			buttonTitle: " 3",
		});
		expect(m.attention.whileOpen).toEqual(m.attention.looked);
		expect(m.attention.closed).toEqual(m.attention.first);
		expect(m.attention.one).toEqual({ titles: [...waiting, "1 conversation finished", ...tail], buttonTitle: " 3 ✓" });
		expect(m.attention.active).toEqual(m.attention.first);
		expect(m.attention.epoch).toEqual({
			titles: ["Open omp-webui", "", "No conversations working", "", "Quit omp-webui"],
			buttonTitle: "",
		});
		expect(m.attention.chineseFinished).toEqual({
			titles: ["打开 omp-webui", "", "没有正在工作的对话", "1 个问题等待回答", "2 个对话已完成", "", "退出 omp-webui"],
			buttonTitle: " 1",
		});
		// A click on the questions line is the app's (it opens the window on the Questions page), and does nothing else.
		expect(m.attention.asked).toBe(1);
		expect(m.attention.opened).toBe(0);
		// A line that only says something does nothing; Pause all and Resume all are the app's (the server's routes), and
		// neither opens the window nor quits; Open is the app's own way of showing its window.
		expect(m.afterInfo).toEqual({ opened: 0, quit: 0, paused: 0, resumed: 0 });
		expect(m.pauseResume).toEqual({ paused: 1, resumed: 1, opened: 0, quit: 0 });
		expect(m.reopened).toEqual({ policy: "regular", windows: 1, window: true, icon: false, active: false, opened: 1 });
		// Quit is the app's quit, not a termination of its own.
		expect(m.quit).toEqual({ quit: 1, policy: "accessory", icon: true });
		expect(m.end).toEqual({ policy: "regular", icon: false, active: false });
		// "Always show the menu bar icon": beside the window, kept when the app comes back from the background, never taken
		// away while the app is in the background, and gone once it is off and the app has its window again.
		expect(m.always).toEqual({ beside: true, afterLeave: true, offInBackground: true, end: false });
	},
	120_000,
);

interface MemoryReport {
	remembered: boolean;
	hash: string | null;
	hashAgain: string | null;
	restored: boolean;
	notOver: string | null;
	sentStaysSent: string | null;
	sentStaysSentAgain: string | null;
	once: string | null;
	noPage: boolean;
	emptyHash: string | null;
	emptyDrafts: string | null;
	routedClosed: string | null;
	routedClosedAgain: string | null;
	routedOpen: string | null;
	parsed: unknown[];
	urls: string[];
}

test.skipIf(!aqua)(
	"the page's unsent drafts and the view it was on outlive the window that is closed, and come back once, as the page left them",
	async () => {
		// A page on a real origin: session storage needs one.
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () =>
				new Response("<!doctype html><title>probe</title><p>page</p>", { headers: { "content-type": "text/html" } }),
		});
		try {
			const m = await run<MemoryReport>("memory", `http://127.0.0.1:${server.port}/`);
			// What the page held was read before its window went, and the view is handed over once.
			expect(m.remembered).toBe(true);
			expect(m.hash).toBe("#/s/%2Ftmp%2Fa%20b.jsonl");
			expect(m.hashAgain).toBeNull();
			// The new page found its drafts in its session storage, exactly (quotes, a line break, 日本語, a closing script tag).
			expect(m.restored).toBe(true);
			// What a page wrote itself is not written over when it reloads; nothing is given to a window after that one.
			expect(m.notOver).toBe("mine");
			// A page that sent its draft (removed the key) and loads again is not given it back, however often it loads.
			expect(m.sentStaysSent).toBeNull();
			expect(m.sentStaysSentAgain).toBeNull();
			expect(m.once).toBeNull();
			// A window with no page answers at once; a page with nothing to keep leaves nothing.
			expect(m.noPage).toBe(true);
			expect(m.emptyHash).toBeNull();
			expect(m.emptyDrafts).toBeNull();
			// The menu bar icon's questions line (#705): a window that is closed opens its next page on the Questions page, once;
			// a page that is up goes there.
			expect(m.routedClosed).toBe("#/questions");
			expect(m.routedClosedAgain).toBeNull();
			expect(m.routedOpen).toBe("#/questions");
			// A page's answer is looked at before it is trusted: only an in-page address with no spaces or control characters, of
			// a length that fits, and drafts that are not empty.
			expect(m.parsed).toEqual([
				["d", "#/s/x"],
				[null, null],
				[null, null],
				[null, null],
				[null, null],
				[null, null],
				[null, null],
				"nil",
				"nil",
			]);
			expect(m.urls).toEqual(["http://127.0.0.1:7878/?token=t#/s/x", "http://127.0.0.1:7878/?token=t"]);
		} finally {
			await server.stop(true);
		}
	},
	60_000,
);
