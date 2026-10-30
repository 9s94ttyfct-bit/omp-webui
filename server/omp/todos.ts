import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../../shared/guards.ts";
import { hasCommand } from "./loaded.ts";

/**
 * Replace a conversation's todo list from the web UI.
 *
 * omp's own way to replace the list from outside the terminal is `/todo import <file>`: it parses omp's Markdown
 * checklist (`# phase` / `- [ ] task`, the format of `/todo edit`), applies omp's one-task-in-progress rule, sets the
 * process's list and records the edit in the conversation, so a resumed conversation keeps it. The RPC `set_todos`
 * only changes the process's memory, which a resume would silently undo, so it is not used.
 */

/** What this needs of a running omp (`Live` is one). */
export interface TodoProcess {
	rpc(
		command: Record<string, unknown>,
		options?: { user?: boolean },
	): Promise<{ success: boolean; data?: unknown; error?: string }>;
	/** Run a builtin slash command and return what it printed; null when omp did not take it for a command. */
	command(message: string, options?: { user?: boolean }): Promise<string | null>;
}

export class TodoError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

/** More than any list a person writes; it bounds what is written to disk and handed to omp. */
export const TODO_MARKDOWN_MAX = 256 * 1024;

/**
 * Make `markdown` the conversation's list. Throws a `TodoError` carrying omp's own words when omp rejects it (a line
 * it cannot read), in which case the list is unchanged.
 */
export async function replaceTodos(omp: TodoProcess, markdown: string): Promise<void> {
	if (markdown.length > TODO_MARKDOWN_MAX) throw new TodoError("The todo list is too long", 413);
	// omp hands a line it does not know to the model as a prompt, which costs a turn: ask for the command first.
	const catalog = await omp.rpc({ type: "get_available_commands" }, { user: true });
	const commands = isRecord(catalog.data) ? catalog.data.commands : undefined;
	if (!catalog.success || !hasCommand(commands, "todo", "import"))
		throw new TodoError("This omp cannot replace the todo list (no /todo import)", 501);

	const dir = await mkdtemp(join(tmpdir(), "ompw-todo-"));
	const file = join(dir, "todos.md");
	try {
		await writeFile(file, markdown, { mode: 0o600 });
		// omp takes the argument as a path, minus one pair of double quotes: a temp folder with spaces still works.
		const said = await omp.command(`/todo import "${file}"`, { user: true });
		if (said === null) throw new TodoError("omp did not take /todo import for a command", 501);
		if (!said.startsWith("Imported ")) {
			const reason = said.split(file).join("the list").trim();
			throw new TodoError(reason || "omp did not accept the todo list", 422);
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
