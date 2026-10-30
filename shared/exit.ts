/**
 * How a conversation's omp process ended, and who ended it.
 *
 * An omp that ends on its own is a fault to look into: the page says so and shows the exit code, the signal and the
 * last lines of its stderr. An omp the *server* ended is the server's doing — the idle reaper closed it, the user
 * closed it, a restart replaced it, the terminal took it over, or the server itself went away — and the page says that
 * instead, so that a conversation that is simply not running any more is not read as a crash.
 */

/** Why the server ended a conversation's omp. */
export type ExitReason =
	/** The idle reaper: nobody was looking at it and it had nothing to do. */
	| "idle"
	/** The user closed it (Settings › Running sessions, "Close"; the composer ends it). */
	| "closed"
	/** It was ended to be started again from the same file (a restart, a changed setting). */
	| "restarted"
	/** It was ended to be started again from the same file in the other mode (Full / Light, This session). */
	| "modeSwitch"
	/** A terminal took the conversation over (`omp --resume` in the built-in terminal). */
	| "handover"
	/** The server went away (quit, restart, crash). */
	| "server"
	/** Stop: omp did not end the turn in the time it is given, so the server ended its process (the conversation is kept). */
	| "stopped"
	/** Soft stop (#658): the turn that wrote the handoff ended, and the server ended the process as asked (the conversation is kept). */
	| "softStop";

/**
 * Who ended a conversation's omp: the server, or omp itself.
 *
 * `unknown`: the server no longer knows — it was restarted, or the end has been forgotten. The page then says the
 * process is no longer running, without saying who ended it: a crash of omp's must not be blamed on the server, and
 * the server's own doing must not be read as a fault (#515).
 */
export type ExitBy = "omp" | "server" | "unknown";

/**
 * What the server tells about the end of a conversation's omp, on the wire. `by` is absent when the server does not
 * say: the end is then read as omp's own, which is what it was before the server began to say.
 */
export interface ExitReport {
	/** The exit code; null when a signal ended it (`signal` is then the signal). */
	code: number | null;
	/** The signal that ended it, when one did. */
	signal?: string;
	/** What omp wrote to its stderr, its last lines. */
	stderr: string;
	/** Who ended it: the server, or omp itself. */
	by?: ExitBy;
	/** Which of the server's reasons it was, when it was the server. */
	reason?: ExitReason;
}

/** What the page reads of an exit: who ended it, and why the server did. */
export interface ExitInfo extends Omit<ExitReport, "by"> {
	/** Who ended it: the server, or omp itself. */
	by: ExitBy;
}
