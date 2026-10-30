import { Chain, writeRenderSession } from "./render-fixtures.ts";

/**
 * One conversation that puts every kind of surface a palette has to colour on a single page (no model call): a thinking
 * block, a bash card, an edit diff, a failed tool, a user bubble and an answer in Markdown with a heading, emphasis, a
 * link, inline code, lists, a quote, a table, a rule and fenced code in five languages. The palette specs open it by
 * its first prompt; the Markdown it renders is the densest text in the app.
 */

export const SHOWCASE_PROMPT = "Palette showcase: how does the config loader work?";

const ANSWER = `## How the loader works

The loader reads **three** layers, in this order, and the *last one wins*. See [the config guide](https://example.com/config) or run \`omp config list\` to check what applied.

1. Defaults compiled into the binary
2. The user file at \`~/.omp/config.yml\`
3. The project file, when there is one

- Unknown keys are kept, not dropped
- Types are checked once, after merging

> A value set by a later layer replaces the earlier one; it is never merged key by key.

| Layer | Path | Wins over |
| --- | --- | --- |
| defaults | built in | nothing |
| user | ~/.omp/config.yml | defaults |
| project | .omp/config.yml | user |

---

\`\`\`ts
export async function loadConfig(cwd: string): Promise<Config> {
	const layers = [defaults, await read(userFile), await read(join(cwd, ".omp/config.yml"))];
	// The last layer wins.
	return layers.reduce((merged, layer) => ({ ...merged, ...layer }), {} as Config);
}
\`\`\`

\`\`\`json
{ "model": "claude-haiku-5-5", "retries": 3, "stream": true, "tags": ["a", "b"], "note": null }
\`\`\`

\`\`\`bash
# check the merged result
omp config list --json | jq '.model' && echo "ok: $HOME"
\`\`\`

\`\`\`diff
- const layers = [defaults, user];
+ const layers = [defaults, user, project];
\`\`\`

\`\`\`python
def load(path: str) -> dict:
    """Read one layer."""
    with open(path) as f:
        return {k: v for k, v in parse(f.read()).items() if v is not None}
\`\`\`
`;

const DIFF =
	" 10|\tconst layers = [defaults, user];\n-11|\treturn merge(layers);\n+11|\tconst withProject = [...layers, project];\n+12|\treturn merge(withProject);\n 13|}";

/**
 * Conversations enough to fill the sidebar's list well below the top of the window. A full run leaves those of the
 * specs before it listed there; alone, the list is short. A palette check must not depend on which it is.
 */
export const FILLER_COUNT = 14;

/** Writes `FILLER_COUNT` short conversations into `agentDir`'s fixture project; returns their files. */
export function writeFillerSessions(agentDir: string): string[] {
	return Array.from({ length: FILLER_COUNT }, (_, i) => {
		const nn = String(i).padStart(2, "0");
		const c = new Chain(`pf${nn}`);
		c.user(`Palette filler ${i + 1}: a conversation that only takes room in the list`);
		c.assistant([{ type: "text", text: "Noted." }]);
		return writeRenderSession(agentDir, `01a00000-0000-7000-8000-00000000fb${nn}`, c.entries);
	});
}

/** Writes the conversation into `agentDir`'s fixture project; returns the file. */
export function writeShowcaseSession(agentDir: string): string {
	const c = new Chain("pa01");
	c.user(SHOWCASE_PROMPT);
	c.assistant([
		{ type: "thinking", thinking: "The loader merges layers; I should read it before I describe it." },
		{ type: "toolCall", id: "toolu_p1", name: "bash", arguments: { command: "cat src/config.ts | head -20" } },
	]);
	c.toolResult("toolu_p1", "bash", [
		{ type: "text", text: "export const defaults = { retries: 3 };\nexport function merge() {}" },
	]);
	c.assistant([
		{
			type: "toolCall",
			id: "toolu_p2",
			name: "edit",
			arguments: {
				i: "Adding the project layer",
				input: "[src/config.ts#1234]\nPUT 11:\n+\tconst withProject = [...layers, project];",
			},
		},
	]);
	c.entries.push({
		id: "pa01e001",
		parentId: c.lastId,
		timestamp: new Date(Date.UTC(2026, 0, 9, 10, 20)).toISOString(),
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: "toolu_p2",
			toolName: "edit",
			content: [{ type: "text", text: "[src/config.ts#1234]\n11:\tconst withProject = [...layers, project];" }],
			details: { diff: DIFF, firstChangedLine: 11, op: "update", path: "/tmp/ompw-fixture-project/src/config.ts" },
			isError: false,
			timestamp: Date.UTC(2026, 0, 9, 10, 20),
		},
	});
	c.assistant([
		{ type: "toolCall", id: "toolu_p3", name: "read", arguments: { path: "/tmp/ompw-fixture-project/missing.ts" } },
	]);
	c.entries.push({
		id: "pa01e002",
		parentId: c.lastId,
		timestamp: new Date(Date.UTC(2026, 0, 9, 10, 21)).toISOString(),
		type: "message",
		message: {
			role: "toolResult",
			toolCallId: "toolu_p3",
			toolName: "read",
			content: [
				{ type: "text", text: "ENOENT: no such file or directory, open '/tmp/ompw-fixture-project/missing.ts'" },
			],
			details: {},
			isError: true,
			timestamp: Date.UTC(2026, 0, 9, 10, 21),
		},
	});
	c.assistant([{ type: "text", text: ANSWER }]);
	return writeRenderSession(agentDir, "01a00000-0000-7000-8000-00000000ca11", c.entries);
}
