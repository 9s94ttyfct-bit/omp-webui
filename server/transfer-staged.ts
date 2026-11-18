import { constants } from "node:fs";
import { lstat, open, readFile, rename, unlink } from "node:fs/promises";
import { basename } from "node:path";

/**
 * The hidden files an upload or an editor's save writes beside their place before they are whole (`.ompw-upload-<id>`,
 * `.ompw-edit-<id>`), written down in `<data dir>/transfers-staged.jsonl` before each is made and again once it is gone
 * (#350). A server that ends without its shutdown (a crash, a force quit, power loss) leaves them in the project, where
 * git sees them; the next server removes what the list still holds when the file service starts and, until none is left,
 * every minute after — only a file nothing has written for `idleMs` (an upload that is going on in another server
 * writes more often than that), only a regular file and only one named as ours.
 *
 * One JSON line each: `{"add":path}` or `{"done":path}`. Never fails a transfer: a list that cannot be written is said once
 * on the console.
 */

const OURS = /^\.ompw-(upload|edit)-[0-9a-f]{32}$/;

export class StagedFiles {
	readonly file: string;
	/** Each write and sweep after the one before (a sweep rewrites the list). */
	#queue: Promise<void> = Promise.resolve();
	/** Whether the list may still hold a file to remove (true until a sweep finds none). */
	#pending = true;
	#warned = false;

	constructor(
		file: string,
		private readonly opts: { now: () => number; idleMs: number },
	) {
		this.file = file;
	}

	/** `path` is about to be made. */
	add(path: string): Promise<void> {
		return this.#write({ add: path });
	}

	/** `path` is gone (published, or removed). */
	done(path: string): Promise<void> {
		return this.#write({ done: path });
	}

	/** Removes what a server that ended without its shutdown left; `live` are the ones this server is writing now. */
	sweep(live: ReadonlySet<string>): Promise<void> {
		if (!this.#pending) return this.#queue;
		return this.#then(async () => {
			const left = await this.#left();
			const kept: string[] = [];
			for (const path of left) {
				if (live.has(path)) {
					kept.push(path);
					continue;
				}
				const info = await lstat(path).catch(() => null);
				if (info === null || !info.isFile() || !OURS.test(basename(path))) continue;
				if (this.opts.now() - info.mtimeMs <= this.opts.idleMs) {
					kept.push(path);
					continue;
				}
				await unlink(path).catch(() => {});
			}
			if (kept.length === left.length && left.length > 0) return;
			const temp = `${this.file}.${process.pid}.tmp`;
			await this.#writeFile(temp, kept.map((add) => `${JSON.stringify({ add })}\n`).join(""), "w");
			await rename(temp, this.file);
			this.#pending = kept.length > 0;
		});
	}

	/** The files the list says were made and not gone, in order. */
	async #left(): Promise<string[]> {
		const text = await readFile(this.file, "utf8").catch(() => "");
		const left = new Set<string>();
		for (const line of text.split("\n")) {
			try {
				const entry = JSON.parse(line) as { add?: unknown; done?: unknown };
				if (typeof entry.add === "string") left.add(entry.add);
				else if (typeof entry.done === "string") left.delete(entry.done);
			} catch {
				// A line cut short by the crash itself.
			}
		}
		return [...left];
	}

	#write(entry: { add: string } | { done: string }): Promise<void> {
		if ("add" in entry) this.#pending = true;
		return this.#then(() => this.#writeFile(this.file, `${JSON.stringify(entry)}\n`, "a"));
	}

	#then(step: () => Promise<void>): Promise<void> {
		const next = this.#queue.then(step).catch((e: unknown) => {
			if (this.#warned) return;
			this.#warned = true;
			console.warn(`omp-webui: the list of staged files ${this.file} could not be written (${(e as Error).message})`);
		});
		this.#queue = next;
		return next;
	}

	/** Private (`0600`: the paths are the person's), and no link is followed. */
	async #writeFile(path: string, text: string, how: "a" | "w"): Promise<void> {
		const flags =
			constants.O_WRONLY |
			constants.O_CREAT |
			constants.O_NOFOLLOW |
			(how === "a" ? constants.O_APPEND : constants.O_TRUNC);
		const handle = await open(path, flags, 0o600);
		try {
			await handle.writeFile(text);
			await handle.chmod(0o600);
		} finally {
			await handle.close();
		}
	}
}
