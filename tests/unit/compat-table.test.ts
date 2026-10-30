import { describe, expect, test } from "bun:test";
import {
	commandsOfArgv,
	docsTable,
	type Found,
	flagsOfArgv,
	phrases,
	scanArgv,
	scanFlags,
	scanRpc,
} from "../support/omp-interfaces.ts";

/**
 * docs/TECHNICAL.md › "How it stays compatible with omp updates" names every interface of omp the server and the page
 * use. This reads them out of the source (RPC command types, slash commands, the argument lists of omp's CLI, the
 * flags) and fails for each that the table does not name, so a new use of omp comes with a row, and an omp release that
 * changes one is found where the table says it is used.
 */

const table = docsTable("How it stays compatible with omp updates");
/** What the table's code spans say, with every `a\|b` choice spelled out. */
const spans = phrases(table);
const words = new Set(spans.flatMap((s) => s.split(/[\s=,<>]+/)));
/** Whether a span has `phrase` as whole words. */
const names = (phrase: string) => spans.some((s) => ` ${s} `.includes(` ${phrase} `));

/** The values that none of `wanted` accounts for, each once with where it is used. */
function missing(found: Found[], isNamed: (value: string) => boolean): string[] {
	const first = new Map<string, string>();
	for (const f of found) if (!isNamed(f.value) && !first.has(f.value)) first.set(f.value, f.at);
	return [...first].map(([value, at]) => `${value} (${at})`);
}

describe("the extractors read what omp is asked", () => {
	const only = (src: string) => (): string => src;

	test("RPC commands: the type of each command object, however it is chosen, and not of what it carries", () => {
		const scan = scanRpc(
			["x.ts"],
			only(`
			socket.rpc(id, { type: "prompt", message: "/retry", images: [{ type: "image", data }] });
			const r = await act<{ ok: boolean }>(liveId, last ? { type: "get_entries", since: last } : { type: "get_entries" });
			request({ t: "rpc", liveId, command: { type: "bash", command: "ls" } });
			this.client.send({ ...response, type: "extension_ui_response" });
			// rpc({ type: "in_a_comment" })
			const other = notASender({ type: "ignored" });
		`),
		);
		expect([...new Set(scan.types.map((t) => t.value))].sort()).toEqual([
			"bash",
			"extension_ui_response",
			"get_entries",
			"prompt",
		]);
		expect(scan.slash.map((s) => s.value)).toEqual(["/retry"]);
		expect(scan.unreadable).toEqual([]);
	});

	test("a command whose type is not written out is reported, not skipped", () => {
		const scan = scanRpc(["x.ts"], only("rpc(id, { type: kind, value });"));
		expect(scan.types).toEqual([]);
		expect(scan.unreadable).toHaveLength(1);
	});

	test("slash commands: the words written out, up to the first that is not", () => {
		const scan = scanRpc(
			["x.ts"],
			only(`
			omp.command("/mcp list");
			omp.command(\`/mcp \${verb} \${name}\`, { user: true });
			omp.command(\`/todo import "\${file}"\`);
			rpc({ type: "prompt", message: \`/modelpreset switch \${name}\` });
			void send("/retry", [], "normal");
		`),
		);
		expect(scan.slash.map((s) => s.value)).toEqual([
			"/mcp list",
			"/mcp",
			"/todo import",
			"/modelpreset switch",
			"/retry",
		]);
	});

	test("omp's CLI: lists that start with the binary, and the ones handed to its runners", () => {
		const argv = scanArgv(
			["x.ts"],
			only(`
			Bun.spawn([cfg.ompBin, "stats", "--json"]);
			Bun.spawn(["ps", "-A"]);
			runJson(t.bin, ["config", "get", "disabledExtensions", "--json"], cwd, env);
			const args = ["plugin", enabled ? "enable" : "disable", ...(scope ? ["--scope", scope] : []), name, "--json"];
			await runJson(t.bin, args, cwd, env);
			ompConfig(bin, cwd, ["set", name, JSON.stringify(value), "--json"]);
			const usage = [bin, "usage", "--json", ...(provider ? [\`--provider=\${provider}\`] : [])];
		`),
		);
		expect(argv.map((a) => commandsOfArgv(a))).toEqual([
			["stats"],
			["usage"],
			["config get disabledExtensions"],
			["plugin enable", "plugin disable"],
			["config set"],
		]);
		expect(argv.flatMap((a) => flagsOfArgv(a))).toEqual([
			"--json",
			"--json",
			"--provider",
			"--json",
			"--scope",
			"--json",
			"--json",
		]);
	});

	test("flags: written as strings, not in comments, not the stylesheets' custom properties", () => {
		const flags = scanFlags(
			["x.ts"],
			only(`
			const args = ["--resume", file, \`--model=\${m}\`];
			// "--only-in-a-comment"
			style.setProperty("--accent", color);
		`),
		);
		expect(flags.map((f) => f.value)).toEqual(["--resume", "--model"]);
	});

	test("the table's choices are spelled out: `omp plugin enable\\|disable` names both commands", () => {
		const out = phrases("`omp plugin enable\\|disable --scope user\\|project <name>` and `/mcp list`");
		expect(out).toEqual([
			"omp plugin enable --scope user <name>",
			"omp plugin enable --scope project <name>",
			"omp plugin disable --scope user <name>",
			"omp plugin disable --scope project <name>",
			"/mcp list",
		]);
	});
});

describe("docs/TECHNICAL.md › How it stays compatible with omp updates names", () => {
	const rpc = scanRpc();

	test("what the extractors found is not nothing (a broken extractor would pass everything)", () => {
		const types = new Set(rpc.types.map((t) => t.value));
		for (const t of ["prompt", "get_state", "set_model", "negotiate_protocol", "host_tool_result"])
			expect(types).toContain(t);
		expect(rpc.slash.map((s) => s.value)).toContain("/todo import");
		const commands = scanArgv().flatMap(commandsOfArgv);
		for (const c of ["stats", "usage", "update", "plugin enable", "config set disabledExtensions"])
			expect(commands).toContain(c);
		expect(scanFlags().map((f) => f.value)).toContain("--resume");
	});

	test("every RPC command it sends", () => {
		expect(rpc.unreadable).toEqual([]);
		expect(missing(rpc.types, (type) => words.has(type))).toEqual([]);
	});

	test("every slash command it runs", () => {
		expect(missing(rpc.slash, names)).toEqual([]);
	});

	test("every omp command line it runs", () => {
		const found: Found[] = scanArgv().flatMap((a) => commandsOfArgv(a).map((value) => ({ value, at: a.at })));
		expect(missing(found, (command) => names(`omp ${command}`))).toEqual([]);
	});

	/** Flags that are not omp's: the server's own relay launcher, git's (server/git.ts, server/git-vet.ts, server/git-changes.ts), gh's (server/gh-issues.ts), cloudflared's (server/remote-tunnel.ts), codesign's and open's (server/update/), a CSS variable set from script. */
	const NOT_OMP = new Set([
		"--ompw-relay",
		"--branch",
		"--no-optional-locks",
		"--porcelain",
		"--attr-source",
		"--path-format",
		"--git-path",
		"--list",
		"--show-scope",
		"--ignore-submodules",
		"--ignored",
		"--show-prefix",
		"--no-autoupdate",
		"--name",
		"--output",
		"--sidebar-w",
		"--vvh",
		"--index-room",
		"--env",
		"--verify",
		"--deep",
		"--strict",
		"--git-dir",
		"--work-tree",
		"--no-pager",
		"--show-toplevel",
		"--untracked-files",
		"--raw",
		"--numstat",
		"--no-color",
		"--no-ext-diff",
		"--no-textconv",
		"--limit",
		"--state",
		"--search",
		// git's, for the Worktrees tab (#698): `symbolic-ref --quiet --short`, `rev-list --count`.
		"--quiet",
		"--short",
		"--count",
	]);

	test("every flag it passes, checks for, or refuses", () => {
		const found = scanFlags().filter((f) => !NOT_OMP.has(f.value));
		expect(missing(found, (flag) => words.has(flag))).toEqual([]);
	});
});
