import type { Capabilities, Capability, PlatformId } from "../../shared/platform.ts";

/**
 * What each system lets the server do (see `shared/platform.ts`). Pure data, with no import of a system module, so that a
 * test runner that is not Bun (Playwright's) can read it too.
 */
const CAPABILITIES: Record<PlatformId, Capabilities> = {
	darwin: {
		remoteAccess: true,
		processTreeKill: true,
		pauseResume: true,
		relay: true,
		keepAwake: true,
		openFiles: true,
		leaseHolders: true,
		gpuLoad: true,
		loginEnv: true,
		jobSurvivesServer: true,
		appUpdate: true,
		appShell: true,
	},
	linux: {
		remoteAccess: true,
		processTreeKill: true,
		pauseResume: true,
		relay: true,
		keepAwake: false,
		openFiles: false,
		leaseHolders: true,
		gpuLoad: false,
		loginEnv: true,
		jobSurvivesServer: true,
		appUpdate: false,
		appShell: false,
	},
	win32: {
		remoteAccess: false,
		processTreeKill: true,
		pauseResume: false,
		relay: false,
		keepAwake: false,
		openFiles: false,
		leaseHolders: false,
		gpuLoad: false,
		loginEnv: false,
		jobSurvivesServer: false,
		appUpdate: false,
		appShell: false,
	},
};

/** The capabilities of `id`, a copy of its own. */
export function capabilitiesFor(id: PlatformId): Capabilities {
	return { ...CAPABILITIES[id] };
}

/** `process.platform` as an adapter's name: a POSIX system without one of its own (a BSD) gets Linux's. */
export function platformIdOf(name: string): PlatformId {
	return name === "darwin" || name === "win32" ? name : "linux";
}

/**
 * The capabilities of the system this process runs on: `platform.capabilities`, for what cannot load the adapter (a
 * Playwright spec skips by it, and Playwright's runner is not Bun).
 */
export const capabilities: Capabilities = capabilitiesFor(platformIdOf(process.platform));

/**
 * Why a capability is off where it is: what an error says when something that needs it is asked for anyway. Every
 * capability that is false somewhere has a reason here (tests/unit/platform-adapter.test.ts keeps the list whole).
 */
export const UNAVAILABLE: Record<Capability, string> = {
	remoteAccess:
		"Remote access is off on Windows: the check of risky commands from remote pages does not know Windows paths and shells yet",
	processTreeKill: "Ending a process with what it started is not available on this system",
	pauseResume: "Pausing a conversation is not available on this system yet",
	relay: "Conversations that outlive the server are not available on this system yet",
	keepAwake: "Keeping the computer awake while a conversation works is only available on macOS",
	openFiles: "Opening files and folders from the page is only available on macOS",
	leaseHolders: "Which process has a session open cannot be told on this system",
	gpuLoad: "The GPU's load is only read on macOS",
	loginEnv: "This system does not need the login shell's environment",
	jobSurvivesServer: "An install that was running when the server ended cannot be followed on this system",
	appUpdate: "The in-app update is only available in the macOS app",
	appShell: "The native app shell is only available on macOS",
};
