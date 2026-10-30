import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFlags, parseRows, sections } from "../../server/omp/cli.ts";
import { isolatedEnv } from "../support/omp-env.ts";
import type { InventoryItem } from "./mapping.ts";

/**
 * omp's CLI surface, read straight from the installed omp (independently of
 * the web UI): `omp --help` subcommands and flags, and the slash-command
 * catalog from RPC `get_available_commands`. Runs under Bun and Node.
 */

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, "g");

export function helpInventory(bin = process.env.OMP_BIN ?? "omp"): InventoryItem[] {
	const text = execFileSync(bin, ["--help"], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } }).replace(
		ANSI,
		"",
	);
	const s = sections(text);
	const trailers = [...s.entries()].filter(([k]) => k.startsWith("_trailer:") && /options/i.test(k));
	const flags = [...parseFlags(s.get("FLAGS") ?? []), ...trailers.flatMap(([, lines]) => parseFlags(lines))];
	return [
		...parseRows(s.get("COMMANDS") ?? []).map((c) => ({
			kind: "command" as const,
			name: c.name,
			description: c.description,
		})),
		...flags.map((f) => ({ kind: "flag" as const, name: f.name, description: f.description })),
	];
}

export async function slashInventory(bin = process.env.OMP_BIN ?? "omp"): Promise<InventoryItem[]> {
	const root = mkdtempSync(join(tmpdir(), "ompw-parity-"));
	const env = { ...process.env, ...(await isolatedEnv(root)) };
	const proc = spawn(bin, ["--mode", "rpc", "--no-session"], { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] });
	const { promise, resolve, reject } = Promise.withResolvers<InventoryItem[]>();
	let buf = "";
	let stderr = "";
	proc.stderr.on("data", (d) => {
		stderr += String(d);
	});
	proc.stdout.on("data", (d) => {
		buf += String(d);
		for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
			const line = buf.slice(0, i);
			buf = buf.slice(i + 1);
			let frame: { type?: string; id?: string; data?: { commands?: { name: string; description?: string }[] } };
			try {
				frame = JSON.parse(line);
			} catch {
				continue;
			}
			if (frame.type === "ready")
				proc.stdin.write(`${JSON.stringify({ id: "inv", type: "get_available_commands" })}\n`);
			if (frame.type === "response" && frame.id === "inv") {
				resolve(
					(frame.data?.commands ?? []).map((c) => ({
						kind: "slash" as const,
						name: c.name,
						description: c.description ?? "",
					})),
				);
				proc.stdin.end();
			}
		}
	});
	proc.on("exit", (code) => reject(new Error(`omp exited (${code}) before listing commands: ${stderr.slice(-500)}`)));
	const timer = setTimeout(() => reject(new Error("timed out listing slash commands")), 60_000);
	try {
		return await promise;
	} finally {
		clearTimeout(timer);
		proc.kill();
		rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	}
}

export async function fullInventory(): Promise<InventoryItem[]> {
	return [...helpInventory(), ...(await slashInventory())];
}
