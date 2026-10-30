import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../shared/guards.ts";
import type { UpdateOutcome } from "../../shared/update.ts";
import { ensurePrivateDir } from "../private.ts";

/**
 * What an update keeps in `<data dir>/update/`. The folder holds the downloaded installer while it is checked, the helper
 * that swaps the app and its log, and the small files the server, the helper and the macOS shell tell each other things by:
 *
 * - `check.json`   the last answer of GitHub (its ETag and body), so that a start does not ask again for what it knows.
 * - `handover.json` an update that is staged and whose app was asked to quit: the shell looks for it before it quits for
 *   an update, and the next server looks for it to say that it is up (`ack.json`).
 * - `ack.json`     written by the new server: it started, as the version the helper installed.
 * - `result.json`  how an update ended, for the page to show until it is dismissed.
 */

export interface UpdatePaths {
	dir: string;
	check: string;
	handover: string;
	ack: string;
	result: string;
	helper: string;
	helperLog: string;
}

export function updatePaths(dataDir: string): UpdatePaths {
	const dir = join(dataDir, "update");
	return {
		dir,
		check: join(dir, "check.json"),
		handover: join(dir, "handover.json"),
		ack: join(dir, "ack.json"),
		result: join(dir, "result.json"),
		helper: join(dir, "helper.sh"),
		helperLog: join(dir, "helper.log"),
	};
}

/** Make the folder (private, like the rest of the data dir) and return its paths. */
export function ensureUpdateDir(dataDir: string): UpdatePaths {
	const paths = updatePaths(dataDir);
	ensurePrivateDir(paths.dir);
	return paths;
}

/** Written whole and moved into place: a reader (the helper, the shell) never sees half of one. */
export function writeJson(file: string, value: unknown): void {
	const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
	writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
	renameSync(tmp, file);
}

export function readJson(file: string): unknown {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return null;
	}
}

/** An update that was handed to the helper. */
export interface Handover {
	id: string;
	from: string;
	to: string;
	/** The installed app's path, the staged copy's and the backup's: the helper's arguments, kept for the next server. */
	installed: string;
	staged: string;
	backup: string;
	helperPid: number;
}

export function readHandover(paths: UpdatePaths): Handover | null {
	const v = readJson(paths.handover);
	if (!isRecord(v)) return null;
	const { id, from, to, installed, staged, backup, helperPid } = v;
	if (
		typeof id !== "string" ||
		typeof from !== "string" ||
		typeof to !== "string" ||
		typeof installed !== "string" ||
		typeof staged !== "string" ||
		typeof backup !== "string" ||
		typeof helperPid !== "number"
	)
		return null;
	return { id, from, to, installed, staged, backup, helperPid };
}

const PROBLEMS: readonly string[] = ["quitTimeout", "verify", "swap", "didNotStart", "rollbackFailed"];

/** The outcome in `result.json` (the helper's, or a server's own success), or null when there is none or it is no outcome. */
export function readOutcome(paths: UpdatePaths): UpdateOutcome | null {
	const v = readJson(paths.result);
	if (!isRecord(v)) return null;
	const { ok, from, to, at, problem } = v;
	if (typeof ok !== "boolean" || typeof from !== "string" || typeof to !== "string" || typeof at !== "number")
		return null;
	if (ok) return { ok, from, to, at };
	if (typeof problem !== "string" || !PROBLEMS.includes(problem)) return null;
	return { ok, from, to, at, problem: problem as NonNullable<UpdateOutcome["problem"]> };
}

/** The most a helper's log may hold before the next update starts a new one. */
export const MAX_LOG_BYTES = 1024 * 1024;

/**
 * Keep `file` from growing for ever: one over `max` bytes becomes `<file>.1` (the one before it is dropped) and the next
 * line starts a new file. The helper appends one short paragraph per update, so this is what a year of failed updates costs.
 */
export function rotateLog(file: string, max = MAX_LOG_BYTES): void {
	try {
		if (statSync(file).size > max) renameSync(file, `${file}.1`);
	} catch {
		// no log yet
	}
}

export function removeFiles(...files: string[]): void {
	for (const f of files) rmSync(f, { force: true });
}
