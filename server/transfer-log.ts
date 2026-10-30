import { chmodSync, closeSync, constants, existsSync, openSync, renameSync, statSync, writeSync } from "node:fs";
import type { TransferRecord } from "../shared/transfer.ts";

/**
 * The record of what moved between a page that is not on this computer and the folders of its conversations
 * (`<data dir>/transfers.jsonl`): one JSON line for each download, ZIP and upload that ended or was refused, with who asked
 * (the Access email, `local`, or `net:<address>`), what, how much and how it ended. The one write path a page has that leaves no
 * trace in a conversation, and the one way to see afterwards what a page took.
 *
 * Append only, and private (`0600`: the paths in it are the person's). A line never holds a query string or a token: the
 * caller gives paths relative to the conversation's folder. The file is moved aside (`transfers.jsonl.1`, replacing the one
 * before) once it is longer than `ROTATE_BYTES`, as the guard's log is. A line that cannot be written is said once on the
 * console and never fails the transfer: a full disk must not turn a download into an error nobody can read.
 */

/** The log is moved aside when it is longer than this. */
export const TRANSFER_LOG_ROTATE_BYTES = 8 * 1024 * 1024;
/** The longest path kept in a line: far above what a file system holds (PATH_MAX is 1024 on macOS). */
const MAX_PATH_CHARS = 4096;

export class TransferLog {
	readonly file: string;
	#size: number | null = null;
	#warned = false;
	readonly #rotateAt: number;

	constructor(file: string, rotateAt: number = TRANSFER_LOG_ROTATE_BYTES) {
		this.file = file;
		this.#rotateAt = rotateAt;
	}

	/** One line for `record`. Never throws. */
	append(record: TransferRecord): void {
		try {
			const line = `${JSON.stringify({ ...record, path: record.path.slice(0, MAX_PATH_CHARS) })}\n`;
			this.#size ??= this.#sizeOnDisk();
			if (this.#size > this.#rotateAt) this.#rotate();
			const created = !existsSync(this.file);
			// No link is followed: a link put where the log goes would redirect it.
			const fd = openSync(
				this.file,
				constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
				0o600,
			);
			try {
				writeSync(fd, line);
			} finally {
				closeSync(fd);
			}
			if (created) chmodSync(this.file, 0o600);
			this.#size += Buffer.byteLength(line);
		} catch (e) {
			if (this.#warned) return;
			this.#warned = true;
			console.warn(`omp-webui: the transfer log ${this.file} could not be written (${(e as Error).message})`);
		}
	}

	#sizeOnDisk(): number {
		try {
			return statSync(this.file).size;
		} catch {
			return 0;
		}
	}

	/** Move the log aside, replacing the one moved aside before; the next line starts a new file. */
	#rotate(): void {
		try {
			renameSync(this.file, `${this.file}.1`);
			this.#size = 0;
		} catch {
			// Not moved: tried again at the next line.
		}
	}
}
