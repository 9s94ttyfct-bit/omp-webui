/**
 * CLI ↔ Web UI parity map. Every item of omp's CLI surface — subcommands and
 * flags from `omp --help`, plus slash commands from RPC
 * `get_available_commands` — resolves to the UI affordance that provides it.
 *
 * The generic surfaces are data-driven (the UI renders whatever omp reports),
 * so items added by future omp releases are covered without code changes;
 * only flags that cannot be a session option need a dedicated entry here.
 */

export type ItemKind = "command" | "flag" | "slash";

export interface InventoryItem {
	kind: ItemKind;
	name: string;
	description: string;
}

export type Surface =
	/** CLI page lists the subcommand; it runs in a real PTY terminal. */
	| { kind: "cli-command"; command: string }
	/** New-chat "Options" form has a control for the flag (passed to `omp --mode rpc-ui`). */
	| { kind: "session-option"; flag: string }
	/** Composer slash menu offers the command; it is sent through RPC `prompt`. */
	| { kind: "slash-menu"; command: string }
	/** A dedicated control, identified by a `data-testid` on a given route. */
	| { kind: "control"; route: string; testid: string; note: string }
	/** The free command line on the CLI page (`omp <args>` in a PTY). */
	| { kind: "command-line"; example: string; note: string };

/** Root flags with a dedicated UI instead of a session option. */
export const FLAG_SURFACES: Record<string, Surface> = {
	"--resume": {
		kind: "control",
		route: "/",
		testid: "session-item",
		note: "open any conversation from the sidebar; sending resumes it",
	},
	"--continue": {
		kind: "control",
		route: "/",
		testid: "session-item",
		note: "the most recent conversation is first in the sidebar",
	},
	"--restore": {
		kind: "control",
		route: "/",
		testid: "session-item",
		note: "opening an interrupted conversation resumes it",
	},
	"--cwd": { kind: "control", route: "/", testid: "cwd-picker", note: "folder picker on the new-chat page" },
	"--export": {
		kind: "control",
		route: "fixture-chat",
		testid: "export-html",
		note: "Export HTML button in the chat header",
	},
	"--mode": {
		kind: "command-line",
		example: "--mode json -p hello",
		note: "the web UI itself drives omp in rpc-ui mode",
	},
	"--goal": {
		kind: "control",
		route: "/",
		testid: "goal-mode",
		note: "Goal toggle on the new-chat composer (goal mode)",
	},
	"--approval-mode": {
		kind: "control",
		route: "/",
		testid: "approval-picker",
		note: "permission mode switcher in the composer footer (a flag would override it)",
	},
	"--auto-approve": {
		kind: "control",
		route: "/",
		testid: "approval-picker",
		note: "the Auto-approve mode of the permission mode switcher",
	},
	"--yolo": {
		kind: "control",
		route: "/",
		testid: "approval-picker",
		note: "the Auto-approve mode of the permission mode switcher",
	},
	"--alias": { kind: "command-line", example: "--profile work --alias omp-work", note: "creates a shell shortcut" },
	"--print": { kind: "command-line", example: "-p hello", note: "one-shot non-interactive run in the terminal" },
	"--from-claude": { kind: "command-line", example: "--from-claude", note: "imports a Claude Code session" },
	"--from-codex": { kind: "command-line", example: "--from-codex", note: "imports a Codex session" },
};

export function surfaceFor(item: InventoryItem): Surface {
	switch (item.kind) {
		case "command":
			return { kind: "cli-command", command: item.name };
		case "slash":
			return { kind: "slash-menu", command: item.name };
		case "flag":
			return FLAG_SURFACES[item.name] ?? { kind: "session-option", flag: item.name };
	}
}

export function describeSurface(s: Surface): string {
	switch (s.kind) {
		case "cli-command":
			return `Commands page → ${s.command} (PTY terminal)`;
		case "session-option":
			return `New chat → Options → ${s.flag}`;
		case "slash-menu":
			return `Composer → /${s.command}`;
		case "control":
			return `${s.testid} — ${s.note}`;
		case "command-line":
			return `Commands page → omp ${s.example} — ${s.note}`;
	}
}
