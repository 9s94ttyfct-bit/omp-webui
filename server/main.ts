// `omp-webui-server --ompw-relay …` is a relay (see omp/relay.ts), not a server: it never gets past this import.
import "./omp/relay-main.ts";
import { closeSync, existsSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import pkg from "../package.json";
import { isApprovalMode } from "../shared/approval.ts";
import { factsOf, noticeLang, working } from "../shared/attention.ts";
import { CI_SCOPES } from "../shared/ci.ts";
import { compactAtOf } from "../shared/compact-at.ts";
import { type ErrorInfo, errorInfoOf } from "../shared/error-info.ts";
import { ISSUE_FILTERS } from "../shared/github.ts";
import {
	applyGuardOverridePatch,
	FOLLOW_GLOBAL_GUARD,
	GUARD_BYS,
	GUARD_OUTCOMES,
	type GuardConfig,
	GuardConfigError,
	parseGuardOverridePatch,
	reviewerSelectors,
} from "../shared/guard.ts";
import { GUARD_DEFAULTS } from "../shared/guard-policy.ts";
import { isRecord } from "../shared/guards.ts";
import {
	GUIDANCE_MAX,
	guidanceProblemText,
	parseSessionGuidance,
	type SessionGuidance,
} from "../shared/model-guidance.ts";
import { isMode } from "../shared/offline.ts";
import { PREF, type PrefsSnapshot } from "../shared/prefs.ts";
import { type ClientMessage, type LiveAttached, MAX_WS_MESSAGE_BYTES, type ServerMessage } from "../shared/protocol.ts";
import { PUSH_API } from "../shared/push.ts";
import { REMOTE_SHELL_OFF } from "../shared/remote.ts";
import { replyMessages } from "../shared/reply-parts.ts";
import { slimAnswer } from "../shared/slim.ts";
import { answerMessage, cleanAnswer, instructionProblemText } from "../shared/unattended.ts";
import type { UploadFailure } from "../shared/upload.ts";
import { DEFAULT_USAGE_RANGE, isUsageRange } from "../shared/usage-range.ts";
import { Auth } from "./auth.ts";
import { compressResponse, serveStatic } from "./compress.ts";
import { loadConfig } from "./config.ts";
import { guardAgainstStrayErrors } from "./crash-guard.ts";
import { contentSecurityPolicy, indexScriptHashes } from "./csp.ts";
import { FamilyCache } from "./family.ts";
import { osDescription, osUser, RepoVisibility } from "./feedback.ts";
import { LazyFolder } from "./folder-lazy.ts";
import type { GhIssues } from "./gh-issues.ts";
import type { GhRuns } from "./gh-runs.ts";
import { LazyGit } from "./git-lazy.ts";
import { GuardLog, GuardSettings } from "./guard.ts";
import { BenchBusy, defaultPlaces, GuardBench } from "./guard-bench.ts";
import { ompReviewer } from "./guard-reviewer.ts";
import { parseViewRequest } from "./history-request.ts";
import { HostSampler, MIN_BACKGROUND_MS, MIN_LIVE_MS, paceFrom } from "./host.ts";
import { systemReader } from "./host-read.ts";
import {
	apiPorts,
	forgetServer,
	knownDataDirs,
	recordServer,
	runningServerPorts,
	stopStaleServer,
} from "./instance.ts";
import { FINISH_WAIT_MS, heldByImport, type Live, LivePool, type Subscriber, stopKindOf } from "./live.ts";
import { boundHosts, listenOnLoopback, loopbackRequiredByApp, needsLoopbackListener } from "./loopback-listener.ts";
import type { MemoryService } from "./memory/routes.ts";
import type { MigrateService } from "./migrate/service.ts";
import { sweepMigrateDir } from "./migrate/sweep.ts";
import { createModeApi, ModeService } from "./offline/index.ts";
import { ApprovalStore, sessionKey } from "./omp/approval.ts";
import { BtwForks, sweepForkDir } from "./omp/btw-fork.ts";
import { cliHelp, cliInventory, ompVersion, resetCliInventory } from "./omp/cli.ts";
import { configureCompactAt, readCompactDefaults } from "./omp/compact-at.ts";
import { CompactStepService } from "./omp/compact-step/service.ts";
import { ConfigRead } from "./omp/config-read.ts";
import { watchOmpConfig } from "./omp/config-watch.ts";
import { DocsToolService } from "./omp/docs-tool/install.ts";
import { gatePaths, installGate } from "./omp/gate/install.ts";
import { GATE_HANDLER_MS } from "./omp/gate/state.ts";
import type { GuidanceConflictCheck } from "./omp/guidance/conflict-check.ts";
import { liveGuidanceOf } from "./omp/guidance/hooks.ts";
import { GuidanceService } from "./omp/guidance/service.ts";
import { GuidanceStoreError } from "./omp/guidance/store.ts";
import { OmpLifecycle } from "./omp/lifecycle.ts";
import { collectLoaded } from "./omp/loaded.ts";
import { importLoginEnv } from "./omp/login-env.ts";
import { handleModelConfig } from "./omp/model-config.ts";
import { availableModels } from "./omp/models.ts";
import { writeOverlay } from "./omp/overlay.ts";
import { QuotaFloorService } from "./omp/quota-floor/service.ts";
import { FloorError } from "./omp/quota-floor/store.ts";
import { resumedSessions } from "./omp/resumed.ts";
import { QuestionError } from "./omp/unattended/questions.ts";
import { UnattendedService } from "./omp/unattended/service.ts";
import { InstructionError } from "./omp/unattended/store.ts";
import { PrefsError, UiPrefs } from "./prefs.ts";
import { ProjectGroupError, ProjectGroupStore } from "./project-groups.ts";
import { PtyManager, runsOmpShell, terminalDir } from "./pty.ts";
import type { PushHub } from "./push/hub.ts";
import type { RemoteIdentity } from "./remote-auth.ts";
import { remotePingMs } from "./remote-keepalive.ts";
import { LazyRemote } from "./remote-lazy.ts";
import { SavedMacs, savedMacsPath } from "./saved-macs.ts";
import {
	ListPref,
	SessionActions,
	SessionBusyError,
	SessionOpenElsewhereError,
	type SessionTarget,
} from "./sessions/actions.ts";
import { SessionPins } from "./sessions/pins.ts";
import { SessionRoots } from "./sessions/roots.ts";
import { SessionStore } from "./sessions/store.ts";
import { SettingsCatalog } from "./settings-help/catalog.ts";
import { handleSettingsHelp } from "./settings-help/routes.ts";
import { SettingsHelp } from "./settings-help/service.ts";
import { NOTIFY_EVENTS_PATH, SHELL_EVENTS_PATH, ShellEvents } from "./shell-events.ts";
import { caffeinateBin, KeepAwake, SleepDetector, spawnCaffeinate, workingIds } from "./sleep.ts";
import { isLocalOnlyRoute, isThisComputer } from "./this-computer.ts";
import type { TransferEnv } from "./transfer-core.ts";
import type { AppUpdater, Conversations } from "./update/service.ts";
import { WorkerDeadlineError } from "./worker-deadline.ts";
import { WsOutbox } from "./ws-out.ts";

/**
 * The commands that carry a message to a conversation's agent, or start its work: whoever sends one drives its turn (see
 * `Live.noteOrigin`). `goal` is one only as `create` and `resume` (a goal's turns run on by themselves), see `drivesTurn`.
 */
const DRIVING: Record<string, true> = {
	prompt: true,
	steer: true,
	follow_up: true,
	abort_and_prompt: true,
	steer_subagent: true,
};
const GOAL_DRIVING: Record<string, true> = { create: true, resume: true };

function drivesTurn(command: { type?: unknown; op?: unknown }): boolean {
	if (typeof command.type !== "string") return false;
	if (command.type === "goal") return typeof command.op === "string" && Object.hasOwn(GOAL_DRIVING, command.op);
	return Object.hasOwn(DRIVING, command.type);
}

/**
 * Why a message from a page may not start or steer this conversation's turn, or null when it may. `remote`: the page came in
 * through the tunnel or over the network, and then "Confirm risky commands from remote pages" asks about its risky calls; a
 * page on this computer takes the turn back (see `Live.noteOrigin`). The one rule for every message a page sends, the
 * composer's and an answer to a question of unattended mode (#646) alike: a message is a message.
 *
 * The guard is the gate's, which only a process that started with it has. One this server started without it (its own flags
 * rule the check out, or the check could not start) is not given a turn at all, for what it would run cannot be looked at.
 * One this server took over (`inherited`: it was started before, by an older version or by a server that is gone) is not
 * refused: that would strand every paused or waiting conversation after an update, and its turn would run unguarded
 * anyway; its page says so (`LiveInfo.ungated`).
 */
function turnRefusal(live: Live, remote: boolean): string | null {
	if ((live.effectiveGuard()?.config ?? guardSettings.get()).mode !== "off" && live.ungated === "chosen")
		return "Guard dangerous commands is on for this conversation (Settings › Safety, or This session), but its omp started without the check that does it (its own flags rule the check out, or the check could not start). Open it again, and it will be covered, or turn the guard off in Settings › Safety (or in This session, for this conversation alone).";
	// Asking is the gate's, which only a process that started with it has: another is not given a remote page's turn.
	if (remote && remoteAuth.confirmRisky() && !live.gated)
		return "Confirm risky commands from remote pages is on, but this conversation's omp started without the check that does it (it was already running before this version, its own flags rule the check out, or the check could not start). Continue it on this computer, or open it again there, and it will be covered.";
	// A word the gate may not have is not one a remote page's turn starts with.
	if (!live.noteOrigin(remote) && remote)
		return "Confirm risky commands from remote pages could not be told to this conversation's omp, so the message was not sent. Try again, or continue on this computer.";
	return null;
}

const SERVER_VERSION = pkg.version;
// The macOS app names the user's login shell: its environment (`PATH` first) is what omp and its tools run in, as
// they do in a terminal; a Finder launch has none of it. A shell that does not answer in time leaves the server's own.
const loginShell = process.env.OMP_WEBUI_LOGIN_SHELL || null;
if (loginShell && !(await importLoginEnv(loginShell)))
	console.warn("omp-webui: the login shell did not answer; PATH is the app's");
const cfg = loadConfig();

// The pages' sockets and what is said to all of them come before the lifecycle: `omp.init()` takes over an install or
// update that ended while no server ran, and announcing how it ended reaches `broadcastAll` before anything below it
// exists (a `const` below `await omp.init()` is not initialized yet, and the server ended with a ReferenceError, again
// at every later start: #310).
interface WsData {
	sub: Subscriber;
	attached: Set<string>;
	/** What is sent to this page, in order and never dropped (see `WsOutbox`); set when the socket opens. */
	out: WsOutbox | null;
	/** Set by the close handler; an `open` that finishes afterwards must not subscribe the dead socket. */
	closed: boolean;
	/** Who the page is, when it came in through the public hostname (see `RemoteAuth`); null for any other. */
	remote: RemoteIdentity | null;
	/**
	 * Whether the page is on this computer (see `isThisComputer`): its socket is a loopback one and nothing a proxy adds is
	 * on it. A page that is not (the tunnel's, or one on the network the server listens on) is treated as a remote page
	 * wherever the conversations are concerned, and is told nothing that is for the person at this computer.
	 */
	local: boolean;
	/** Ends a remote page's socket when its Access token expires (see `watchAccess`). */
	expiry: NodeJS.Timeout | undefined;
	/** Pings a remote page's socket so that Cloudflare's idle limit does not cut it (see `remote-keepalive.ts`). */
	ping: NodeJS.Timeout | undefined;
}

const sockets = new Set<Bun.ServerWebSocket<WsData>>();
const broadcastAll = (msg: ServerMessage) => {
	const text = JSON.stringify(msg);
	for (const ws of sockets) ws.data.out?.send(text);
};

// omp may be missing, or installed while this runs: the lifecycle finds it, installs it, keeps it up to date.
// What holds its location (`approval`, `pool`, `ptys`) is declared below and told through `activate`.
const omp = new OmpLifecycle(
	cfg,
	{
		busy() {
			const held = { working: 0, asking: 0, paused: 0 };
			for (const l of pool.list()) if (!l.exited && l.holding) held[l.holding]++;
			return held;
		},
		async activate(bin) {
			approval.setBin(bin);
			ptys.setBin(bin);
			pool.setOverlay(await writeOverlay(bin, cfg.dataDir).catch(() => null));
			resetCliInventory();
			version = await ompVersion(bin).catch(() => "unknown");
			return version;
		},
		broadcast: (msg) => broadcastAll(msg),
	},
	{
		// `OMP_WEBUI_UPDATE_CHECK=off`: no look-ups for a newer omp on their own (Settings can still ask).
		checkEnabled: process.env.OMP_WEBUI_UPDATE_CHECK !== "off",
		checkIntervalMs: Number(process.env.OMP_WEBUI_UPDATE_INTERVAL_MS) || undefined,
		// "Look again" on the first-run screen: a shell file edited since the app started may now put omp on `PATH`.
		refreshEnv: loginShell ? async () => void (await importLoginEnv(loginShell)) : undefined,
	},
);
await omp.init();
// The folders a conversation keeps its transcript in besides omp's own agent directory: the ones the server has
// started omp with `--session-dir` or `--profile`. They are read like the sessions directory, so that those
// conversations are listed, searched and reopened here too.
const sessionRoots = new SessionRoots(cfg.dataDir, homedir(), cfg.agentDir);
const store = new SessionStore(cfg.sessionsDir, join(cfg.dataDir, "index.db"), {}, () => sessionRoots.folders());
const families = new FamilyCache(store);
// Light on a local server resumes a session on a model of its backend whenever the one it recorded is not.
const modes = new ModeService(cfg, async (file) => (await store.get(file))?.models ?? null);
const approval = new ApprovalStore(cfg.ompBin, cfg.dataDir);
// omp's own `retry.waitForUsageReset` is asked for by every page that shows it, and again by each conversation's quota
// popover, on every reconnect: one `omp config get` per state of its config file answers them all (#365).
const ownUsageWait = new ConfigRead(join(cfg.agentDir, "config.yml"), () => approval.configuredUsageWait());
// Likewise omp's own compaction point, which the session panel and Settings show as what "Default" means (#643).
const ownCompactAt = new ConfigRead(join(cfg.agentDir, "config.yml"), () => readCompactDefaults(cfg));
// A migration's uploads and finished exports are for the server that made them: what a crash left is removed.
sweepMigrateDir(cfg.dataDir);
// The copies of conversations a server that was killed left for the side questions it was answering are of no use any more.
sweepForkDir(cfg.dataDir);
/** An import (or its restore) is writing the files conversations run on: none is opened until it has finished. */
let importWriting = false;
const pool = new LivePool(
	cfg,
	omp.ready ? await writeOverlay(cfg.ompBin, cfg.dataDir).catch(() => null) : null,
	modes,
	approval,
	FINISH_WAIT_MS,
	// A conversation started with `--session-dir` or `--profile` keeps its transcript in another folder: the folder
	// is remembered, so that the conversation is listed, searched and reopened like the others.
	(args, cwd) => {
		sessionRoots.note(args, cwd);
	},
	// A conversation in one of those folders is resumed the way it was started: with its own profile, or with the
	// directory it is kept in.
	(file) => sessionRoots.flagsFor(file),
);
pool.setHold(() => importWriting);
// "Confirm risky commands from remote pages" (Settings › Remote access): every conversation's omp starts with the gate,
// an extension that waits for this server's word (`Live.syncRisk`) before it asks about anything. Its files are put in
// place before each process is started (`ensure`), so ones deleted or damaged since are written again; a process whose
// gate could not be put in place starts without it, and `Live.gated` says so: a remote page is refused while the setting is on.
// A reviewer model is asked inside the time omp gives the gate's handler: the overlays of the processes started from now on give it more.
approval.handlerMs = GATE_HANDLER_MS;
const guardSettings = new GuardSettings(cfg.dataDir);
const guardLog = new GuardLog(cfg.dataDir);
/** The guard's reviewer as the server reaches it (`omp -p`): the benchmark asks it, and so does the guidance conflict check. */
const reviewerSource = ompReviewer(cfg.ompBin);
/**
 * The benchmark of the guard (Guard page › Benchmark): the shipped and the person's own cases, judged by the settings as they
 * are now. It runs nothing; the reviewer, when the person asks for it, is asked through `omp -p` (`guard-reviewer.ts`).
 */
const guardBench = new GuardBench({
	config: () => guardSettings.get(),
	rules: () => guardSettings.rules(),
	places: () =>
		defaultPlaces(
			pool.gate?.protect ?? [cfg.dataDir, cfg.agentDir],
			gateApiPorts(),
			gateHosts.length > 0 ? gateHosts : undefined,
		),
	reviewer: reviewerSource,
});
const DEV_PORT = Number(process.env.OMP_WEBUI_DEV_PORT) || null;
/** The address of a network this server is bound to (`OMP_WEBUI_HOST`), as its gates should treat it (see `boundHosts`). */
const gateHosts = boundHosts(cfg.host);
let gatePorts: { at: number; ports: number[] } = { at: 0, ports: [] };
/** What the gates are told of the ports of an omp-webui API (read once a second: the other servers' records are files). */
function gateApiPorts(): number[] | undefined {
	// Not bound yet: not known, and every loopback /api/ asks.
	if (!remotePort) return undefined;
	const now = Date.now();
	if (now - gatePorts.at > 1000 || !gatePorts.ports.includes(remotePort))
		gatePorts = {
			at: now,
			ports: apiPorts(remotePort, cfg.port, DEV_PORT, [
				...runningServerPorts(knownDataDirs()),
				...(loopbackPort ? [loopbackPort] : []),
			]),
		};
	return gatePorts.ports;
}
pool.gate = {
	extension: gatePaths(cfg.dataDir).extension,
	// The data folders of other omp-webui instances hold their sign-in tokens too.
	protect: [...new Set([cfg.dataDir, cfg.agentDir, ...knownDataDirs()])],
	confirm: () => remoteAuth.confirmRisky(),
	// Only an omp-webui's API is protected, not any loopback `/api/`: this server's port once it has bound, and the ports
	// another one may serve on (see `apiPorts`).
	ports: gateApiPorts,
	// And the address of a network the server was bound to (`OMP_WEBUI_HOST`): `/api/` there is this same server's API.
	hosts: () => (gateHosts.length > 0 ? gateHosts : undefined),
	// "Guard dangerous commands" (Settings › Safety): each conversation's gate is told what it says (`Live.guardWord`). The macOS
	// app in the background is somebody to ask when no page is open: it tells the person of the question (`ShellEvents.reaches`).
	guard: {
		config: () => guardSettings.get(),
		rules: () => guardSettings.rules(),
		log: guardLog.file,
		own: [cfg.dataDir],
		reachable: () => shellEvents.reaches(),
	},
	ensure: () => {
		try {
			installGate(cfg.dataDir);
			return true;
		} catch (e) {
			console.warn(`omp-webui: could not set up the gate for risky commands: ${(e as Error).message}`);
			return false;
		}
	},
};
pool.gate.ensure();
// Model guidance (#641): a conversation's main agent can be given standing instructions on how to use models for subagents.
// It reaches omp as a small extension of the server's own (`server/omp/guidance/extension.ts`) that appends the text to the
// main agent's system prompt at each turn; the text is a file of the conversation's, so a change reaches its next turn
// without a restart. The templates the person saves are `<data dir>/model-guidance.json` (they travel with Move to another
// computer), and what each conversation was given is `model-guidance-sessions.json`. The extension is started with every
// process (`LivePool.launchArgs`): a conversation with no guidance has no file, and the handler adds nothing.
const modelGuidance = new GuidanceService(cfg.dataDir);
pool.guidance = modelGuidance;
// Unattended mode (#646): the person goes away, and what needs them is filed as a question instead of blocking the turn. It
// reaches omp as a small extension of the server's own (`server/omp/unattended/extension.ts`, the model guidance's sibling)
// that tells the main agent to file what needs a decision (the tool `file_question`) and to go on with the rest; omp's own
// `ask` dialogs of such a conversation are answered by the server and filed. The questions are `<data dir>/questions.json`,
// what the person set (the instruction, and which conversations are unattended) is `unattended.json`; both travel with Move
// to another computer.
const unattendedMode = new UnattendedService(cfg.dataDir);
pool.unattended = unattendedMode;
unattendedMode.questions.onChange((counts) => broadcastAll({ t: "questions", counts }));
// The quota floor (#652): the person sets, for a provider, the share of a usage window that may be left before the work in
// progress is held; the conversation waits (it is not frozen) after the model request in flight completes, until the window
// resets (`server/omp/quota-floor/`). It reaches omp as an extension of the server's own, the unattended mode's sibling. The
// floors are `<data dir>/quota-floor.json`; they travel with Move to another computer.
// The look at the provider's usage is the one every page's quota pill shares (`omp/usage.ts`, loaded on first use).
const quotaFloor = new QuotaFloorService(cfg.dataDir, async (provider, force) =>
	(await import("./omp/usage.ts")).providerUsage(cfg.ompBin, provider, force),
);
pool.quotaFloor = quotaFloor;
// Compact between two steps (#651): the extension that holds a step boundary while a queued compact waits for one
// (`server/omp/compact-step/`), a sibling of the quota floor's. Nothing of it is the person's to set but the place a compact runs.
pool.compactStep = new CompactStepService(cfg.dataDir);
// The `webui_docs` tool: a read-only extension of the server's own (`server/omp/docs-tool/`) that lets an agent list, search
// and read omp-webui's agent-facing documentation (`docs/agents/`, compiled into the server), so that a question about the app
// is answered from its docs. Nothing of it is the person's to set.
pool.docsTool = new DocsToolService(cfg.dataDir);
/** The questions being answered now: an answer is sent once, whichever page sent it (two pages cannot both answer one). */
const answering = new Set<string>();
const actions = new SessionActions(cfg, pool, undefined, (file) => sessionRoots.flagsFor(file));
const pins = new SessionPins(cfg.agentDir, cfg.dataDir, store, actions);
const favoriteModels = new ListPref(cfg.dataDir, "favorite-models");
const archived = new ListPref(cfg.dataDir, "archived");
// The sidebar's project groups (#636) are the person's, not one page's: a change is said to every page.
const projectGroups = new ProjectGroupStore(cfg.dataDir, () => broadcastAll({ t: "project_groups" }));
const uiPrefs = new UiPrefs(cfg.dataDir);
// The other Macs this one knows (#628): pages read the list in `/api/meta`, only a page on this computer changes it.
const savedMacs = new SavedMacs(savedMacsPath(cfg.dataDir), () => broadcastAll({ t: "macs_changed" }));
// Side questions (the Ask tab) on the model the person chose for them (`ompw.btwModel`): the server answers those in a process of its own.
const sideQuestions = new BtwForks({
	bin: () => cfg.ompBin,
	dataDir: cfg.dataDir,
	choice: () => uiPrefs.snapshot().values[PREF.btwModel],
	refusal: () => (importWriting ? heldByImport() : null),
});
// Automatic titles (Settings › Conversations): omp makes none in RPC mode, so the server asks for one after a conversation's first
// exchange (`AutoTitle`), with or without a page open. `OMP_WEBUI_AUTO_TITLE=off` stops it whatever Settings says (tests).
pool.autoTitle = () =>
	process.env.OMP_WEBUI_AUTO_TITLE !== "off" && uiPrefs.snapshot().values[PREF.autoTitle] !== "off";
const git = new LazyGit();
/** The Issues tab's reader of GitHub issues (#653), loaded by its first use; one that failed to load is tried again by the next. */
let ghIssues: Promise<GhIssues> | null = null;
const issuesReader = (): Promise<GhIssues> =>
	(ghIssues ??= import("./gh-issues.ts").then(
		(m) => new m.GhIssues(),
		(error: unknown) => {
			ghIssues = null;
			throw error;
		},
	));
/** The CI tab's reader of GitHub Actions runs, likewise; one for the server, so every page shares its looks. */
let ghRuns: Promise<GhRuns> | null = null;
const runsReader = (): Promise<GhRuns> =>
	(ghRuns ??= import("./gh-runs.ts").then(
		(m) => new m.GhRuns(),
		(error: unknown) => {
			ghRuns = null;
			throw error;
		},
	));
const folder = new LazyFolder(() => ({ logFile: join(cfg.dataDir, "transfers.jsonl") }));
/** The requests of a page on this computer that no tunnel carried (see `isThisComputer`), noted as they come in. */
const onThisComputer = new WeakSet<Request>();
const repoVisibility = new RepoVisibility(process.env.OMP_WEBUI_GITHUB_API);
const auth = new Auth(cfg.dataDir);
// The port the server listens on is known only once it has bound one; the tunnel carries requests to it.
let remotePort = 0;
/** The port of the loopback listener of a server bound to a network address (`0`: it has none); the gates ask about it too. */
let loopbackPort = 0;
/**
 * The conversations a page that came in through the tunnel has touched (attached to, or sent anything to, answers of
 * omp's approval prompts included), by live id. The AI help's tools are refused on them (see `RemoteAi.refusal`) even after
 * that page has gone: a page could answer omp's approval prompt of a tool call and leave, and the call arrives afterwards.
 * It is lifted by a page on this Mac sending the conversation a message, and ends with the process.
 */
const remoteTouched = new Set<string>();
const remoteAuth = new LazyRemote(
	cfg.dataDir,
	broadcastAll,
	cfg.host,
	() => remotePort,
	{
		// "Set up with AI" (Settings › Remote access): a conversation whose tools this server answers (see `RemoteAi`).
		open: async (server, cwd) => (await pool.openServing(cwd, server)).attached(),
		withdraw: (liveId) => pool.get(liveId)?.serveHostTools(null) ?? Promise.resolve(),
		// A remote page on the conversation could answer omp's approval prompts itself: its tools are refused while one is.
		heldRemotely: (liveId) =>
			remoteTouched.has(liveId) || [...sockets].some((ws) => !ws.data.local && ws.data.attached.has(liveId)),
	},
	// Shells for remote pages turned off: the ones they have open end now, not when their pages next close.
	(config) => {
		if (!config.remoteShell) ptys.killRemoteShells();
	},
);
const ptys = new PtyManager(cfg.ompBin);
/**
 * The load of this computer (#613): looked at every few seconds while a page shows the graphs of it and every ten while
 * only the sidebar's line does (or no page at all), so that the history reaches back to when nobody watched. The paces are
 * overridden only by tests (`OMP_WEBUI_HOST_*_MS`).
 */
const host = new HostSampler({
	liveMs: paceFrom(process.env.OMP_WEBUI_HOST_LIVE_MS, 2000, MIN_LIVE_MS),
	backgroundMs: paceFrom(process.env.OMP_WEBUI_HOST_BACKGROUND_MS, 10_000, MIN_BACKGROUND_MS),
	pids: () => pool.pids(),
	// The GPU is looked at through IOKit, in a thread of its own (a driver can hang or fault in it): `OMP_WEBUI_HOST_GPU=0` leaves it out, `1` tries it again
	// after a start that did not get through its first look at it (see `guardedGpu`).
	reader: systemReader({
		gpu: {
			enabled: process.env.OMP_WEBUI_HOST_GPU !== "0",
			retry: process.env.OMP_WEBUI_HOST_GPU === "1",
			markerDir: cfg.dataDir,
		},
	}),
});
let version = omp.ompVersion ?? "unknown";

// ------------------------------------------------------------------ the app's own updates (#571)

// Set by the macOS shell: the app bundle this server belongs to. A server started any other way cannot replace an app.
const appBundle = process.env.OMP_WEBUI_APP_BUNDLE || null;
const appUpdateApi = process.env.OMP_WEBUI_APP_UPDATE_API || undefined;
// Looking for a release on its own follows `OMP_WEBUI_UPDATE_CHECK=off` (as the look for a newer omp does), unless a test
// names a releases server of its own: that one is meant to be looked at.
const automaticAppUpdates = process.env.OMP_WEBUI_UPDATE_CHECK !== "off" || appUpdateApi !== undefined;
let updater: AppUpdater | null = null;
let loadingUpdater: Promise<AppUpdater> | null = null;

/** What is said to the pages on this computer (any other has no use for the update, and is refused it and the guard). */
function broadcastLocal(msg: ServerMessage): void {
	const text = JSON.stringify(msg);
	for (const ws of sockets) if (ws.data.local) ws.data.out?.send(text);
}

/** The conversations an update would stop (working, asking) or leave in the background (paused, waiting for a usage limit). */
function conversationsHeld(): Conversations {
	const held: Conversations = { working: 0, asking: 0, paused: 0, waiting: 0 };
	for (const l of pool.list()) {
		if (l.exited) continue;
		if (l.pausedAt !== null) held.paused++;
		else if (l.retry?.usageLimit === true && l.retry.resumed === false) held.waiting++;
		// Held at the quota floor (#652): omp waits in a dialog until the window resets, and the conversation stays across a quit.
		else if (l.quotaHold?.state === "held") held.waiting++;
		else if (l.holding === "asking") held.asking++;
		else if (l.busy) held.working++;
	}
	return held;
}

/** The updater, made on first use: nothing of it is loaded while nobody asks and no timer is due. */
function appUpdater(): Promise<AppUpdater> {
	loadingUpdater ??= import("./update/service.ts")
		.then(({ AppUpdater }) => {
			updater = new AppUpdater({
				dataDir: cfg.dataDir,
				installed: SERVER_VERSION,
				bundle: appBundle,
				parentPid: cfg.parentPid,
				api: appUpdateApi,
				automatic: automaticAppUpdates,
				autoChecks: () => uiPrefs.snapshot().values[PREF.appUpdateCheck] !== "off",
				conversations: conversationsHeld,
				broadcast: (state) => broadcastLocal({ t: "app_update", state }),
			});
			return updater;
		})
		.catch((e: unknown) => {
			loadingUpdater = null;
			throw e;
		});
	return loadingUpdater;
}

/**
 * Sleep (#647): the Mac is kept from going to *idle* sleep while a conversation works, and a sleep it did go through is
 * noticed and said in the transcripts of the conversations it interrupted.
 *
 * - `keepAwake` runs `/usr/bin/caffeinate -i -w <this server's pid>` for as long as `workCounts(...).working` is above
 *   zero: the same count the macOS app's menu bar icon and the shell events show, so the two never disagree on whether
 *   anything is working. The setting (`ompw.keepAwake`) turns it off; a machine that is not a Mac has no `caffeinate`, and
 *   `/api/meta` says so.
 * - `sleepDetector` reads its clocks once a second and reports a gap of the wall clock that the monotonic one did not
 *   count (see `sleepBetween` in `server/sleep.ts` for why `performance.now` and not `hrtime`), with the conversations
 *   that were working when the machine went away.
 */
const keepAwake = new KeepAwake({
	platform: process.platform,
	bin: caffeinateBin(),
	spawn: (argv) => spawnCaffeinate(argv, (message) => console.warn(`omp-webui: ${message}`)),
	pid: () => process.pid,
	report: (message) => console.warn(`omp-webui: ${message}`),
});
const sleepDetector = new SleepDetector({
	// Three clocks (`sleepBetween` in `server/sleep.ts`): the wall clock, one that stops across a sleep (`performance.now`),
	// and one that counts through it (`hrtime`, `mach_continuous_time`) — which is what tells a sleep from a moved clock.
	read: () => ({ wall: Date.now(), mono: performance.now(), continuous: Number(process.hrtime.bigint() / 1_000_000n) }),
	working: () => workingIds(pool.list()),
	woke: ({ from, to, working }) => {
		const told = pool.noteSleep(from, to, working);
		console.log(
			`omp-webui: the Mac slept for ${Math.round((to - from) / 60_000)} min; ${told} conversation(s) were interrupted`,
		);
	},
});
/** The setting as it stands: applied to the keeper when it is changed in Settings, and at start. */
function applyKeepAwake(): void {
	keepAwake.setEnabled(uiPrefs.snapshot().values[PREF.keepAwake] !== "off");
}
applyKeepAwake();
sleepDetector.start();
/**
 * The working count, looked at as often as the shell events do and applied to `caffeinate`: a conversation that starts a
 * turn while no app is running is kept awake too, and a browser-only server is the same server.
 *
 * `workingIds`, not `workCounts`: a conversation waiting out a usage limit is counted as working by the menu bar (its turn
 * is open) and must not hold the Mac awake for hours (`awakeWorking` in `server/sleep.ts`).
 */
setInterval(() => {
	keepAwake.setCount(workingIds(pool.list()).length > 0);
}, 1000).unref();

/** What the macOS app is told on its own: its notifications and its menu bar icon (see `ShellEvents`). */
const shellEvents = new ShellEvents({
	lives: () => pool.list(),
	named: (file) => store.get(file),
	prefs: () => {
		const { values } = uiPrefs.snapshot();
		return { notify: values[PREF.notify] === "on", lang: values[PREF.lang], menuIcon: values[PREF.menuIcon] !== "off" };
	},
	questions: () => unattendedMode.questions.counts().open,
	// An app that came or went changes whether the guard has somebody to ask when no page is open (`GuardHooks.reachable`).
	changed: () => pool.syncRisk(),
});
// A question filed, answered or dismissed is a change of what the menu bar icon counts (it is not a change of any process),
// and of what the conversations that are unattended are told of their questions that still wait (#694).
unattendedMode.questions.onChange(() => {
	shellEvents.questionsChanged();
	pool.rewriteUnattended();
});
/**
 * Web Push (#629): the notification of a conversation that needs somebody, for a device whose page is closed. Loaded when a page
 * first asks about it (Settings) and at start when devices are subscribed already: a server that never used it does not carry it.
 */
let pushHub: PushHub | null = null;
let pushLoading: Promise<PushHub> | null = null;
function pushService(): Promise<PushHub> {
	pushLoading ??= import("./push/hub.ts")
		.then(async ({ openPushHub }) => {
			const hub = await openPushHub({
				dataDir: cfg.dataDir,
				lives: () => pool.list(),
				named: (file) => store.get(file),
				prefs: () => {
					const { values } = uiPrefs.snapshot();
					return { notify: values[PREF.notify] === "on", lang: values[PREF.lang] };
				},
				preview: (liveId, kind) => pool.get(liveId)?.previewText(kind) ?? null,
				remoteOn: () => remoteAuth.settings() !== null,
			});
			pushHub = hub;
			return hub;
		})
		.catch((e: unknown) => {
			pushLoading = null;
			throw e;
		});
	return pushLoading;
}
pool.onAnnounce((info) => {
	if (info.exited) remoteTouched.delete(info.liveId);
	broadcastAll({ t: "live", info });
	shellEvents.note(info);
	pushHub?.note(info);
});

/**
 * Change the synced preferences (`UiPrefs.apply`, which refuses a change whole) and, when anything changed, do what the
 * change means beyond the file: every open page shows it (the macOS window included), whether notifications are on is part
 * of whether the guard has somebody to ask (`ShellEvents.reaches`), "Keep the Mac awake while a conversation works" (#647)
 * takes effect now, and the macOS app shows its menu bar icon or not as Settings says. Settings' own cards and Ask agent
 * for help change them through this.
 */
function applyPrefs(changes: unknown): PrefsSnapshot {
	const before = uiPrefs.snapshot().rev;
	const snapshot = uiPrefs.apply(changes);
	if (snapshot.rev !== before) {
		broadcastAll({ t: "prefs", snapshot });
		pool.syncRisk();
		applyKeepAwake();
		shellEvents.prefsChanged();
	}
	return snapshot;
}

/** The guard's settings changed (Settings › Safety, or Ask agent for help): every gate and every page on this computer is told now. */
function guardChanged(config: GuardConfig): void {
	pool.syncRisk();
	broadcastLocal({ t: "guard_config", config });
}

/**
 * "Ask agent for help" (Settings): a conversation of its own, in `<data dir>/settings-help`, whose agent changes settings
 * with `webui_settings` (`server/settings-help/`) through the setters below, the ones Settings' cards use.
 */
const settingsHelp = new SettingsHelp(
	new SettingsCatalog({
		prefs: { values: () => uiPrefs.snapshot().values, apply: (changes) => void applyPrefs(changes) },
		guard: { get: () => guardSettings.get(), set: (patch) => guardChanged(guardSettings.set(patch)) },
		remote: { get: () => remoteAuth.config(), save: (patch) => remoteAuth.saveConfig(patch) },
		mode: {
			get: () => ({ mode: modes.mode, lightModels: modes.lightModels, offline: modes.offline }),
			update: (patch) => void modes.update(patch),
		},
		approval: { get: () => approval.defaultMode(), set: (mode) => approval.setDefault(mode) },
		unattended: {
			get: () => {
				const settings = unattendedMode.settings();
				return settings.custom ? settings.instruction : null;
			},
			set: (text) => {
				unattendedMode.setInstruction(text);
				// What a conversation that is unattended is told changes at its next turn.
				pool.rewriteUnattended();
			},
		},
	}),
	{ dataDir: cfg.dataDir, folder: join(cfg.dataDir, "settings-help") },
	{
		open: async (server, cwd) => (await pool.openServing(cwd, server)).attached(),
		heldRemotely: (liveId) =>
			remoteTouched.has(liveId) || [...sockets].some((ws) => !ws.data.local && ws.data.attached.has(liveId)),
		changed: (state) => broadcastLocal({ t: "settings_help", state }),
	},
	undefined,
	// Tests shorten the access to see it end (`OMP_WEBUI_SETTINGS_HELP_MS`); the service never lets it be longer than 30 minutes.
	Number(process.env.OMP_WEBUI_SETTINGS_HELP_MS) || undefined,
);
modes.onChange((state) => broadcastAll({ t: "mode_settings", state }));
store.onChange(() => broadcastAll({ t: "sessions_changed" }));
// A pin made in omp (`/pin`, in a conversation here or in a terminal) is the sidebar's too: the page reads the list again.
pins.onChange(() => broadcastAll({ t: "sessions_changed" }));
// Archiving a conversation and loving a model are the person's, not one page's: every page shows the list as it is now.
archived.onChange(() => broadcastAll({ t: "sessions_changed" }));
favoriteModels.onChange((models) => broadcastAll({ t: "favorite_models", models }));
void pins
	.adoptLegacy()
	.catch((e) =>
		console.warn(`omp-webui: pins kept before omp had its own list are not moved yet: ${(e as Error).message}`),
	);
watchOmpConfig(cfg.agentDir, () => {
	broadcastAll({ t: "model_config_changed" });
	// A role added or removed there must not reach a conversation that was switched to a preset.
	void pool.refreshModelRoles();
});

// ------------------------------------------------------------------ helpers

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json" },
	});
const fail = (error: string, status = 400, info?: ErrorInfo) => json({ error, ...info }, status);
const modeApi = createModeApi(modes, { json, fail });

/**
 * Moving to another computer (`server/migrate`): the archive code is loaded when somebody first asks for it, not at
 * start (zip, encryption and the importer are most of a megabyte of code that runs a few times in a person's life).
 */
let migrating: Promise<MigrateService> | null = null;
function migrateService(): Promise<MigrateService> {
	migrating ??= (async () => {
		const { MigrateService } = await import("./migrate/service.ts");
		const { leaseHolders } = await import("./sessions/lease.ts");
		return new MigrateService({
			locations: () => ({
				home: homedir(),
				homeReal: realpathOr(homedir()),
				agentDir: cfg.agentDir,
				dataDir: cfg.dataDir,
				sessionDirs: sessionRoots
					.list()
					.filter((r) => r.kind === "session-dir")
					.map((r) => r.dir),
			}),
			ompVersion: () => version,
			serverVersion: SERVER_VERSION,
			hooks: {
				busy: () => pool.busyCount(),
				endIdle: () => pool.endAllIdle(),
				openElsewhere: async (id) => (await leaseHolders(id)).length > 0,
			},
			writing(on) {
				importWriting = on;
			},
			// What the server read from files an import replaced is read again, and every open page is told.
			async after() {
				sessionRoots.reload();
				// The guard choices an import brought are the person's own act (Move to another computer), not something to write over.
				approval.reload();
				// So are the guard's own settings: taken from the file the import wrote, then told to every gate and page.
				broadcastLocal({ t: "guard_config", config: guardSettings.reload(), rules: guardSettings.rules() });
				pool.syncRisk();
				modes.reload();
				await store.refresh(true);
				broadcastAll({ t: "prefs", snapshot: uiPrefs.snapshot() });
				broadcastAll({ t: "sessions_changed" });
				broadcastAll({ t: "model_config_changed" });
				// What an import brought of unattended mode: the questions (a file the import wrote), and the instruction the
				// conversations that are unattended are told.
				broadcastAll({ t: "questions", counts: unattendedMode.questions.counts() });
				shellEvents.questionsChanged();
				pool.rewriteUnattended();
				// The import replaced the loved models' file without going through `ListPref.set`, so no listener said so. A
				// file there that cannot be read as a list (not a file at all) leaves the pages with what they had.
				try {
					broadcastAll({ t: "favorite_models", models: favoriteModels.list() });
				} catch (e) {
					console.warn(`omp-webui: the loved models were not read again after the import: ${(e as Error).message}`);
				}
			},
			json,
			fail,
		});
	})();
	return migrating;
}

/** The Memory page's server side, made on first use: omp's long-term memory is read and changed only when somebody asks. */
let memoryLoading: Promise<MemoryService> | null = null;
function memoryService(): Promise<MemoryService> {
	memoryLoading ??= (async () => {
		const [{ MemoryService }, { memorySettings }] = await Promise.all([
			import("./memory/routes.ts"),
			import("./memory/config.ts"),
		]);
		return new MemoryService({
			agentDir: cfg.agentDir,
			dataDir: cfg.dataDir,
			settings: memorySettings(cfg.ompBin, cfg.agentDir, cfg.dataDir),
		});
	})().catch((e: unknown) => {
		memoryLoading = null;
		throw e;
	});
	return memoryLoading;
}

/**
 * The guidance conflict check (v0.13.0, `server/omp/guidance/conflict-server.ts`), made on first use: a conversation's new
 * guidance compared with the folder's context files and the project's memories by the guard reviewer's model, as the
 * Guidance tab asks for it after a save. Off when Settings says so (`ompw.guidanceCheck`).
 */
let conflictLoading: Promise<GuidanceConflictCheck> | null = null;
function guidanceConflicts(): Promise<GuidanceConflictCheck> {
	conflictLoading ??= import("./omp/guidance/conflict-server.ts")
		.then(({ serverConflictCheck }) =>
			serverConflictCheck({
				ompBin: cfg.ompBin,
				agentDir: cfg.agentDir,
				dataDirs: [cfg.dataDir, ...knownDataDirs()],
				protect: [cfg.dataDir, cfg.agentDir, ...knownDataDirs()],
				reviewer: reviewerSource,
				configured: () => reviewerSelectors(guardSettings.get().reviewer),
				enabled: () => uiPrefs.snapshot().values[PREF.guidanceCheck] !== "off",
				memories: async (cwd, limit) => (await memoryService()).forFolder(cwd, limit),
			}),
		)
		.catch((e: unknown) => {
			conflictLoading = null;
			throw e;
		});
	return conflictLoading;
}

/**
 * Refuse DNS-rebinding hosts and cross-origin requests. Served on the loopback and, when `OMP_WEBUI_HOST` is a network
 * address, on that address too (see `loopback-listener.ts`): a Host must be a loopback name or that address as written,
 * so a name that only resolves to either one is refused. Who is this computer is not decided here but by the socket
 * (`isThisComputer`). The Origin must match the Host exactly, port included: cookies and SameSite
 * ignore ports, so a page on another localhost port is otherwise "same-site".
 */
function trusted(req: Request): boolean {
	const hostHeader = req.headers.get("host") ?? "";
	const host = hostHeader.replace(/:\d+$/, "");
	if (!["127.0.0.1", "localhost", "[::1]"].includes(host) && host !== cfg.host) return false;
	const origin = req.headers.get("origin");
	if (origin) {
		try {
			if (new URL(origin).host !== hostHeader) return false;
		} catch {
			return false;
		}
	}
	return true;
}

/**
 * Whether a request comes from this page's own origin, as far as a browser says so (`Sec-Fetch-Site`, which a page cannot
 * set or leave out). Cookies and `SameSite` ignore ports, so a page on another localhost port is "same-site": its
 * no-cors requests carry the cookie and, for a GET, no `Origin` header. `none` is the person's own navigation; a client
 * that is no browser (the macOS shell, curl, a test) sends nothing.
 */
function fromOwnPage(req: Request): boolean {
	const site = req.headers.get("sec-fetch-site");
	return site === null || site === "same-origin" || site === "none";
}

/** The remote requests `route` let in (see `RemoteAuth.verify`), and who each is from. */
const remoteOf = new WeakMap<Request, RemoteIdentity>();

/** What the file transfer asks of a request: who it is from, what this computer lets that page do, and what must not be touched. */
function transferEnv(req: Request, peer: string | undefined): TransferEnv {
	const local = onThisComputer.has(req);
	const remote = remoteOf.get(req);
	return {
		setting: local ? "full" : remoteAuth.fileTransfer(),
		local,
		// The Access email of a page that came through the tunnel; `net:` and the address for one on the network.
		who: remote ? remote.email : local ? "local" : `net:${peer ?? "unknown"}`,
		validUntil: remote?.validUntil,
		dataDirs: [cfg.dataDir, ...knownDataDirs()],
		protect: [cfg.dataDir, cfg.agentDir, ...knownDataDirs()],
		home: homedir(),
	};
}

/** Whether the request came through the tunnel, and so over https: the access-token cookie it is given must be `Secure`. */
function viaTunnel(req: Request): boolean {
	if (remoteOf.has(req)) return true;
	try {
		const visitor: unknown = JSON.parse(req.headers.get("cf-visitor") ?? "null");
		return isRecord(visitor) && visitor.scheme === "https";
	} catch {
		return false;
	}
}

/**
 * Whether this verified remote request is given the access-token cookie: the API takes no request without it, and it
 * is issued only to a request that passed the Access check, with the first page that is loaded. (Never to a local
 * request, which exchanges the token itself, nor to the API or the socket.)
 */
function givesCookie(req: Request): boolean {
	if (!remoteOf.has(req) || !auth.enabled || auth.allowed(req)) return false;
	const p = new URL(req.url).pathname;
	return p !== "/ws" && !p.startsWith("/api/");
}

/** The close code of a remote socket whose Access token has run out: the page connects again through Access. */
const ACCESS_EXPIRED = 4401;
/** The longest a timer may be set for (a larger delay fires at once). */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** How often a remote page's socket is pinged: well inside what Cloudflare tolerates of a silent one. */
const remotePing = remotePingMs();

/**
 * End a remote page's socket when its Access token expires. The token is checked when the socket is opened and never
 * again, and Cloudflare checks only the requests it starts, not a socket it already carries: an expired or revoked
 * session would otherwise keep a shell on this machine for as long as the page stays connected (#548). The page connects
 * again, and Access either issues a new token or asks the person to log in.
 */
function watchAccess(ws: Bun.ServerWebSocket<WsData>): void {
	const remote = ws.data.remote;
	if (!remote) return;
	const check = () => {
		const left = remote.validUntil - Date.now();
		if (left <= 0) {
			ws.data.expiry = undefined;
			ws.close(ACCESS_EXPIRED, "Access session expired");
			return;
		}
		ws.data.expiry = setTimeout(check, Math.min(left, MAX_TIMER_MS));
	};
	check();
}

/** `path` with its links resolved; the path itself when it cannot be. */
function realpathOr(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** The folder a conversation was run in, for resuming it: what the session store knows of it, else what its file's header says. */
async function cwdOfSessionFile(file: string): Promise<string | null> {
	// The store learns of a file when its watcher fires: one written a moment ago has no summary yet.
	const s = await store.get(file);
	return s ? s.cwd : headerCwd(file);
}

/** The folder a session file's header records, read from the file itself; null when it names none or cannot be read. */
function headerCwd(file: string): string | null {
	let fd: number | null = null;
	try {
		fd = openSync(file, "r");
		const head = Buffer.alloc(64 * 1024);
		const text = head.toString("utf8", 0, readSync(fd, head, 0, head.length, 0));
		for (const line of text.split("\n")) {
			if (!line.includes('"session"')) continue;
			const header: unknown = JSON.parse(line);
			if (typeof header === "object" && header !== null && "type" in header && header.type === "session")
				return "cwd" in header && typeof header.cwd === "string" ? header.cwd : null;
		}
	} catch {
		// unreadable, or a line cut by the window: no folder is known
	} finally {
		if (fd !== null) closeSync(fd);
	}
	return null;
}

/**
 * The key a conversation's usage-wait choice and preset are kept under, if `file` names a session file in a folder
 * conversations are read from (omp's sessions dir, or one a `--profile` or `--session-dir` conversation keeps its
 * transcript in), written or not.
 */
function conversationKey(file: string): string | null {
	const key = sessionKey(file);
	return key.endsWith(".jsonl") && store.inFolders(key) ? key : null;
}

/** What the session actions need to know of `file`: its session id (which names its write lease) and where to run an omp for it. */
async function sessionTarget(file: string): Promise<SessionTarget> {
	const known = await store.get(file);
	return { file, id: known?.id ?? "", cwd: known?.cwd ?? cfg.sessionsDir };
}

/**
 * The folder the conversation a Files-tab request names works in: its running process's when it has one, else the folder
 * its session file records. The page names the conversation and never a folder, so that what it can read is bounded by
 * the conversations it can name (see `server/folder-routes.ts`).
 */
async function conversationCwd(liveId: string | null, file: string | null): Promise<string | null> {
	const running = liveId ? pool.get(liveId) : undefined;
	if (running && !running.info.exited) return running.info.cwd;
	const known = file ? store.resolveSessionPath(file) : null;
	return known ? ((await store.get(known))?.cwd ?? headerCwd(known)) : null;
}

async function api(req: Request, url: URL, peer: string | undefined): Promise<Response> {
	const p = url.pathname;
	const q = url.searchParams;
	// What starts work of its own (a command run again, GitHub asked) is a POST: a GET with these asks is the kind of
	// request that crosses ports without a preflight, and a plain read of the same path answers from what is kept.
	const startsWork =
		(q.get("force") === "1" && (p === "/api/stats" || p === "/api/usage" || p === "/api/models")) ||
		(p === "/api/git" && q.get("pr") === "1") ||
		((p === "/api/git" || p === "/api/git/worktrees") && q.get("fresh") === "1");
	if (startsWork && req.method !== "POST") return fail("POST required", 405);
	switch (p) {
		case "/api/meta":
			return json({
				ompVersion: version,
				serverVersion: SERVER_VERSION,
				agentDir: cfg.agentDir,
				sessionsDir: cfg.sessionsDir,
				home: homedir(),
				user: osUser(),
				// Whether this page is not on this computer: it came in through the public hostname (see `RemoteAuth`), or over a
				// network address the server listens on. Either one is shown what a remote page is shown.
				remote: !onThisComputer.has(req),
				// Whether it is on the computer the server runs on (see `isThisComputer`): what only that computer may change.
				local: onThisComputer.has(req),
				// What this page may do with the files of a conversation's folder (see `shared/transfer.ts`): all of it for a page
				// on this computer, what the person set on this computer for any other.
				fileTransfer: onThisComputer.has(req) ? "full" : remoteAuth.fileTransfer(),
				// Whether this page may open a shell in the panel's Terminal tab: always on this computer, as the person set it for any other.
				shell: onThisComputer.has(req) || remoteAuth.remoteShell(),
				// The other Macs this one knows, for the sidebar's machine switcher: what a page needs to open one and nothing of the app's own.
				macs: savedMacs.saved(),
				// How many questions wait for the person (#646): the sidebar's badge is there from the first look.
				questions: unattendedMode.questions.counts(),
				// Whether the server can keep this machine from going to idle sleep while a conversation works (#647): macOS's
				// `caffeinate` is the only way it has, so a server anywhere else says the setting is not available rather than
				// showing a switch that does nothing.
				keepAwakeAvailable: keepAwake.available,
				// The folder Ask agent for help's conversations run in, for a page on this computer: it marks one when it shows it.
				...(onThisComputer.has(req) ? { settingsHelpFolder: settingsHelp.state().folder } : {}),
			});
		case "/api/diagnostics":
			return json({ os: await osDescription(), mode: modes.mode });
		case "/api/repo":
			return json({ public: await repoVisibility.isPublic() });
		case "/api/sessions": {
			// A client that has the list asks for what changed since the cursor of its last answer (a request header, so
			// the URL stays the same); one without a cursor, or with a stale one, is sent the whole list as an array.
			const changes = await store.changes(req.headers.get("x-sessions-since"));
			const answer = json(changes.full ? changes.sessions : { changed: changes.sessions, removed: changes.removed });
			answer.headers.set("x-sessions-cursor", changes.cursor);
			answer.headers.set("vary", "x-sessions-since");
			return answer;
		}
		case "/api/session": {
			const file = store.resolveSessionPath(q.get("file") ?? "");
			if (!file) return fail("Unknown session file", 404);
			// Read, parsed, serialized and gzipped in a worker, as the family is: a transcript of tens of MB must not hold the thread.
			return families.respondSession(req, file);
		}
		case "/api/subagents": {
			// Just the subagents (with what each spent): cheap to ask again while some are still writing.
			const file = store.resolveSessionPath(q.get("file") ?? "");
			if (!file) return fail("Unknown session file", 404);
			return json(await store.listSubagents(file));
		}
		case "/api/family": {
			const file = store.resolveSessionPath(q.get("file") ?? "");
			if (!file) return fail("Unknown session file", 404);
			// A window of the conversation's history (`view`), or its lineage whole.
			const asked = parseViewRequest(q);
			if (!asked.ok) return fail(asked.error, 400);
			// `file` is canonical (symlinks resolved); clients switch to it so paths match everywhere.
			return families.respond(req, file, asked.view);
		}
		case "/api/search": {
			// `file` narrows the search to one conversation, uncapped (the palette's "N more in this conversation").
			const requested = q.get("file");
			const file = requested === null ? undefined : store.resolveSessionPath(requested);
			if (file === null) return fail("Unknown session file", 404);
			// The page drops a search it has typed past (it aborts the fetch): the index then skips it.
			// The sidebar's search (#717): `conversations=N` asks for the best hit of each of up to N conversations (instead
			// of `limit` hits), `all=1` for every word of `q` in one message, in any order.
			const conversations = q.get("conversations");
			const limit = Number(conversations ?? q.get("limit") ?? 50);
			const {
				hits,
				coverage,
				file: covered,
			} = await store.searchResult(q.get("q") ?? "", limit, file, {
				signal: req.signal,
				...(conversations === null ? {} : { perConversation: 1 }),
				words: q.get("all") === "1",
			});
			const answer = json(hits);
			// While the library is still being indexed (first start, after an update) the hits are only those of the
			// files indexed so far; the header says how many that is, and is absent when the answer is complete.
			if (coverage.indexed < coverage.total)
				answer.headers.set("x-search-index", `${coverage.indexed}/${coverage.total}`);
			// A search that named one conversation answers from that conversation alone: when it is not wholly in the
			// index, the answer does not say what is in it, and the caller must be able to tell (#509).
			if (covered && !covered.complete) answer.headers.set("x-search-file", `${covered.indexed}/${covered.total}`);
			return answer;
		}
		case "/api/stats": {
			// Loaded on the first request (#585), like the other readers of omp's own output below.
			const { keepStatsIn, keptStats, ompStats } = await import("./omp/stats.ts");
			// What the guard's reviewer spent is its own agent type (#689), taken out of the one omp counts it under.
			const { addGuardUsage } = await import("./guard-usage.ts");
			const { statsDbPath, statsForRange } = await import("./omp/stats-db.ts");
			keepStatsIn(join(cfg.dataDir, "omp-stats.json"));
			const force = q.get("force") === "1";
			const asked = q.get("range");
			const range = isUsageRange(asked) ? asked : DEFAULT_USAGE_RANGE;
			// `omp stats --json` answers only its own 24 hours (#714); its run is still what brings omp's database up to date
			// with the transcripts, and the range is read from that database. One window bounds every figure, the guard's too.
			const dbPath = statsDbPath(cfg.agentDir, process.env, homedir());
			const answer = async (ompBody: string, headers: Record<string, string>) => {
				const ranged = statsForRange(ompBody, range, dbPath, Date.now());
				// Only the guard's requests that database holds were counted in the figures (#706). Its answer is the figures only
				// when it is the one omp read (`window`): otherwise it is not asked, and what omp counted is not known.
				const guarded = await addGuardUsage(
					ranged.body,
					cfg.sessionsDir,
					ranged.window ?? undefined,
					ranged.window ? dbPath : undefined,
				);
				return new Response(guarded, {
					headers: {
						"content-type": "application/json",
						"x-stats-range": range,
						...(ranged.window ? {} : { "x-stats-fallback": "24h" }),
						...headers,
					},
				});
			};
			// A plain ask is answered at once from the figures kept from before, while omp brings them up to date (#690):
			// `x-stats-refreshing` tells the page to ask again with `wait=1`, which waits for that run.
			const kept = force || q.get("wait") === "1" ? null : keptStats(cfg.ompBin);
			if (kept)
				return answer(kept.body, {
					"x-stats-at": String(Math.round(kept.at)),
					...(kept.refreshing ? { "x-stats-refreshing": "1" } : {}),
				});
			return answer(await ompStats(cfg.ompBin, force), { "x-stats-at": String(Date.now()) });
		}
		case "/api/cli":
			return json(await cliInventory(cfg.ompBin));
		case "/api/cli/help":
			return json(await cliHelp(cfg.ompBin, q.get("cmd") ?? ""));
		case "/api/files": {
			// Loaded on the first request (see `folder-lazy.ts`): nobody completes a file name until they type an `@`.
			const { suggestFiles } = await import("./files.ts");
			return json(await suggestFiles(q.get("cwd") ?? "", q.get("q") ?? ""));
		}
		case "/api/dirs": {
			// Loaded on the first request: the folder picker is used a few times in a person's life.
			const { DirError, listDirs } = await import("./dirs.ts");
			try {
				return json(listDirs(q.get("path") ?? "", homedir()));
			} catch (e) {
				if (e instanceof DirError) return fail(e.message, e.status, errorInfoOf(e) ?? undefined);
				throw e;
			}
		}
		case "/api/projects":
		case "/api/projects/new": {
			// Loaded on the first request (#585: a lazily loaded module, as `dirs.ts` above): the setting is read when
			// Settings opens or the folder picker makes a project.
			const { ProjectError, ProjectsFolder } = await import("./projects.ts");
			const { DirError } = await import("./dirs.ts");
			const projects = new ProjectsFolder(cfg.dataDir, homedir());
			try {
				if (req.method !== "POST") return json(projects.info());
				const body = (await req.json().catch(() => null)) as { folder?: unknown; name?: unknown } | null;
				if (url.pathname === "/api/projects/new") {
					// Open to a remote page too, unlike the setting below: it makes one empty folder, directly in the folder the
					// person chose, under a name that cannot leave it and cannot be a folder that exists. A remote page can already
					// start a conversation in any folder (`/api/dirs` lists them all) and has an agent's whole reach there.
					return json(projects.create(body?.name));
				}
				// Where projects are made is the person's at this computer, as the tunnel's settings are: a page that came through
				// the tunnel (or from the network) must not move it, though it may use it.
				if (!onThisComputer.has(req)) {
					return fail("The projects folder is changed on the computer omp-webui runs on", 403, {
						code: "projectsNotHere",
					});
				}
				const folder = body?.folder;
				if (folder !== null && typeof folder !== "string") {
					return fail("Name the folder, or null for the default", 400, { code: "projectsFolderShape" });
				}
				return json(projects.set(folder));
			} catch (e) {
				if (e instanceof ProjectError) return json({ error: e.message, problem: e.problem }, e.status);
				if (e instanceof DirError) return fail(e.message, e.status, errorInfoOf(e) ?? undefined);
				throw e;
			}
		}
		case "/api/git": {
			// The status line's branch, change counts and pull request; the page may never be failed by what git does.
			let dir: string;
			try {
				dir = await git.directoryOf(q.get("cwd") ?? "");
			} catch (e) {
				return fail((e as Error).message);
			}
			return json(await git.report(dir, { pr: q.get("pr") === "1", fresh: q.get("fresh") === "1" }));
		}
		case "/api/git/worktrees": {
			// The Worktrees tab (#698): the repository's worktrees and how each stands, looked at as the status line looks.
			let dir: string;
			try {
				dir = await git.directoryOf(q.get("cwd") ?? "");
			} catch (e) {
				return fail((e as Error).message);
			}
			return json(await git.worktrees(dir, { fresh: q.get("fresh") === "1" }));
		}
		case "/api/github/issues":
		case "/api/github/issue": {
			// The Issues tab (#653): the folder's GitHub issues, read with the person's `gh`. GitHub is asked: a POST.
			if (req.method !== "POST") return fail("POST required", 405);
			const body = (await req.json().catch(() => null)) as {
				cwd?: unknown;
				state?: unknown;
				search?: unknown;
				number?: unknown;
				fresh?: unknown;
			} | null;
			let dir: string;
			try {
				dir = await git.directoryOf(typeof body?.cwd === "string" ? body.cwd : "");
			} catch (e) {
				return fail((e as Error).message);
			}
			const reader = await issuesReader();
			const fresh = body?.fresh === true;
			if (p === "/api/github/issue") return json(await reader.view(dir, Number(body?.number), { fresh }));
			const state = ISSUE_FILTERS.find((f) => f === body?.state) ?? "open";
			const search = typeof body?.search === "string" ? body.search : undefined;
			return json(await reader.list(dir, { state, search, fresh }));
		}
		case "/api/github/runs":
		case "/api/github/run": {
			// The CI tab: the folder's GitHub Actions runs, and one run's jobs, read with the person's `gh` (a POST, as GitHub is
			// asked). Pages that ask within a look's interval share it (`server/gh-runs.ts`).
			if (req.method !== "POST") return fail("POST required", 405);
			const body = (await req.json().catch(() => null)) as {
				cwd?: unknown;
				scope?: unknown;
				id?: unknown;
				fresh?: unknown;
			} | null;
			let dir: string;
			try {
				dir = await git.directoryOf(typeof body?.cwd === "string" ? body.cwd : "");
			} catch (e) {
				return fail((e as Error).message);
			}
			const reader = await runsReader();
			const fresh = body?.fresh === true;
			if (p === "/api/github/run") return json(await reader.jobs(dir, Number(body?.id), { fresh }));
			const scope = CI_SCOPES.find((s) => s === body?.scope) ?? "branch";
			return json(await reader.runs(dir, scope, { fresh }));
		}
		case "/api/usage": {
			const { isProviderId, providerUsage } = await import("./omp/usage.ts");
			const provider = q.get("provider") ?? "";
			if (!isProviderId(provider)) return fail("Invalid provider id");
			return json(await providerUsage(cfg.ompBin, provider, q.get("force") === "1"));
		}
		case "/api/models":
			// The models to choose from are omp's own list, or (`scope=local`) the ones the local server serves, which a
			// conversation that runs on one (Light with a local server) picks from: another process of the same page may
			// run in another mode, so the page says which it wants. `force`: a provider was signed in since the list was taken.
			return json(
				q.get("scope") === "local"
					? await modes.modelInfos()
					: await availableModels(cfg.ompBin, q.get("force") === "1"),
			);
		case "/api/mode":
		case "/api/offline/models":
		case "/api/offline/context":
			return modeApi(req, url);
		case "/api/lives":
			return json(pool.list());
		case "/api/host":
			return json(host.history());
		case "/api/shell/background":
			// The macOS app is about to close its window for Run in Background (local-only: `/api/shell`): the terminals of the page
			// that closes with it are held for the page of the window that opens again, not killed with its socket. DELETE: the
			// window was opened again before it closed (or within the 10 s): a browser tab that closes now is not that window.
			if (req.method === "DELETE") {
				ptys.cancelDetach();
				return json({ held: false });
			}
			if (req.method !== "POST") return fail("POST or DELETE required", 405);
			ptys.expectDetach();
			return json({ held: true });
		case "/api/shell/quota": {
			// The menu bar icon's quota lines (local-only: `/api/shell`), in the saved language, else the app's (`lang`). omp is
			// asked through the same cache as the page's quota pills: an icon opened often starts no more `omp usage` than they do.
			const { providerUsage } = await import("./omp/usage.ts");
			const { menuQuotaLines } = await import("./menu-quota.ts");
			const lang = noticeLang(uiPrefs.snapshot().values[PREF.lang], q.get("lang"));
			try {
				return json({ lines: menuQuotaLines(await providerUsage(cfg.ompBin, ""), lang) });
			} catch {
				// No omp, no account signed in, a provider that did not answer: the menu shows no quota rather than an error.
				return json({ lines: [] });
			}
		}
		case "/api/shell/pause-all":
		case "/api/shell/resume-all": {
			// The macOS menu bar icon (local-only: `/api/shell`): every conversation whose turn is open is paused (one that
			// works, or waits for an answer), or every paused one is resumed, each with its own Pause / Resume. One that
			// refuses (it is being closed) is left as it is; the others go on.
			if (req.method !== "POST") return fail("POST required", 405);
			const pausing = url.pathname === "/api/shell/pause-all";
			const chosen = pool.list().filter((info) => {
				if (info.exited) return false;
				if (!pausing) return info.pausedAt !== null;
				const facts = factsOf(info);
				return info.pausedAt === null && (facts.needsInput || working(facts));
			});
			const done = await Promise.allSettled(
				chosen.map((info) => {
					const live = pool.get(info.liveId);
					if (!live) return Promise.resolve();
					return pausing ? live.pause() : live.resume();
				}),
			);
			return json({ changed: done.filter((d) => d.status === "fulfilled").length, of: chosen.length });
		}
		case "/api/lives/end-kept":
			// "Quit and end" in the macOS app: paused conversations would stay frozen in the background otherwise, and ones
			// waiting out a usage limit would go on waiting there.
			if (req.method !== "POST") return fail("POST required", 405);
			return json({ ended: await pool.endKept() });
		case "/api/loaded": {
			// What this conversation has loaded: its process's answer while it runs; else only what the CLI says of its folder.
			// A paused process is frozen and cannot answer: it counts as not running, not as sections that each fail.
			const live = pool.get(q.get("live") ?? "");
			const known = live && !live.info.exited && !live.client.closing ? live : null;
			const answering = known && known.info.pausedAt === null ? known : null;
			const file = store.resolveSessionPath(q.get("file") ?? "");
			const cwd = known?.info.cwd ?? (file ? (await store.get(file))?.cwd : null);
			if (!cwd) return fail("Unknown conversation", 404);
			return json(
				await collectLoaded({
					bin: cfg.ompBin,
					cwd,
					startedAt: known?.info.startedAt ?? null,
					// A profile's conversation has its own agent directory (its MCP servers, skills and settings are
					// there), and not the one the process inherited. A Light process has an agent directory of its
					// own, which is the one in its environment.
					agentDir:
						known?.info.mode === "light"
							? (known?.env.PI_CODING_AGENT_DIR ?? cfg.agentDir)
							: file
								? sessionRoots.agentDirFor(file)
								: (known?.env.PI_CODING_AGENT_DIR ?? cfg.agentDir),
					env: known?.env ?? {},
					light: known?.info.mode === "light",
					process: answering,
				}),
			);
		}
		case "/api/guard":
			// "Guard dangerous commands" (Settings › Safety): changed from a page on this computer only (see `route`).
			if (req.method === "POST") {
				const body: unknown = await req.json().catch(() => null);
				try {
					const config = guardSettings.set(body);
					guardChanged(config);
					return json({ config });
				} catch (e) {
					if (e instanceof GuardConfigError) return fail(e.message);
					return fail(`Could not keep the guard's settings: ${(e as Error).message}`, 500);
				}
			}
			return json({ config: guardSettings.get() });
		case "/api/guard/live": {
			// One conversation's own settings over the global ones (see `GuardOverride`); `guard` null: it follows them again.
			// For a page on this computer only, as the global settings are (see `route`).
			if (req.method !== "POST") return fail("POST required", 405);
			if (!onThisComputer.has(req)) return fail("The guard is changed on the computer omp-webui runs on", 403);
			const body = (await req.json().catch(() => null)) as { liveId?: unknown; guard?: unknown } | null;
			const live = typeof body?.liveId === "string" ? pool.get(body.liveId) : undefined;
			if (!live || live.info.exited) return fail("Live session not found", 404);
			try {
				const patch = body?.guard === null ? FOLLOW_GLOBAL_GUARD : parseGuardOverridePatch(body?.guard);
				return json({ guard: live.changeGuard(patch) });
			} catch (e) {
				if (e instanceof GuardConfigError) return fail(e.message);
				const why = (e as Error).message;
				return fail(`Could not change the conversation's guard: ${why}`, why.includes("not running") ? 409 : 500);
			}
		}
		case "/api/guard/rules":
			// What the person tuned of the guard: the reviewer's rules, the threshold of each category, their own benchmark
			// cases. Local only like the rest of `/api/guard*` (see `route`); the shipped defaults come with it.
			if (req.method === "POST") {
				const body: unknown = await req.json().catch(() => null);
				try {
					const rules = guardSettings.setRules(body);
					// Every gate is told now, not at the next look.
					pool.syncRisk();
					broadcastLocal({ t: "guard_config", config: guardSettings.get(), rules });
					return json({ rules, defaults: GUARD_DEFAULTS });
				} catch (e) {
					if (e instanceof GuardConfigError) return fail(e.message);
					return fail(`Could not keep the guard's settings: ${(e as Error).message}`, 500);
				}
			}
			return json({ rules: guardSettings.rules(), defaults: GUARD_DEFAULTS });
		case "/api/guard/bench":
			// The benchmark: judges the shipped and the person's cases by the settings as they are now, and runs nothing.
			if (req.method === "POST") {
				const body = (await req.json().catch(() => null)) as { reviewer?: unknown } | null;
				try {
					return json({ run: guardBench.start(body?.reviewer === true) });
				} catch (e) {
					if (e instanceof BenchBusy) return fail(e.message, 409);
					return fail(`Could not start the benchmark: ${(e as Error).message}`, 500);
				}
			}
			return json(guardBench.info());
		case "/api/guard/bench/cancel":
			if (req.method !== "POST") return fail("POST required", 405);
			return json({ cancelled: guardBench.cancel() });
		case "/api/guard/bench/preview": {
			// What an Allow (or any change of thresholds) would let through, tried on the shipped harmful cases with the classifier alone.
			if (req.method !== "POST") return fail("POST required", 405);
			const body = (await req.json().catch(() => null)) as { thresholds?: unknown } | null;
			try {
				return json({ preview: guardBench.preview(body?.thresholds) });
			} catch (e) {
				if (e instanceof GuardConfigError) return fail(e.message);
				return fail(`Could not try the change: ${(e as Error).message}`, 500);
			}
		}
		case "/api/guard/log": {
			const q = url.searchParams;
			const limit = Math.min(1000, Math.max(1, Math.trunc(Number(q.get("limit"))) || 200));
			const outcome = GUARD_OUTCOMES.find((o) => o === q.get("outcome"));
			const by = GUARD_BYS.find((b) => b === q.get("by"));
			return json(
				guardLog.query({
					limit,
					...(q.get("before") ? { before: q.get("before") as string } : {}),
					...(outcome ? { outcome } : {}),
					...(by ? { by } : {}),
					...(q.get("q") ? { text: (q.get("q") as string).slice(0, 200) } : {}),
					...(q.get("conversation") ? { conversation: q.get("conversation") as string } : {}),
				}),
			);
		}
		case "/api/guard/decisions": {
			// By the transcript file (what a page knows of a subagent without reading it) or by the session's id.
			const file = url.searchParams.get("file") ?? "";
			const session = url.searchParams.get("session") ?? "";
			if (file === "" && session === "")
				return fail("Name the session or the transcript file whose decisions are wanted");
			return json({ decisions: file !== "" ? guardLog.ofFile(file, 500) : guardLog.ofSession(session, 500) });
		}
		case "/api/prefs":
			if (req.method === "POST") {
				const body = (await req.json().catch(() => null)) as { changes?: unknown } | null;
				// "Keep the Mac awake while a conversation works" is the person's at this computer (#647): a page that came in
				// through the tunnel or over the network would be turning off the protection of the conversations it drives
				// while they work. Its key is refused with the rest, not silently dropped, so the page can say why.
				if (!onThisComputer.has(req) && isRecord(body?.changes) && Object.hasOwn(body.changes, PREF.keepAwake))
					return fail("Keep the Mac awake is changed on the computer omp-webui runs on", 403);
				try {
					return json(applyPrefs(body?.changes));
				} catch (e) {
					if (e instanceof PrefsError) return fail(e.message);
					throw e;
				}
			}
			return json(uiPrefs.snapshot());
		case "/api/pins":
			if (req.method === "POST") {
				const body = (await req.json()) as { file?: unknown; pinned?: unknown };
				const file = typeof body.file === "string" ? store.resolveSessionPath(body.file) : null;
				if (!file) return fail("Unknown session file", 404);
				try {
					return json(await pins.set(file, body.pinned === true));
				} catch (e) {
					return fail((e as Error).message, 500);
				}
			}
			return json(await pins.list());
		case "/api/favorite-models":
			if (req.method === "POST") {
				const body = (await req.json()) as { model?: unknown; on?: unknown };
				// `provider/model-id`, as omp names models.
				if (typeof body.model !== "string" || !/^[^\s/]+\/\S+$/.test(body.model) || body.model.length > 200)
					return fail("Bad model id");
				return json(favoriteModels.set([body.model], body.on === true));
			}
			return json(favoriteModels.list());
		case "/api/approval": {
			// The default approval mode of new conversations: null follows omp's own setting, which is reported with it.
			if (req.method === "POST") {
				const body = (await req.json()) as { mode?: unknown };
				if (body.mode !== null && !isApprovalMode(body.mode)) return fail("Bad approval mode");
				approval.setDefault(body.mode);
			}
			return json({ mode: approval.defaultMode(), omp: await approval.configured() });
		}
		case "/api/approval/session": {
			// The mode a conversation without a running omp starts in when it is opened: what the user last picked for
			// it, else their default, else omp's own setting for its folder (`ApprovalStore.startingMode`); `omp` names
			// that setting when it is none of the modes the page can set.
			const file = store.resolveSessionPath(q.get("file") ?? "");
			if (!file) return fail("Unknown session file", 404);
			const cwd = (await store.get(file))?.cwd ?? cfg.sessionsDir;
			return json(await approval.startingMode(cwd, file));
		}
		case "/api/model-preset/session": {
			// The preset a conversation without a running omp comes back on (what the user switched it to; null: the
			// global config's roles). A running omp says so itself, in its `LiveInfo`.
			const key = conversationKey(q.get("file") ?? "");
			if (!key) return fail("Unknown session file", 404);
			return json({ models: approval.sessionModels(key) });
		}
		case "/api/compact-at": {
			// Where a conversation compacts: omp's `compaction.thresholdPercent` / `thresholdTokens` (see `shared/compact-at.ts`).
			// POST changes omp's own default, as `omp config set` does in the terminal (`at` null: omp's default again), and
			// answers with what omp's configuration says now. `?file=` adds the point the conversation chose for itself
			// (`session`), which its own overlay holds; `?live=` names a running process, whose `LiveInfo.compactAt` is the
			// truth of what it was told.
			if (req.method === "POST") {
				const body: unknown = await req.json().catch(() => null);
				if (!isRecord(body) || !("at" in body)) return fail("Bad value");
				// `at` null is omp's default again; anything else must be a point this page can set, never a guess.
				if (body.at !== null && compactAtOf(body.at) === null) return fail("Bad value");
				try {
					await configureCompactAt(cfg, {}, compactAtOf(body.at));
				} catch (e) {
					return fail((e as Error).message, 500);
				}
			}
			const file = q.get("file");
			const key = file === null ? null : conversationKey(file);
			if (file !== null && !key) return fail("Unknown session file", 404);
			return json({
				omp: await ownCompactAt.get(),
				session: key ? approval.sessionCompact(key) : null,
			});
		}
		case "/api/compact-at/session": {
			// One conversation's own point (`at` null: omp's configuration again). Its file need not be written yet.
			if (req.method !== "POST") return fail("POST required", 405);
			const body: unknown = await req.json().catch(() => null);
			const key = isRecord(body) && typeof body.file === "string" ? conversationKey(body.file) : null;
			if (!key) return fail("Unknown session file", 404);
			if (!isRecord(body) || !("at" in body)) return fail("Bad value", 400);
			if (body.at !== null && compactAtOf(body.at) === null) return fail("Bad value", 400);
			const at = compactAtOf(body.at);
			try {
				await pool.setCompact(key, at);
			} catch (e) {
				return fail((e as Error).message, 409);
			}
			return json({ omp: await ownCompactAt.get(), session: at });
		}
		case "/api/usage-reset-wait": {
			// Whether a failed turn waits out its provider's usage limit is omp's own retry (`retry.waitForUsageReset`):
			// POST changes it as `omp config set` does, and the answer is what `omp config get` says now, with the
			// choice made for the conversation in `?file=` (null: it follows omp's).
			if (req.method === "POST") {
				const body = (await req.json()) as { enabled?: unknown };
				if (typeof body.enabled !== "boolean") return fail("Bad value");
				try {
					await approval.configureUsageWait(body.enabled);
				} catch (e) {
					return fail((e as Error).message, 500);
				}
			}
			const file = q.get("file");
			const key = file === null ? null : conversationKey(file);
			if (file !== null && !key) return fail("Unknown session file", 404);
			return json({ omp: await ownUsageWait.get(), session: key ? approval.sessionUsageWait(key) : null });
		}
		case "/api/usage-reset-wait/session": {
			// One conversation's own choice (`enabled` null: omp's setting again). Its file need not be written yet.
			if (req.method !== "POST") return fail("POST required", 405);
			const body = (await req.json()) as { file?: unknown; enabled?: unknown };
			const key = typeof body.file === "string" ? conversationKey(body.file) : null;
			if (!key) return fail("Unknown session file", 404);
			if (body.enabled !== null && typeof body.enabled !== "boolean") return fail("Bad value");
			try {
				await pool.setUsageWait(key, body.enabled);
			} catch (e) {
				return fail((e as Error).message, 409);
			}
			return json({ omp: await ownUsageWait.get(), session: body.enabled });
		}
		case "/api/model-guidance": {
			// The model guidance templates (#641): what Settings › Model guidance edits and the New chat picker offers. Every
			// page may read them (a phone's New chat offers the same list); a change is made on this computer only, as the
			// guard's settings are: what a template says is put into the system prompt of every conversation that picks it,
			// which is the reason omp's memory is changed here too and nowhere else (see `isLocalOnlyRoute`).
			if (req.method === "POST") {
				if (!onThisComputer.has(req))
					return fail("The model guidance is changed on the computer omp-webui runs on", 403);
				const body = (await req.json().catch(() => null)) as {
					template?: unknown;
					remove?: unknown;
					update?: unknown;
				} | null;
				try {
					const set =
						body?.remove !== undefined
							? modelGuidance.remove(body.remove)
							: // `update`: a conversation's tab saves its edit into the template it came from (#715), which must still be there.
								modelGuidance.save(body?.template, body?.update === true);
					// Every running conversation that uses a template carries what it says now from its next turn, and the
					// pages that show it are told (the text, and a new name) (v0.12.2).
					pool.followGuidanceTemplates();
					return json(set);
				} catch (e) {
					// The word as well as the text: the page says it in its own language.
					if (e instanceof GuidanceStoreError)
						return json({ error: guidanceProblemText(e.problem), problem: e.problem }, 422);
					return fail(`Could not save the guidance template: ${(e as Error).message}`, 500);
				}
			}
			return json(modelGuidance.snapshot());
		}
		case "/api/model-guidance/restore": {
			// Put the shipped templates back as they ship (the ones the person deleted come back, the ones they edited are
			// set to the shipped text; templates they made are left alone). This computer only, as a change is.
			if (req.method !== "POST") return fail("POST required", 405);
			if (!onThisComputer.has(req)) return fail("The model guidance is changed on the computer omp-webui runs on", 403);
			try {
				const set = modelGuidance.restoreDefaults();
				pool.followGuidanceTemplates();
				return json(set);
			} catch (e) {
				return fail(`Could not restore the shipped guidance: ${(e as Error).message}`, 500);
			}
		}
		case "/api/model-guidance/session": {
			// What one conversation carries, by its live id (`live`), or what would be carried for a session file that has
			// no process now (`file`: the choice kept for it when it was last open), with the templates it may pick from, and
			// how many other conversations use each template (`others`: the tab asks before it saves into one that is shared).
			const liveId = q.get("live");
			if (liveId !== null) {
				const live = pool.get(liveId);
				if (!live || live.info.exited) return fail("Live session not found", 404);
				const own = live.info.sessionFile ? sessionKey(live.info.sessionFile) : null;
				return json({
					guidance: live.info.guidance ?? null,
					templates: modelGuidance.snapshot(),
					others: modelGuidance.sessions.usersByTemplate(own),
				});
			}
			const file = store.resolveSessionPath(q.get("file") ?? "");
			if (!file) return fail("Unknown session file", 404);
			// No process: what was kept is what its next opening carries, and is changed through `/api/model-guidance/live`
			// with `file` (#715). `live` is false: nothing runs that reads it now.
			return json({
				guidance: liveGuidanceOf(pool.keptGuidance(file), modelGuidance.templates(), false),
				templates: modelGuidance.snapshot(),
				others: modelGuidance.sessions.usersByTemplate(sessionKey(file)),
			});
		}
		case "/api/model-guidance/live": {
			// One conversation's guidance changes (`guidance` null, or empty: none). It reaches the process's next turn
			// without a restart when its omp runs the extension, and the choice is kept for its next opening either way.
			// A conversation named by its session `file` that has no process (#715) has the choice kept for when it is
			// opened; one whose process runs is changed in it, as by its live id. This computer only, as the conversation's
			// own guard settings are: both put words into what its agent is told.
			if (req.method !== "POST") return fail("POST required", 405);
			if (!onThisComputer.has(req)) return fail("The model guidance is changed on the computer omp-webui runs on", 403);
			const body = (await req.json().catch(() => null)) as {
				liveId?: unknown;
				file?: unknown;
				guidance?: unknown;
			} | null;
			const file =
				typeof body?.liveId !== "string" && typeof body?.file === "string" ? store.resolveSessionPath(body.file) : null;
			if (typeof body?.liveId !== "string" && !file) return fail("Unknown session file", 404);
			const live = typeof body?.liveId === "string" ? pool.get(body.liveId) : file ? pool.liveOfFile(file) : undefined;
			if (typeof body?.liveId === "string" && (!live || live.info.exited)) return fail("Live session not found", 404);
			let asked: SessionGuidance | null;
			try {
				asked = parseSessionGuidance(body?.guidance);
			} catch (e) {
				return fail((e as Error).message, 422);
			}
			try {
				if (live && !live.info.exited) return json({ guidance: live.setGuidance(pool.pickedGuidance(asked)) });
				const kept = pool.keepGuidanceFor(file as string, pool.pickedGuidance(asked));
				return json({ guidance: liveGuidanceOf(kept, modelGuidance.templates(), false) });
			} catch (e) {
				return fail(`Could not change the conversation's guidance: ${(e as Error).message}`, 409);
			}
		}
		case "/api/model-guidance/conflicts": {
			// The guidance conflict check (v0.13.0): `text`, the guidance the conversation (`liveId`, or its session `file`) was
			// just given, compared with its folder's AGENTS.md and the like and the project's memories by a small model. It
			// writes nothing: the page proposes each change for the person to apply. This computer only, as a change of the
			// guidance is, and because it reads the folder's files and what omp remembers.
			if (req.method !== "POST") return fail("POST required", 405);
			if (!onThisComputer.has(req)) return fail("The model guidance is changed on the computer omp-webui runs on", 403);
			const body: unknown = await req.json().catch(() => null);
			if (!isRecord(body) || typeof body.text !== "string" || body.text.length > GUIDANCE_MAX)
				return fail("Bad value", 422);
			const cwd = await conversationCwd(
				typeof body.liveId === "string" ? body.liveId : null,
				typeof body.file === "string" ? body.file : null,
			);
			if (!cwd) return fail("Unknown conversation", 404);
			return json(await (await guidanceConflicts()).check(cwd, body.text));
		}
		case "/api/quota-floor": {
			// The quota floor (#652): for each provider that has one, the share of a usage window that may be left before the work
			// in progress is held. Every page may read it; a change follows `/api/usage-reset-wait`, the setting beside it that is
			// about the same quota: a floor is a number, and a conversation that does not want one can "Continue anyway". It
			// reaches the conversations that work now at their next look at the quota.
			if (req.method === "POST") {
				const body = (await req.json().catch(() => null)) as unknown;
				if (!isRecord(body)) return fail("Bad value", 422);
				try {
					const settings = quotaFloor.set(body.provider, "floor" in body ? body.floor : undefined);
					pool.quotaFloorChanged();
					return json(settings);
				} catch (e) {
					if (e instanceof FloorError) return fail(e.message, 422);
					return fail(`Could not save the floor: ${(e as Error).message}`, 500);
				}
			}
			return json(quotaFloor.settings());
		}
		case "/api/questions":
			// The list of unattended mode's questions (#646). Every page may read it, as it may read the conversations the
			// questions are from; the pages are told the counts on every change (`questions`), and read the list when they open it.
			return json(unattendedMode.questions.list());
		case "/api/questions/answer": {
			// The person answers a question: the answer goes to its conversation as a message like any other (while the
			// conversation works, queued behind its turn or, as the person chooses (`delivery: "steer"`), steered into it;
			// waking it when it is idle or closed), under the rules every message a page sends is under (`turnRefusal`: a
			// remote page's turn is the confirm-risky setting's). The question is marked answered only once the message is on
			// its way: one that could not be sent stays open.
			if (req.method !== "POST") return fail("POST required", 405);
			const body = (await req.json().catch(() => null)) as unknown;
			const asked = isRecord(body) ? unattendedMode.questions.get(body.id) : undefined;
			if (!asked) return fail("That question is not in the list any more", 404);
			if (asked.state !== "open") return fail("That question is answered or dismissed already", 409);
			const answer = cleanAnswer(asked, body);
			if (!answer) return fail("Choose an option or write an answer", 422);
			const delivery = isRecord(body) && body.delivery !== undefined ? body.delivery : "followUp";
			if (delivery !== "followUp" && delivery !== "steer") return fail("Send it after the turn or steer it in", 422);
			if (!asked.session)
				return fail("The conversation this question is from is not known, so the answer cannot be sent", 409);
			if (answering.has(asked.id)) return fail("That question is being answered", 409);
			answering.add(asked.id);
			try {
				const remote = !onThisComputer.has(req);
				const live = await pool.open({ kind: "resume", sessionFile: asked.session }, cwdOfSessionFile);
				const refusal = turnRefusal(live, remote);
				if (refusal) return fail(refusal, 403);
				if (remote) remoteTouched.add(live.info.liveId);
				else remoteTouched.delete(live.info.liveId);
				// A paused conversation is continued first, as the composer does.
				if (live.info.pausedAt !== null) await live.resume();
				// The turn the answer starts is not told the question still waits (#694); `finally` tells it again if not sent.
				live.writeUnattended(asked.id);
				const sent = await live.rpc(
					{
						type: "prompt",
						message: answerMessage(asked, answer),
						// While it works the answer is queued behind the turn, or steered into it; omp starts a turn with it when it is idle.
						...(live.info.streaming ? { streamingBehavior: delivery } : {}),
					},
					{ user: true },
				);
				if (!sent.success) return fail(sent.error ?? "The conversation did not take the answer", 409);
				return json({ question: unattendedMode.questions.answer(asked.id, answer) });
			} catch (e) {
				if (e instanceof QuestionError) return fail(e.message, 409);
				const info = errorInfoOf(e);
				return fail(`The answer could not be sent: ${(e as Error).message}`, 409, info ?? undefined);
			} finally {
				answering.delete(asked.id);
				if (unattendedMode.questions.get(asked.id)?.state === "open") pool.rewriteUnattended();
			}
		}
		case "/api/questions/dismiss": {
			// The person has no answer for it: nothing is sent to the conversation, and the question leaves the open list.
			if (req.method !== "POST") return fail("POST required", 405);
			const body = (await req.json().catch(() => null)) as unknown;
			try {
				return json({ question: unattendedMode.questions.dismiss(isRecord(body) ? body.id : undefined) });
			} catch (e) {
				if (e instanceof QuestionError) return fail(e.message, e.problem === "unknown" ? 404 : 409);
				throw e;
			}
		}
		case "/api/unattended": {
			// The instruction the main agent is told while a conversation is unattended (Settings › Unattended mode). Every page
			// may read it; a change is made on this computer only, as the model guidance's templates are: what it says is put into
			// the system prompt of every conversation that is unattended (see `isLocalOnlyRoute`).
			if (req.method === "POST") {
				if (!onThisComputer.has(req)) return fail("The instruction is changed on the computer omp-webui runs on", 403);
				const body = (await req.json().catch(() => null)) as unknown;
				const text = isRecord(body) ? body.instruction : undefined;
				if (text !== null && typeof text !== "string") return fail("Not an instruction", 422);
				try {
					const settings = unattendedMode.setInstruction(text);
					// What a conversation that is unattended is told changes at its next turn.
					pool.rewriteUnattended();
					return json(settings);
				} catch (e) {
					if (e instanceof InstructionError) return fail(instructionProblemText(e.problem), 422);
					return fail(`Could not save the instruction: ${(e as Error).message}`, 500);
				}
			}
			return json(unattendedMode.settings());
		}
		case "/api/unattended/session": {
			// Whether one conversation is unattended, by its live id (`live`), or what was kept for a session file that has no
			// process now (`file`).
			const liveId = q.get("live");
			if (liveId !== null) {
				const live = pool.get(liveId);
				if (!live || live.info.exited) return fail("Live session not found", 404);
				return json({ on: live.unattendedChoice, unattended: live.info.unattended ?? null });
			}
			const file = store.resolveSessionPath(q.get("file") ?? "");
			if (!file) return fail("Unknown session file", 404);
			return json({ on: pool.keptUnattended(file), unattended: null });
		}
		case "/api/unattended/live": {
			// One conversation is turned unattended, or back. It reaches the process's next turn without a restart when its omp
			// runs the extension, and is kept for its next opening either way. Every page may do it, a phone's included: it is
			// the person leaving the desk, and what the agent is told is the instruction as set on this computer.
			if (req.method !== "POST") return fail("POST required", 405);
			const body = (await req.json().catch(() => null)) as unknown;
			const live = isRecord(body) && typeof body.liveId === "string" ? pool.get(body.liveId) : undefined;
			if (!live || live.info.exited) return fail("Live session not found", 404);
			if (!isRecord(body) || typeof body.on !== "boolean") return fail("on must be true or false", 422);
			try {
				return json({ on: body.on, unattended: live.setUnattended(body.on) ?? null });
			} catch (e) {
				return fail(`Could not change unattended mode: ${(e as Error).message}`, 409);
			}
		}
		case "/api/session/rename":
		case "/api/session/delete": {
			if (req.method !== "POST") return fail("POST required", 405);
			const body = (await req.json()) as { file?: unknown; title?: unknown };
			const file = typeof body.file === "string" ? store.resolveSessionPath(body.file) : null;
			if (!file) return fail("Unknown session file", 404);
			const target = await sessionTarget(file);
			try {
				if (p === "/api/session/rename") {
					const title = typeof body.title === "string" ? body.title.trim() : "";
					if (!title) return fail("Title required");
					await actions.rename(target, title);
				} else {
					await actions.delete(target);
					archived.set([file], false);
				}
			} catch (e) {
				// Working, asking or paused, or open in a terminal's omp: nothing was touched, and the conversation goes on.
				if (e instanceof SessionBusyError || e instanceof SessionOpenElsewhereError) return fail(e.message, 409);
				throw e;
			}
			await store.refresh(true);
			return json({ ok: true });
		}
		case "/api/sessions/delete": {
			// Bulk delete through omp, one session at a time; reports per-file failures.
			if (req.method !== "POST") return fail("POST required", 405);
			const body = (await req.json()) as { files?: unknown };
			if (!Array.isArray(body.files) || !body.files.every((f) => typeof f === "string")) return fail("files required");
			const deleted: string[] = [];
			const failed: { file: string; error: string }[] = [];
			for (const requested of body.files as string[]) {
				const file = store.resolveSessionPath(requested);
				if (!file) {
					failed.push({ file: requested, error: "Unknown session file" });
					continue;
				}
				try {
					await actions.delete(await sessionTarget(file));
					deleted.push(file);
				} catch (e) {
					failed.push({ file, error: (e as Error).message });
				}
			}
			archived.set(deleted, false);
			await store.refresh(true);
			return json({ deleted, failed });
		}
		case "/api/archive":
			if (req.method === "POST") {
				const body = (await req.json()) as { files?: unknown; archived?: unknown };
				if (!Array.isArray(body.files)) return fail("files required");
				const files = body.files.map((f) => (typeof f === "string" ? store.resolveSessionPath(f) : null));
				if (files.some((f) => !f)) return fail("Unknown session file", 404);
				return json(archived.set(files as string[], body.archived === true));
			}
			return json(archived.list());
		case "/api/project-groups":
		case "/api/project-groups/create":
		case "/api/project-groups/rename":
		case "/api/project-groups/collapse":
		case "/api/project-groups/move":
		case "/api/project-groups/reorder":
		case "/api/project-groups/delete": {
			// The sidebar's project groups (#636): writable from every page that holds the token, as the pins and the archive
			// are (they are how a page looks at the list, not a setting of this computer), and never touching a folder.
			if (p === "/api/project-groups" && req.method !== "POST") return json(projectGroups.list());
			if (req.method !== "POST") return fail("POST required", 405);
			const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
			const id = typeof body.id === "string" ? body.id : "";
			try {
				switch (p) {
					case "/api/project-groups/create":
						return json(await projectGroups.create(typeof body.name === "string" ? body.name : ""));
					case "/api/project-groups/rename":
						return json(await projectGroups.rename(id, typeof body.name === "string" ? body.name : ""));
					case "/api/project-groups/collapse":
						return json(await projectGroups.setCollapsed(id, body.collapsed === true));
					case "/api/project-groups/move":
						return json(
							await projectGroups.move(
								typeof body.cwd === "string" ? body.cwd : "",
								typeof body.group === "string" ? body.group : null,
								typeof body.at === "number" ? body.at : null,
							),
						);
					case "/api/project-groups/reorder":
						return json(await projectGroups.reorder(id, typeof body.delta === "number" && body.delta < 0 ? -1 : 1));
					default:
						// No DELETE from a page's button without a body: the id names the group either way.
						return json(await projectGroups.remove(id));
				}
			} catch (e) {
				if (e instanceof ProjectGroupError) return fail(e.message, e.status, errorInfoOf(e) ?? undefined);
				throw e;
			}
		}
	}
	if (p.startsWith("/api/migrate/")) return (await (await migrateService()).handle(req, url)) ?? fail("Not found", 404);
	if (p === "/api/memory" || p.startsWith("/api/memory/")) return (await memoryService()).handle(req, url);
	// Ask agent for help (local-only: `isLocalOnlyRoute`, refused to any other page in `route`).
	if (p === "/api/settings-help" || p.startsWith("/api/settings-help/"))
		return handleSettingsHelp(req, url, settingsHelp, onThisComputer.has(req), { json, fail });
	// Not local-only (phones come in through the tunnel): the token (or Access) is the gate, as for the conversations.
	if (p === PUSH_API || p.startsWith(`${PUSH_API}/`))
		return (await pushService()).handle(req, url, { remote: remoteOf.has(req) });
	if (p === "/api/omp" || p.startsWith("/api/omp/")) return omp.handle(req, url);
	if (p === "/api/update" || p.startsWith("/api/update/")) return (await appUpdater()).handle(req, url);
	const remoteAnswer = await remoteAuth.handle(req, url, peer);
	if (remoteAnswer) return remoteAnswer;
	const macsAnswer = await savedMacs.handle(req, url, peer);
	if (macsAnswer) return macsAnswer;
	if (p.startsWith("/api/folder/")) {
		return folder.handle(req, url, {
			cwdOf: conversationCwd,
			marks: (cwd, fresh) => git.marks(cwd, { fresh }),
			changes: (cwd, fresh) => git.changes(cwd, { fresh }),
			diff: (cwd, path) => git.diff(cwd, path),
			local: onThisComputer.has(req),
			transfer: (r, u) => folder.transfer(r, u, { cwdOf: conversationCwd }, transferEnv(req, peer)),
			env: () => transferEnv(req, peer),
		});
	}
	if (p === "/api/upload") {
		// What this computer lets a page that is not on it do with files (Settings › Remote access › File transfer) applies to the
		// composer's upload as well: a page that may not send files here does not send them by this route either.
		if (!onThisComputer.has(req) && remoteAuth.fileTransfer() !== "full") {
			return json(
				{ error: "Receiving files is switched off on this computer", code: "off" } satisfies UploadFailure,
				403,
			);
		}
		// Loaded on the first upload: a page that never sends a file does not have its code in memory.
		const { handleUpload } = await import("./upload.ts");
		// Every omp-webui's data folder, this one's first: the app's is in Application Support, the web version's in `~/.omp-webui`.
		return handleUpload(req, url, { cwdOf: conversationCwd, dataDirs: [cfg.dataDir, ...knownDataDirs()] });
	}
	if (p === "/api/model-config" || p.startsWith("/api/model-config/")) return handleModelConfig(req, url, cfg);
	if (p.startsWith("/api/controls/")) {
		// Loaded on the first request: the toggles, the todo list and the session defaults are read when a panel opens (#585).
		const { handleControls } = await import("./omp/controls.ts");
		return handleControls(req, url, { cfg, pool, store });
	}
	if (p.startsWith("/api/blob/")) {
		const hash = p.slice("/api/blob/".length);
		if (!/^[a-f0-9]{64}$/.test(hash)) return fail("Bad blob id");
		const f = join(cfg.agentDir, "blobs", hash);
		if (!existsSync(f)) return fail("Not found", 404);
		return new Response(Bun.file(f), {
			headers: { "cache-control": "max-age=31536000, immutable" },
		});
	}
	if (p === "/api/export" && req.method === "POST") {
		const file = store.resolveSessionPath(q.get("file") ?? "");
		if (!file) return fail("Unknown session file", 404);
		const { exportSession } = await import("./export.ts");
		const { name, html } = await exportSession(cfg.ompBin, cfg.dataDir, file);
		return new Response(html, {
			headers: {
				"content-type": "text/html",
				"content-disposition": `attachment; filename="${name}"`,
			},
		});
	}
	return fail("Not found", 404);
}

// ------------------------------------------------------------------ websocket

async function handle(ws: Bun.ServerWebSocket<WsData>, msg: ClientMessage): Promise<void> {
	const reply = (m: ServerMessage): void => {
		ws.data.out?.send(JSON.stringify(m));
	};
	const attach = (live: Live) => {
		if (!ws.data.local) remoteTouched.add(live.info.liveId);
		if (ws.data.closed) return;
		live.subscribers.add(ws.data.sub);
		ws.data.attached.add(live.info.liveId);
		pool.announce(live);
	};
	// A conversation a remote page sends anything to is noted, so that the AI help's tools stay refused on it (`remoteTouched`).
	const touch = (live: Live): void => {
		if (!ws.data.local) remoteTouched.add(live.info.liveId);
	};
	switch (msg.t) {
		case "open": {
			let target = msg.target;
			if (target.kind === "new" && target.guard !== undefined) {
				// A conversation's own guard settings are changed on the computer omp-webui runs on, like the global ones (see
				// `isLocalOnlyRoute`): a page that is not this computer's starts it under the global settings.
				if (!ws.data.local)
					return reply({
						t: "reply",
						req: msg.req,
						ok: false,
						error: "The guard is changed on the computer omp-webui runs on",
					});
				try {
					target = {
						...target,
						guard: applyGuardOverridePatch(null, parseGuardOverridePatch(target.guard)) ?? undefined,
					};
				} catch (e) {
					if (e instanceof GuardConfigError) return reply({ t: "reply", req: msg.req, ok: false, error: e.message });
					throw e;
				}
			}
			if (target.kind === "new" && target.guidance !== undefined) {
				// What a template says is authored on this computer; text typed by a page goes into the system prompt of a new
				// conversation's main agent, so it is for a page on this computer only, as `/api/model-guidance/live` is. A page
				// that is not this computer's may name a template (the text it stands for is the store's) but not write one.
				let asked: SessionGuidance | null;
				try {
					asked = parseSessionGuidance(target.guidance);
				} catch (e) {
					return reply({ t: "reply", req: msg.req, ok: false, error: (e as Error).message });
				}
				if (!ws.data.local && asked?.text) {
					if (!asked.template)
						return reply({
							t: "reply",
							req: msg.req,
							ok: false,
							error: "The model guidance is written on the computer omp-webui runs on",
						});
					asked = { template: asked.template };
				}
				target = { ...target, guidance: asked ?? undefined };
			}
			const live = await pool.open(target, cwdOfSessionFile);
			attach(live);
			reply({ t: "reply", req: msg.req, ok: true, data: live.attached() });
			if (!ws.data.closed) live.resync(ws.data.sub);
			return;
		}
		case "attach": {
			const live = pool.get(msg.liveId);
			if (!live) {
				// The process is gone. The server may still know how it ended: the idle reaper closes the processes
				// nobody watches, so the frame that says so reached no page, and the page must not be left to guess
				// (nor to blame the server for a process that crashed on its own) (#515).
				const ended = pool.exitOf(msg.liveId);
				if (!ended)
					return reply({
						t: "reply",
						req: msg.req,
						ok: false,
						error: "Live session not found",
					});
				// The process is gone, and how it ended is what the page asked for: the end is told with the process's
				// own info, so that the page can show the conversation it was.
				return reply({
					t: "reply",
					req: msg.req,
					ok: true,
					data: { ...ended.info, exited: true, exit: ended.exit } satisfies LiveAttached,
				});
			}
			attach(live);
			reply({ t: "reply", req: msg.req, ok: true, data: live.attached() });
			live.resync(ws.data.sub);
			return;
		}
		case "detach": {
			const live = pool.get(msg.liveId);
			ws.data.attached.delete(msg.liveId);
			if (live) {
				live.subscribers.delete(ws.data.sub);
				pool.announce(live);
			}
			return;
		}
		case "close": {
			// A paused (frozen) omp runs again to read the closed stdin and exit; one paused mid-turn is stopped (`Live.end`).
			await pool.get(msg.liveId)?.end();
			return reply({ t: "reply", req: msg.req, ok: true });
		}
		case "rpc": {
			const live = pool.get(msg.liveId);
			if (!live)
				return reply({
					t: "reply",
					req: msg.req,
					ok: false,
					error: "Live session not found",
				});
			// A message the person at this Mac sends is theirs to answer for: it lifts what a remote page left on the conversation.
			if (ws.data.local && (msg.command.type === "prompt" || msg.command.type === "steer"))
				remoteTouched.delete(live.info.liveId);
			// The turn this message starts (or steers) is its sender's: a remote page's when the sender came in through the
			// tunnel, and then "Confirm risky commands from remote pages" asks about its risky calls; a page on this computer
			// takes the turn back. A page that only looks at the conversation never has a turn (it sends nothing).
			if (drivesTurn(msg.command)) {
				const refusal = turnRefusal(live, !ws.data.local);
				if (refusal) return reply({ t: "reply", req: msg.req, ok: false, error: refusal });
			}
			touch(live);
			const call = {
				user: msg.user === true,
				written: msg.ack === true ? () => reply({ t: "ack", req: msg.req }) : undefined,
			};
			// The Stop button's commands (marked by the page: `stop`) are carried through until the conversation has stopped, or its
			// omp has been ended (`Live.stop`); the same command from anywhere else (cancelling an interview) is omp's plain one.
			// A side question on the model the person chose for them is answered by a process of the server's, not by this one.
			const stopKind = msg.stop === true ? stopKindOf(msg.command) : null;
			const r = stopKind
				? await live.stop(stopKind, msg.command)
				: ((await sideQuestions.rpc(live, msg.command, call)) ?? (await live.rpc(msg.command, call)));
			// A slim answer: what the client does not read of it is left out (see `shared/slim.ts`). A routine state read
			// carries the whole system prompt and every tool's schema, tens of KB, for a page that reads neither: what
			// it wants of the tools is their names. The answer is read here (the client would read it too, out of the
			// parts) and sent slim, in one message: what is left is small.
			if (r.success && msg.slim === true) {
				return reply({ t: "reply", req: msg.req, ok: true, data: slimAnswer(r.data) });
			}
			// A large answer (a whole conversation) is passed on as the text omp wrote: reading it into objects and writing
			// it out again would hold up every other request for as long as that takes (see `splitResponse`). It goes in
			// parts, in one go: the page hears each as it arrives, which a connection that is slow to carry it needs to be
			// taken for alive (see `shared/reply-parts.ts`), and nothing else is sent between them.
			if (r.success && r.rawData !== undefined) {
				for (const part of replyMessages(msg.req, r.rawData)) ws.data.out?.send(part);
				return;
			}
			if (r.success) return reply({ t: "reply", req: msg.req, ok: true, data: r.data });
			return reply({
				t: "reply",
				req: msg.req,
				ok: false,
				error: r.error ?? "failed",
				code: r.code,
			});
		}
		case "ui_response": {
			const live = pool.get(msg.liveId);
			if (!live) return;
			touch(live);
			live.respondUI(msg.response);
			return;
		}
		case "list_lives":
			// The processes the server holds. A process that has ended is not among them: it is gone, and how it
			// ended is said in the `live` frame every page is told of, and in the reply to an `attach` for it (#515).
			return reply({ t: "reply", req: msg.req, ok: true, data: pool.list() });
		case "pause":
		case "resume": {
			const live = pool.get(msg.liveId);
			if (!live) return reply({ t: "reply", req: msg.req, ok: false, error: "Live session not found" });
			touch(live);
			if (msg.t === "pause") await live.pause();
			else await live.resume();
			return reply({ t: "reply", req: msg.req, ok: true, data: live.info });
		}
		case "approval_mode": {
			const live = pool.get(msg.liveId);
			if (!live) return reply({ t: "reply", req: msg.req, ok: false, error: "Live session not found" });
			if (!isApprovalMode(msg.mode)) return reply({ t: "reply", req: msg.req, ok: false, error: "Bad approval mode" });
			touch(live);
			await live.setApprovalMode(msg.mode);
			return reply({ t: "reply", req: msg.req, ok: true, data: live.info });
		}
		case "set_mode": {
			const live = pool.get(msg.liveId);
			if (!live) return reply({ t: "reply", req: msg.req, ok: false, error: "Live session not found" });
			if (!isMode(msg.mode)) return reply({ t: "reply", req: msg.req, ok: false, error: "Bad mode" });
			// A page that is not on this computer may do this: it may open and restart conversations already, and the mode of a
			// conversation is no more than that (`/api/mode` is not a local-only route either).
			touch(live);
			return reply({ t: "reply", req: msg.req, ok: true, data: await pool.switchMode(live, msg.mode) });
		}
		case "model_preset": {
			const live = pool.get(msg.liveId);
			if (!live) return reply({ t: "reply", req: msg.req, ok: false, error: "Live session not found" });
			if (typeof msg.name !== "string") return reply({ t: "reply", req: msg.req, ok: false, error: "Bad preset name" });
			touch(live);
			await live.setModelPreset(msg.name, { user: true });
			return reply({ t: "reply", req: msg.req, ok: true, data: live.info });
		}
		case "retry_now": {
			const live = pool.get(msg.liveId);
			if (!live) return reply({ t: "reply", req: msg.req, ok: false, error: "Live session not found" });
			touch(live);
			await live.retryNow();
			return reply({ t: "reply", req: msg.req, ok: true, data: live.info });
		}
		case "quota_override": {
			const live = pool.get(msg.liveId);
			if (!live) return reply({ t: "reply", req: msg.req, ok: false, error: "Live session not found" });
			if (typeof msg.on !== "boolean")
				return reply({ t: "reply", req: msg.req, ok: false, error: "on must be true or false" });
			touch(live);
			live.setQuotaOverride(msg.on);
			return reply({ t: "reply", req: msg.req, ok: true, data: live.info });
		}
		case "compact_queue":
		case "compact_cancel": {
			const live = pool.get(msg.liveId);
			if (!live) return reply({ t: "reply", req: msg.req, ok: false, error: "Live session not found" });
			touch(live);
			if (msg.t === "compact_queue") await live.queueCompact(msg.customInstructions, msg.where);
			else await live.cancelCompact();
			return reply({ t: "reply", req: msg.req, ok: true, data: live.info });
		}
		case "soft_stop": {
			const live = pool.get(msg.liveId);
			if (!live) return reply({ t: "reply", req: msg.req, ok: false, error: "Live session not found" });
			touch(live);
			live.setSoftStop(msg.on === true);
			return reply({ t: "reply", req: msg.req, ok: true, data: live.info });
		}
		case "pty_open": {
			const shell = msg.shell === true;
			// A shell for a page that is not on this computer is the person's to allow (Settings › Remote access): the login
			// shell, and omp's own shell console (`omp shell`), which is one too (#682).
			if ((shell || (Array.isArray(msg.args) && runsOmpShell(msg.args))) && !ws.data.local && !remoteAuth.remoteShell())
				return reply({ t: "reply", req: msg.req, ok: false, error: REMOTE_SHELL_OFF });
			// A terminal's omp would write the same files an import is writing.
			if (!shell && importWriting) throw heldByImport();
			// `omp -c`, `--resume <session>` … in the terminal: free the session from our own omp first.
			if (!shell) for (const resumed of resumedSessions(msg.args, terminalDir(msg.cwd))) await pool.release(resumed);
			// Its page may have gone while that waited: nobody would ever feed, resize or end a terminal made for it now.
			if (ws.data.closed) return;
			const id = ptys.open(ws.data.sub, msg.args, msg.cwd, msg.cols, msg.rows, {
				shell,
				remote: !ws.data.local,
				tag: msg.tag,
			});
			return reply({ t: "reply", req: msg.req, ok: true, data: { ptyId: id } });
		}
		case "pty_held":
			// Only this computer's pages are given the terminals the app's window left behind (see `PtyManager.expectDetach`).
			return reply({ t: "reply", req: msg.req, ok: true, data: { terminals: ws.data.local ? ptys.held() : [] } });
		case "pty_attach": {
			const taken = ws.data.local ? ptys.attach(ws.data.sub, msg.ptyId) : null;
			if (!taken) return reply({ t: "reply", req: msg.req, ok: false, error: "That terminal is gone" });
			return reply({ t: "reply", req: msg.req, ok: true, data: taken });
		}
		// Only to the page's own terminals: an id is not a key (#682).
		case "pty_input":
			return ptys.input(ws.data.sub, msg.ptyId, msg.data);
		case "pty_resize":
			return ptys.resize(ws.data.sub, msg.ptyId, msg.cols, msg.rows);
		case "pty_kill":
			return ptys.kill(ws.data.sub, msg.ptyId);
		case "pty_clear":
			return ptys.clear(ws.data.sub, msg.ptyId);
		case "folder_watch": {
			const owner = ws.data;
			return folder.watch(
				owner,
				() => conversationCwd(msg.live ?? null, msg.file ?? null),
				msg.dirs,
				(root) => {
					if (!ws.data.closed) reply({ t: "folder_changed", root });
				},
				() => !ws.data.closed,
			);
		}
		case "host_watch": {
			// The load is the same for a remote page as for one here: what it shows is the computer's own, none of its files or commands.
			if (msg.on !== true || ws.data.closed) return host.unwatch(ws.data);
			return host.watch(ws.data, {
				detail: msg.detail === true,
				procs: msg.procs === true,
				send: reply,
			});
		}
		case "presence": {
			// Whether a page of a device that has push on is in use, and which conversation it shows (`shared/push.ts`). Nothing is kept
			// until the hub is loaded: it loads when a page asks about push, and that page says where it stands right after.
			if (typeof msg.device !== "string" || typeof msg.visible !== "boolean" || ws.data.closed) return;
			// A page that names neither says nothing of what it shows (one of a build from before it did): it shows every conversation.
			const names = "liveId" in msg || "file" in msg;
			const shown = names
				? {
						liveId: typeof msg.liveId === "string" ? msg.liveId : null,
						file: typeof msg.file === "string" ? msg.file : null,
					}
				: undefined;
			return pushHub?.presence(ws.data, msg.device, msg.visible, shown);
		}
	}
}

/**
 * The page, with the preferences in it (see UiPrefs.inject), so that it can apply them before it first paints. Only
 * to a request that holds the access token: the document itself is served to anyone, and the preferences are not for
 * just anyone. Never cached: a copy kept by the browser would put an older state back.
 */
async function serveIndex(req: Request, file: string): Promise<Response> {
	if (!auth.allowed(req) && !givesCookie(req)) return serveStatic(req, file, false);
	const html = uiPrefs.inject(await Bun.file(file).text());
	return compressResponse(
		req,
		new Response(html, { headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-store" } }),
	);
}

/** Everything but the WebSocket (`undefined`: the request became one). */
async function route(req: Request, srv: Bun.Server<WsData>): Promise<Response | undefined> {
	// A request to the public hostname is let in only with a valid Access token (see `RemoteAuth.verify`); it is no local
	// request, and a local request needs no token of Cloudflare's.
	const remote = await remoteAuth.verify(req);
	const peer = srv.requestIP(req)?.address;
	const local = !remote && isThisComputer(req, peer);
	if (local) onThisComputer.add(req);
	if (remote) remoteOf.set(req, remote);
	else if (remoteAuth.isPublicHost(req.headers.get("host")) || !trusted(req))
		return new Response("Forbidden", { status: 403 });
	const url = new URL(req.url);
	// The API and the socket answer a page of this origin only; the page itself (and the token link) is served to anyone.
	const isApi = url.pathname === "/ws" || url.pathname.startsWith("/api/");
	if (isApi && !fromOwnPage(req)) return new Response("Forbidden", { status: 403 });
	// What guards the agent and what it decided, the tunnel's settings, the app's updates and moving to another computer
	// are the person's at this computer (see `isLocalOnlyRoute`): a page that is not on it must never be able to
	// reconfigure what it came in through, switch the guard off, replace the app, nor carry every conversation (and, with a
	// password, every login) away, nor rewrite the user's files from an uploaded archive. That is the socket's say (see
	// `isThisComputer`), not the bind address's: a server that listens on a network address answers the people on that
	// network, and they are not this computer. Nor is the token any proof of it: it is what a page on the network has.
	if (!local && isLocalOnlyRoute(url.pathname)) return new Response("Forbidden", { status: 403 });
	// The token link and the token itself are not for a page that came in through the tunnel: it has its Access login and
	// is given the cookie. A page on the network exchanges the token it has for the cookie, as it would on this computer:
	// refusing it would leave a browser there no way to sign in, and it protects nothing, for what the token opens is
	// open to the page that holds it.
	if (remote && (url.searchParams.has("token") || url.pathname === "/api/auth"))
		return new Response("Forbidden", { status: 403 });
	// `/?token=…` (the link printed at startup) exchanges the token for a cookie.
	const offered = url.searchParams.get("token");
	if (offered !== null && auth.enabled) {
		if (!auth.matches(offered)) return new Response("Invalid token", { status: 401 });
		url.searchParams.delete("token");
		return new Response(null, {
			status: 303,
			headers: {
				location: `${url.pathname}${url.search}${url.hash}`,
				"set-cookie": auth.cookieHeader(viaTunnel(req)),
			},
		});
	}
	if (url.pathname === "/api/auth" && req.method === "POST") {
		const body = (await req.json().catch(() => ({}))) as { token?: unknown };
		if (!auth.matches(typeof body.token === "string" ? body.token : null)) return fail("Invalid token", 401);
		return new Response(JSON.stringify({ ok: true }), {
			headers: { "content-type": "application/json", "set-cookie": auth.cookieHeader(viaTunnel(req)) },
		});
	}
	if (isApi && !auth.allowed(req)) return fail("Unauthorized: open the link printed by the server", 401);
	if (url.pathname === "/ws") {
		const sub: Subscriber = { send: () => {} };
		const data: WsData = {
			sub,
			attached: new Set(),
			out: null,
			closed: false,
			remote,
			local,
			expiry: undefined,
			ping: undefined,
		};
		if (srv.upgrade(req, { data })) return undefined;
		return new Response("Upgrade failed", { status: 400 });
	}
	// A response that does not end, for the macOS app on this computer (refused to any other page above, see `isLocalOnlyRoute`):
	// not held back to be compressed.
	if (url.pathname === SHELL_EVENTS_PATH && req.method === "GET") return shellEvents.serve(req);
	// The same response for the macOS app of another Mac (#656): let in as a window onto this Mac is, with the Access token and
	// the access-token cookie both of which it presented (`remote` is set only for a request that passed Access, and a request
	// with no token was refused above), or from a page on this computer. A page on the network is neither, and is refused.
	if (url.pathname === NOTIFY_EVENTS_PATH && req.method === "GET") {
		if (!remote && !local) return new Response("Forbidden", { status: 403 });
		return shellEvents.serve(req, remote ?? undefined);
	}
	if (url.pathname.startsWith("/api/")) {
		if (req.method !== "GET" && req.headers.get("x-omp-webui") !== "1") return fail("Missing CSRF header", 403);
		try {
			return await compressResponse(req, await api(req, url, peer));
		} catch (e) {
			// Nobody reads the answer to a request its client dropped (a search typed past): not a failure to log.
			if (req.signal.aborted) return new Response(null, { status: 499 });
			if (e instanceof WorkerDeadlineError) {
				// A worker that gave no answer is no fault of the request: a retry gets a new worker.
				const busy = fail(e.message, 503);
				busy.headers.set("retry-after", "1");
				return busy;
			}
			return fail((e as Error).message, 500);
		}
	}
	// Static SPA from the Vite build.
	const index = join(cfg.distDir, "index.html");
	const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
	const file = resolve(cfg.distDir, rel);
	if (file.startsWith(cfg.distDir) && existsSync(file) && statSync(file).isFile()) {
		return file === index ? serveIndex(req, index) : serveStatic(req, file, url.pathname.startsWith("/assets/"));
	}
	// A hashed chunk that is gone (the app was rebuilt while a tab was open) must fail as a 404: answered
	// with index.html, `import()` of the chunk dies on its MIME type and the page cannot tell it was stale.
	if (url.pathname.startsWith("/assets/")) {
		return new Response("Not found", { status: 404, headers: { "cache-control": "no-store" } });
	}
	if (existsSync(index)) return serveIndex(req, index);
	return new Response("omp-webui: run `bun run build` first, or use `bun run dev`.", { status: 404 });
}

const listen = (hostname: string, port: number) =>
	Bun.serve<WsData>({
		hostname,
		port,
		idleTimeout: 0,
		// Development mode answers an error with an HTML page of source lines and the working directory (the user's home).
		development: false,
		// Without development mode Bun 1.4 shares the port with another process listening on it (SO_REUSEPORT): a second
		// copy of the app would then take half the requests of the first instead of moving to the next port.
		reusePort: false,
		async fetch(req, srv) {
			let res: Response | undefined;
			try {
				res = await route(req, srv);
			} catch (e) {
				// What went wrong is for the log, never for whoever asked: no message, no path (nor the query: it may hold the token).
				console.error(`omp-webui: ${req.method} ${new URL(req.url).pathname} failed:`, e);
				res = fail("Internal server error", 500);
			}
			if (!res) return res;
			// Only a document can run its inline scripts: the hashes are for the HTML served (index.html).
			const scripts = res.headers.get("content-type")?.startsWith("text/html") ? indexScriptHashes(cfg.distDir) : [];
			// A response that carries a policy of its own keeps it: a file that is sent for saving is sandboxed (see `attachmentHeaders`).
			if (!res.headers.has("content-security-policy"))
				res.headers.set("content-security-policy", contentSecurityPolicy(req.headers.get("host"), scripts));
			// A remote page that passed the Access check is given the access-token cookie (see `givesCookie`).
			if (res.status < 400 && givesCookie(req)) res.headers.append("set-cookie", auth.cookieHeader(true));
			return res;
		},
		websocket: {
			// Bun closes the socket on a message over its default of 16 MiB, which a prompt with a few large images is.
			maxPayloadLength: MAX_WS_MESSAGE_BYTES,
			open(ws) {
				const out = new WsOutbox(ws);
				ws.data.out = out;
				ws.data.sub.send = (m) => out.send(JSON.stringify(m));
				sockets.add(ws);
				// The keepalive first: an Access token already past its end closes the socket inside watchAccess, and the
				// close handler must find the interval to clear.
				if (ws.data.remote) ws.data.ping = setInterval(() => ws.ping(), remotePing);
				watchAccess(ws);
				out.send(
					JSON.stringify({
						t: "hello",
						ompVersion: version,
						serverVersion: SERVER_VERSION,
						time: Date.now(),
					} satisfies ServerMessage),
				);
				// The app's own updates, to a local page that opens while there is something to show (nothing loads for it).
				if (ws.data.local && updater?.worthShowing()) {
					out.send(JSON.stringify({ t: "app_update", state: updater.state() } satisfies ServerMessage));
				}
			},
			// Bun's socket has taken what it was holding: the outbox sends what it held back.
			drain(ws) {
				ws.data.out?.drain();
			},
			async message(ws, raw) {
				// The backstop of the timer: a remote page whose token has run out is heard no more.
				if (ws.data.remote && Date.now() >= ws.data.remote.validUntil) {
					ws.close(ACCESS_EXPIRED, "Access session expired");
					return;
				}
				let msg: ClientMessage;
				try {
					const parsed: unknown = JSON.parse(String(raw));
					// `null`, a number, a string, an array: valid JSON that is no message. Reading `.t` of `null` throws, and so
					// would the `"req" in msg` of the handler below, outside of any `try`: the whole server would end.
					if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
					msg = parsed as ClientMessage;
				} catch {
					return;
				}
				try {
					await handle(ws, msg);
				} catch (e) {
					if ("req" in msg)
						ws.data.out?.send(
							JSON.stringify({
								t: "reply",
								req: msg.req,
								ok: false,
								error: e instanceof Error ? e.message : String(e),
								// The code and parameters of an error the page words itself (Light on a local server that cannot start).
								...errorInfoOf(e),
							}),
						);
				}
			},
			close(ws) {
				ws.data.closed = true;
				clearTimeout(ws.data.expiry);
				clearInterval(ws.data.ping);
				ws.data.out?.abandon();
				sockets.delete(ws);
				// A page of this computer that closes right after the app said it is going to the background leaves its terminals.
				ptys.dropOwner(ws.data.sub, ws.data.local);
				folder.drop(ws.data);
				host.unwatch(ws.data);
				pushHub?.dropOwner(ws.data);
				for (const id of ws.data.attached) {
					const live = pool.get(id);
					if (live) {
						live.subscribers.delete(ws.data.sub);
						pool.announce(live);
					}
				}
			},
		},
	});

// The macOS app: clear our own leftover server first, and never fail on a taken port.
if (cfg.autoPort) await stopStaleServer(cfg.dataDir);
// Conversations a former server left paused are paused here again, before anything is served.
const adopted = await pool.adopt();
if (adopted > 0) console.log(`omp-webui: took over ${adopted} paused conversation(s) from an earlier run`);
/**
 * Bind the preferred port; in app mode, when it is taken (the web version, another program),
 * the next free one of the following 20 — the same port on every launch while the occupant
 * stays, so the app's origin (and its stored preferences) does not change — and only then
 * any free port.
 */
function bind(): ReturnType<typeof listen> {
	const candidates = cfg.autoPort ? [...Array.from({ length: 21 }, (_, i) => cfg.port + i), 0] : [cfg.port];
	for (const p of candidates) {
		try {
			return listen(cfg.host, p);
		} catch (e) {
			if (!cfg.autoPort || (e as { code?: string }).code !== "EADDRINUSE") throw e;
		}
	}
	throw new Error("No free port");
}
const server = bind();
const port = server.port as number;
remotePort = port;
// A server bound to a network address has no page on this computer unless it listens on the loopback too: whether a page
// that comes in there is this computer's is still the peer's say (`isThisComputer`), as it is on every listener.
const loopback = needsLoopbackListener(cfg.host) ? listenOnLoopback(port, listen) : null;
const noLoopback = loopbackRequiredByApp(cfg, loopback);
if (noLoopback) {
	server.stop(true);
	throw noLoopback;
}
loopbackPort = loopback?.port ?? 0;
// The gates of the conversations that were taken over before the server had a port are told it now.
pool.syncRisk();
recordServer(cfg.dataDir, port, cfg.parentPid, loopback?.moved ? loopback.port : undefined);
omp.start();
host.start();
// Web Push: devices that were subscribed before this server started are pushed to from the first conversation on.
if (existsSync(join(cfg.dataDir, "push-devices.json"))) {
	void pushService().catch((e: unknown) => console.warn(`omp-webui: Web Push: ${(e as Error).message}`));
}
// The app's own updates (#571): a look soon after start and every six hours, and an update that was handed to the helper
// before this server started is found at once (the helper waits for this server to say it is up). Loaded on first use.
if (automaticAppUpdates) {
	const first = setTimeout(
		() =>
			void appUpdater()
				.then((u) => u.start())
				.catch((e) => console.warn(`omp-webui: updates: ${(e as Error).message}`)),
		Number(process.env.OMP_WEBUI_APP_UPDATE_FIRST_MS) || 20_000,
	);
	first.unref();
}
if (
	existsSync(join(cfg.dataDir, "update", "handover.json")) ||
	existsSync(join(cfg.dataDir, "update", "result.json"))
) {
	void appUpdater().catch((e) => console.warn(`omp-webui: updates: ${(e as Error).message}`));
}
// Remote access turned off, or its settings changed (another team, application, hostname, allow-list): the remote pages
// that came in under the old ones are closed, and come back through the Access check again; their conversations go on as
// they were. A switch that does not decide who comes in (confirm risky commands, file transfer, shells) is read where it
// applies, and closes nothing: a remote page's request is answered across it. The file is looked at once a second, as
// requests look at it.
remoteAuth.onChange(() => {
	for (const ws of [...sockets]) if (ws.data.remote) ws.close(1008, "Remote access changed");
	shellEvents.closeRemote();
});
// The remote chain is loaded only when remote access is used (see `LazyRemote`); the settings are looked at as often
// as before, so a change of them is noticed either way.
// The same look tells every conversation's gate whether the setting for risky commands is on (see `Live.syncRisk`).
setInterval(() => {
	remoteAuth.settings();
	// The guard's settings file is the server's: one that was changed behind its back is written again.
	// Not while an import writes: it replaces this file with the person's own, which `after` then takes (`guardSettings.reload`).
	if (!importWriting) guardSettings.verify();
	// Nor is what each conversation chose of it to be taken from the file once the server has it: a planted Off is written over.
	// Not while an import writes: it replaces this file with the person's own, which `after` then takes (`approval.reload`).
	if (!importWriting) approval.verify();
	// The same goes for the record of a conversation the server keeps (see `LivePool.syncRisk`): an import's own records stay.
	pool.syncRisk();
	// What the gates decided since the last look, said to the pages on this computer.
	for (const decision of guardLog.poll()) broadcastLocal({ t: "guard_decision", decision });
}, 1000).unref();
remoteAuth.start();

let stopping: Promise<never> | null = null;
/**
 * Stop everything this server started, then exit. It runs once: a second signal, or the check for the app
 * (every second, while stopping can take longer) joins the shutdown under way instead of cutting it short.
 */
function shutdown(): Promise<never> {
	stopping ??= (async () => {
		let code = 0;
		try {
			// An omp install or update keeps going without this server (`OmpLifecycle.execute`): say so, don't end it.
			const job = omp.runningJob();
			if (job) console.log(`omp-webui: the omp ${job.kind} (${job.command}) keeps running in the background`);
			omp.stop();
			host.stop();
			updater?.stop();
			ptys.killAll();
			// `caffeinate` holds idle sleep off for this server alone (`-w`): it goes with it, and the sleep detector has
			// nothing left to watch (#647).
			keepAwake.stop();
			sleepDetector.stop();
			await sideQuestions.stop();
			await remoteAuth.stop();
			// Paused conversations stay, frozen, and ones waiting out a usage limit stay, going, in the background; everything
			// else ends.
			const kept = await pool.parkKept();
			if (kept > 0)
				console.log(`omp-webui: ${kept} conversation(s) (paused, or waiting out a usage limit) stay in the background`);
			await pool.shutdown();
			loopback?.server.stop(true);
			// What was being sent here is stopped, and the files that were not finished are removed.
			await folder.close();
			server.stop(true);
			// The databases are closed, and say so: the next start does not look at every page of them.
			store.close();
			forgetServer(cfg.dataDir);
		} catch (e) {
			code = 1;
			console.error("omp-webui: shutdown failed:", e);
		}
		process.exit(code);
	})();
	return stopping;
}
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => void shutdown());
// Ready only once a signal is answered: the app (or a test) stops the server the moment it reads the line below, and before
// a handler is installed a SIGTERM ends the process outright, leaving its record (`server.pid`) and its open databases behind.
// The address the server listens on, and the loopback one of a server bound to a network address (see `listenOnLoopback`).
const base = `http://${server.hostname}:${port}`;
console.log(`omp-webui listening on ${base} (omp ${version})`);
const hereBase = loopback ? `http://127.0.0.1:${loopback.port}` : null;
if (hereBase) {
	console.log(
		`omp-webui also listening on ${hereBase}: the page on this computer (the one on ${base} is the network's, a remote page)${loopback?.moved ? `; port ${port} was taken on 127.0.0.1` : ""}`,
	);
}
if (cfg.autoPort) {
	// The app that started us chose the token and holds it: it is never printed, where an alert or a log
	// could show it. The shell reads the port from this line, and it connects to 127.0.0.1: the loopback listener's
	// port when the server has one (it is the one that answers there), else the only port there is.
	console.log(`OMPW_READY ${JSON.stringify({ port: loopback?.port ?? port })}`);
} else if (!auth.token) {
	console.log("Authentication disabled (OMP_WEBUI_AUTH=off)");
} else if (hereBase) {
	console.log(`Open: ${hereBase}/?token=${auth.token}  (this computer)`);
	console.log(
		`Open: ${base}/?token=${auth.token}  (the network: a remote page, without what is for this computer alone)`,
	);
} else {
	console.log(`Open: ${base}/?token=${auth.token}`);
}

// After startup: an error while starting (a port that cannot be had, a corrupt database) still ends the process, with
// its message, which is what the app shows. From here on a stray error is logged and survived (see `crash-guard.ts`).
guardAgainstStrayErrors({ onStorm: () => void shutdown() });

// Started by the app shell: if it dies without stopping us (crash, force quit), stop too.
if (cfg.parentPid !== null) {
	const parent = cfg.parentPid;
	const check = setInterval(() => {
		try {
			process.kill(parent, 0);
		} catch {
			clearInterval(check);
			void shutdown();
		}
	}, 1000);
	check.unref();
}
