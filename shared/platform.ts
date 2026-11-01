/**
 * What the operating system the server runs on lets it do (`server/platform/`), as the server and the page see it. The
 * server derives the flags from the platform once (`platform.capabilities`); `/api/meta` hands them to the page, which
 * shows what a flag turns off rather than asking which system it is on. Tests skip by a flag too, not by an OS name.
 */

/** The systems the server has an adapter for (`process.platform`'s names). */
export type PlatformId = "darwin" | "linux" | "win32";

export interface Capabilities {
	/**
	 * Remote access: the Cloudflare tunnel, Cloudflare Access pages and pages over a network address. Off where the
	 * remote-risk classifier (`shared/remote-risk.ts`) does not know the system's paths and shells yet (Windows): a remote
	 * page's risky commands could not be told from harmless ones there.
	 */
	remoteAccess: boolean;
	/** omp and what it started end together: process groups (macOS, Linux), `taskkill /T` (Windows). */
	processTreeKill: boolean;
	/** A conversation's omp and everything under it can be frozen and thawed (Pause, parked conversations: SIGSTOP/SIGCONT). */
	pauseResume: boolean;
	/** omp runs behind a relay on a unix socket, so that a paused or waiting conversation outlives the server. */
	relay: boolean;
	/** The server can hold idle sleep off while a conversation works (`caffeinate`). */
	keepAwake: boolean;
	/** A page on this computer can open a file in its default app, reveal it, and open a folder (`open`, LaunchServices). */
	openFiles: boolean;
	/** Who holds omp's write lease on a session can be looked up on the system (`lsof`; Linux's `/proc`). */
	leaseHolders: boolean;
	/** The host indicator has a GPU figure (IOKit). */
	gpuLoad: boolean;
	/** A server not started from a terminal asks the login shell for the user's environment (`$SHELL -ilc`). */
	loginEnv: boolean;
	/** An install or update of omp that the server started outlives the server, and the next one learns how it ended. */
	jobSurvivesServer: boolean;
	/** The in-app updater (disk image, `codesign`, the app bundle swap). */
	appUpdate: boolean;
	/** The native app shell (Swift): its window, native notifications, file drops, pop-outs, the menu bar's background mode. */
	appShell: boolean;
}

/** The capabilities, by name. */
export type Capability = keyof Capabilities;
