import { expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadedContextFiles } from "../../server/omp/guidance/loaded-context.ts";
import { tempDir } from "../support/temp-dirs.ts";

/**
 * The context files the guidance conflict check compares with are the ones the real omp gives the agent (#308): its own
 * choice of one user file and one project file per depth, its opt-in foreign providers, and an `@` import put in as text.
 * The layout is the report's: a repository with `AGENTS.md` (importing a file), `.omp/AGENTS.md` beside it, a package with
 * `AGENTS.md`, `CLAUDE.md` and its own `.omp/AGENTS.md`, and the person's `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`.
 */

const omp = Bun.which("omp");

test.skipIf(!omp)(
	"the files are what omp loads: the nearest .omp wins, foreign user files are opt-in, imports are text",
	async () => {
		const root = realpathSync(tempDir("ompw-ctx-"));
		const home = join(root, "home");
		const agentDir = join(home, ".omp", "agent");
		const repo = join(home, "work", "repo");
		const pkg = join(repo, "pkg");
		for (const dir of [
			agentDir,
			join(home, ".claude"),
			join(home, ".codex"),
			join(repo, ".git"),
			join(repo, "docs"),
			join(repo, ".omp"),
			join(pkg, ".omp"),
		])
			mkdirSync(dir, { recursive: true });
		writeFileSync(join(agentDir, "AGENTS.md"), "USER-NATIVE marker\n");
		writeFileSync(join(home, ".claude", "CLAUDE.md"), "USER-CLAUDE marker\n");
		writeFileSync(join(home, ".codex", "AGENTS.md"), "USER-CODEX marker\n");
		writeFileSync(join(repo, "AGENTS.md"), "REPO-AGENTS marker. Read @docs/imp.md\n");
		writeFileSync(join(repo, "docs", "imp.md"), "IMPORTED-TEXT marker: always use tabs\n");
		writeFileSync(join(repo, ".omp", "AGENTS.md"), "REPO-NATIVE marker\n");
		writeFileSync(join(pkg, "AGENTS.md"), "PKG-AGENTS marker\n");
		writeFileSync(join(pkg, "CLAUDE.md"), "PKG-CLAUDE marker\n");
		writeFileSync(join(pkg, ".omp", "AGENTS.md"), "PKG-NATIVE marker\n");

		// The person's own MCP server (in the agent folder's mcp.json): asking for the files must not start it.
		const marker = join(root, "mcp-started");
		const server = join(root, "mcp-server.sh");
		writeFileSync(server, `#!/bin/sh\necho started >> "${marker}"\ncat\n`, { mode: 0o755 });
		writeFileSync(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { probe: { command: server, args: [] } } }));

		const files = await loadedContextFiles(omp as string, pkg, agentDir, { HOME: home });
		await Bun.sleep(2500);
		expect(existsSync(marker), "an MCP server was started").toBe(false);
		// The agent folder's own file, not the copy the probe ran on.
		expect(
			files.some((f) => f.path.endsWith(join(".omp", "agent", "AGENTS.md")) && !f.path.includes("ompw-agent-")),
		).toBe(true);
		const all = files.map((f) => f.text).join("\n");
		// Loaded, as the agent reads them.
		expect(all).toContain("USER-NATIVE marker");
		expect(all).toContain("PKG-NATIVE marker");
		expect(all).toContain("IMPORTED-TEXT marker: always use tabs");
		// Not loaded: the shadowed files, the farther .omp, and the foreign tools' files nobody opted in to.
		for (const marker of ["PKG-AGENTS", "PKG-CLAUDE", "REPO-NATIVE", "USER-CLAUDE", "USER-CODEX"])
			expect(all, marker).not.toContain(marker);
		// omp may name the folders as its process saw them (`/var` for `/private/var`).
		expect(files.some((f) => f.path.endsWith(join("pkg", ".omp", "AGENTS.md")))).toBe(true);
	},
	60_000,
);
