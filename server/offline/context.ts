import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ContextBreakdown, RESERVED_ROWS } from "../../shared/offline.ts";
import { RpcClient } from "../omp/rpc-client.ts";

/**
 * How much of the model's context window an omp process uses before its first message, read from omp's own
 * `/context`: a short-lived process in an empty folder, no model call, no session file.
 */

const WINDOW = /^Context window:\s+([\d,]+)\s+tokens/m;
/** `  System prompt    [████░░░░] 4%  2699 tokens` (labels are padded to a width, the longest one not at all) */
const ROW = /^\s*(.+?)\s*\[[^\]]*\]\s+[\d.]+%\s+([\d,]+)\s+tokens\s*$/;

/** The breakdown in `/context`'s text (colors and all); null when it is not that text. */
export function parseContext(text: string): Omit<ContextBreakdown, "incomplete"> | null {
	const plain = Bun.stripANSI(text);
	const window = WINDOW.exec(plain);
	if (!window) return null;
	const items = plain.split("\n").flatMap((line) => {
		const row = ROW.exec(line);
		return row ? [{ label: row[1], tokens: Number(row[2].replaceAll(",", "")) }] : [];
	});
	if (!items.length) return null;
	return {
		window: Number(window[1].replaceAll(",", "")),
		startTokens: items.filter((i) => !RESERVED_ROWS.test(i.label)).reduce((sum, i) => sum + i.tokens, 0),
		items,
	};
}

/** The prefix omp gives the tools of an MCP server in its `xd://` mounts: `mcp__<server>_`. */
const mountPrefix = (server: string): string => `mcp__${server.replace(/[^A-Za-z0-9_]/g, "_")}_`;

/** No new MCP tools for this long after all wanted servers are in: the others (plugins) have had their say too. */
const QUIET_MS = 1500;
/** No MCP activity for this long: what has not registered by now is not going to (a server that failed). */
const SILENCE_MS = 10_000;
const START_MS = 60_000;
const BUDGET_MS = 45_000;

export interface MeasureOptions {
	bin: string;
	/** Added to `--no-session`. */
	args: string[];
	env?: Record<string, string | undefined>;
	/** MCP servers that should have registered their tools before the numbers are taken. */
	servers: string[];
	/** Aborted: the measurement is no longer wanted. The process is stopped and the measurement fails. */
	signal?: AbortSignal;
}

function within<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
	return Promise.race([work, Bun.sleep(ms).then(() => Promise.reject(new Error(what)))]);
}

export async function measureContext(o: MeasureOptions): Promise<ContextBreakdown> {
	o.signal?.throwIfAborted();
	const cwd = mkdtempSync(join(tmpdir(), "ompw-context-"));
	const wanted = o.servers.map(mountPrefix);
	const mounted = new Set<string>();
	let lastActivity = Date.now();
	let output = "";
	const client = new RpcClient({
		bin: o.bin,
		args: ["--no-session", ...o.args],
		cwd,
		env: o.env,
		onFrame: (f) => {
			// omp announces the MCP tools it mounts as they register: `xd://: mounted mcp__rea_open_binary, …`.
			if (f.type === "notice" && typeof f.message === "string") {
				lastActivity = Date.now();
				for (const prefix of wanted) if (f.message.includes(prefix)) mounted.add(prefix);
			}
			if (f.type === "command_output" && typeof f.text === "string") output += `${f.text}\n`;
		},
		onExit: () => {},
	});
	const stop = () => client.kill();
	o.signal?.addEventListener("abort", stop, { once: true });
	try {
		await within(client.ready, START_MS, "omp did not start in time");
		lastActivity = Date.now();
		const deadline = Date.now() + BUDGET_MS;
		for (;;) {
			const quiet = Date.now() - lastActivity;
			if (mounted.size >= wanted.length ? quiet >= QUIET_MS : quiet >= SILENCE_MS) break;
			if (Date.now() >= deadline) break;
			o.signal?.throwIfAborted();
			await Bun.sleep(100);
		}
		const incomplete = mounted.size < wanted.length;
		await client.call({ type: "prompt", message: "/context" }, 30_000);
		// The reply to the prompt and the text it printed are separate frames.
		const printed = Date.now() + 5000;
		while (!WINDOW.test(Bun.stripANSI(output)) && Date.now() < printed) await Bun.sleep(50);
		const parsed = parseContext(output);
		if (!parsed) throw new Error("omp's /context answered in a form this does not know");
		return { ...parsed, incomplete };
	} finally {
		o.signal?.removeEventListener("abort", stop);
		client.close();
		await Promise.race([client.whenExited, Bun.sleep(3000)]);
		client.kill();
		rmSync(cwd, { recursive: true, force: true });
	}
}
