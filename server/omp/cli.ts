import type { CliCommand, CliFlag, CliHelp, CliInventory } from "../../shared/protocol.ts";
import { QUICK_MS, run } from "./run.ts";

/**
 * Discovers omp's CLI surface at runtime by parsing `omp --help` and
 * `omp <command> --help`. Nothing is hard-coded, so commands and flags added
 * by future omp releases show up automatically.
 */

async function runHelp(bin: string, args: string[], timeoutMs: number): Promise<string> {
	const { stdout, stderr } = await run([bin, ...args], { env: { NO_COLOR: "1", FORCE_COLOR: "0" }, timeoutMs });
	return Bun.stripANSI(stdout || stderr);
}

/** Split help text into `SECTION -> lines` using omp's UPPERCASE headings. */
export function sections(text: string): Map<string, string[]> {
	const out = new Map<string, string[]>();
	let current = "_preamble";
	out.set(current, []);
	for (const line of text.split("\n")) {
		const heading = /^([A-Z][A-Z ]+[A-Z])\s*$/.exec(line.trim());
		if (heading && !line.startsWith(" ")) {
			current = heading[1];
			out.set(current, []);
			continue;
		}
		// Any other unindented text ("Environment Variables:", tool lists…) ends a section.
		if (current !== "_preamble" && line.trim() && !/^\s/.test(line)) {
			current = `_trailer:${line.trim()}`;
			out.set(current, []);
			continue;
		}
		out.get(current)?.push(line);
	}
	return out;
}

/** Parse `  -p, --print   Description` / `      --model=<value>   Description` rows; wrapped lines extend the previous row. */
export function parseFlags(lines: string[]): CliFlag[] {
	const flags: CliFlag[] = [];
	for (const line of lines) {
		const m = /^\s+(?:(-[A-Za-z0-9]),\s+)?(--[A-Za-z0-9][\w-]*)(?:[= ](<[^>]+>|\S+))?\s{2,}(.*)$/.exec(line);
		if (m) {
			flags.push({
				short: m[1],
				name: m[2],
				value: m[3],
				description: m[4].trim(),
			});
		} else if (flags.length && /^\s{8,}\S/.test(line)) {
			flags[flags.length - 1].description += ` ${line.trim()}`;
		}
	}
	return flags;
}

/** Parse `  name   Description` rows (commands, arguments). */
export function parseRows(lines: string[]): CliCommand[] {
	const rows: CliCommand[] = [];
	for (const line of lines) {
		const m = /^\s{1,4}([a-z0-9][\w:-]*)\s{2,}(.*)$/i.exec(line);
		if (m && !m[1].startsWith("-")) rows.push({ name: m[1], description: m[2].trim() });
		else if (rows.length && /^\s{6,}\S/.test(line)) rows[rows.length - 1].description += ` ${line.trim()}`;
	}
	return rows;
}

let inventoryCache: { at: number; value: CliInventory } | null = null;

/** omp was installed or updated: what it lists is no longer what was cached. */
export function resetCliInventory(): void {
	inventoryCache = null;
}

export async function cliInventory(bin: string, timeoutMs = QUICK_MS): Promise<CliInventory> {
	if (inventoryCache && Date.now() - inventoryCache.at < 5 * 60_000) return inventoryCache.value;
	const text = await runHelp(bin, ["--help"], timeoutMs);
	const s = sections(text);
	const version = /omp v?([\d.]+[\w.-]*)/.exec(text)?.[1] ?? "unknown";
	const optionTrailers = [...s.entries()].filter(([k]) => k.startsWith("_trailer:") && /options/i.test(k));
	const value: CliInventory = {
		version,
		commands: parseRows(s.get("COMMANDS") ?? []),
		flags: [...parseFlags(s.get("FLAGS") ?? []), ...optionTrailers.flatMap(([, lines]) => parseFlags(lines))],
	};
	inventoryCache = { at: Date.now(), value };
	return value;
}

export async function cliHelp(bin: string, command: string, timeoutMs = QUICK_MS): Promise<CliHelp> {
	if (!/^[a-z][\w-]*( [a-z][\w-]*)?$/i.test(command)) throw new Error(`Invalid command name: ${command}`);
	const raw = await runHelp(bin, [...command.split(" "), "--help"], timeoutMs);
	const s = sections(raw);
	const pre = (s.get("_preamble") ?? []).map((l) => l.trim()).filter(Boolean);
	return {
		command,
		description: pre.filter((l) => !/^omp v?\d/.test(l)).join(" "),
		usage: (s.get("USAGE") ?? [])
			.map((l) => l.trim())
			.filter(Boolean)
			.join(" "),
		args: parseRows(s.get("ARGUMENTS") ?? []),
		flags: parseFlags(s.get("FLAGS") ?? []),
		subcommands: parseRows([...(s.get("COMMANDS") ?? []), ...(s.get("SUBCOMMANDS") ?? [])]),
		raw,
	};
}

export async function ompVersion(bin: string, timeoutMs = QUICK_MS): Promise<string> {
	const { stdout } = await run([bin, "--version"], { timeoutMs });
	return /([\d]+\.[\d]+\.[\w.-]+)/.exec(stdout)?.[1] ?? stdout.trim();
}
