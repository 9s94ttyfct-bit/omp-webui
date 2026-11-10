import { isRecord } from "./guards.ts";
import type { HostToolDefinition } from "./guided-goal.ts";

/**
 * Copy files and folders between this computer and another (`remote_copy`), beside `remote_run` (`shared/remote-run.ts`): the
 * same conversations are served it, for the same computers, and it reaches them with the same sign-in. The bytes go over the
 * remote computer's own HTTP routes through its tunnel (`server/remote-run/files.ts` answers them there, 0.23.1 and later),
 * not through its terminal, so a file of a gigabyte is as quick as the tunnel is.
 *
 *   GET    /api/remote-run/file?path=                 a file's bytes, or a folder as a tar; `COPY_HEADERS` say which, and how much
 *   POST   /api/remote-run/file?path=&kind=&size=&bytes=&overwrite=0|1[&mode=&mtime=]   begin receiving one (`{ id, path }`):
 *                                                     the target is checked and its folders made; nothing is at it yet
 *   PUT    /api/remote-run/file/<id>?offset=          the next piece (at most `REMOTE_COPY_PIECE.max`), answered `{ received }`
 *   POST   /api/remote-run/file/<id>                  every piece is there: put it in place (`CopyDone`)
 *   DELETE /api/remote-run/file/<id>                  give it up; what arrived is removed
 *
 * A file goes as it is; a folder as a tar (`server/remote-run/tar.ts`): its folders, files and the links that stay inside it,
 * which the side that receives it unpacks as it arrives and refuses when an entry would leave the folder. Pieces, because
 * Cloudflare takes at most 100 MB in one request on the plans most people have. A failure is `{ error, code }`
 * (`RemoteCopyCode`) with the status of `COPY_STATUS`.
 *
 * This module is the contract both sides read: the tool, its arguments, the routes' names and limits, and what a call is
 * told. Pure: no I/O.
 */

/** The tool's name. */
export const REMOTE_COPY_TOOL = "remote_copy";

/** The remote computer's route (and, with `/<id>`, an upload's). Owner-only, as every `/api/remote-run*` route is. */
export const REMOTE_COPY_ROUTE = "/api/remote-run/file";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/** The most one call copies: the bytes of its files, before anything is packed. */
export const REMOTE_COPY_MAX_BYTES = 2 * GiB;
/** The most entries (files, folders, links) a folder copied may hold. */
export const REMOTE_COPY_MAX_ENTRIES = 200_000;
/** What one upload request carries: a piece sent, and the most the remote computer takes (413 past it). */
export const REMOTE_COPY_PIECE = { bytes: 32 * MiB, max: 64 * MiB } as const;
/** How long a call may take in all. */
export const REMOTE_COPY_TIMEOUT_MS = 30 * 60_000;
/** How long an upload that is not finished waits for its next piece before it is given up, in ms. */
export const REMOTE_COPY_IDLE_MS = 10 * 60_000;

/** What a download answers in its headers: what it is (`file`, `folder`), its files and their bytes, what was left out, and where it is. */
export const COPY_HEADERS = {
	kind: "x-omp-webui-kind",
	files: "x-omp-webui-files",
	bytes: "x-omp-webui-bytes",
	leftOut: "x-omp-webui-left-out",
	/** The path it was read from on that computer, URI-encoded (a header holds no other characters). */
	path: "x-omp-webui-path",
	/** The permission bits (octal) and the time (seconds) of the file or folder itself; a folder's entries carry their own. */
	mode: "x-omp-webui-mode",
	mtime: "x-omp-webui-mtime",
} as const;

export type CopyKind = "file" | "folder";

/** Why a copy was refused or failed. */
export type RemoteCopyCode =
	/** A path or a value of the request is not one. */
	| "badRequest"
	/** Nothing is at the path to copy. */
	| "notFound"
	/** Something is at the target and `overwrite` was not asked for. */
	| "exists"
	/** A part of the target's path is a file, not a folder. */
	| "parentNotFolder"
	/** More than `REMOTE_COPY_MAX_BYTES`, or more entries than `REMOTE_COPY_MAX_ENTRIES`. */
	| "tooLarge"
	/** The target is in a folder an omp-webui keeps its own data in (or holds one). */
	| "ownData"
	/** The target is the root, the home folder, or a folder that holds it. */
	| "broad"
	/** The disk would keep less than 1 GB / 5 % free. */
	| "diskFull"
	/** The folder's tar names an entry that leads out of it, a link that does, or something that is not copied. */
	| "badArchive"
	/** A file changed while it was sent. */
	| "changed"
	/** The file system refused (no permission). */
	| "refused"
	/** A piece came for another place in the upload than where it stands; `received` says where. */
	| "offset"
	/** No upload has that id (finished, given up, or expired). */
	| "unknownUpload"
	/** The upload was finished before every piece was there. */
	| "incomplete";

export const COPY_STATUS: Record<RemoteCopyCode, number> = {
	badRequest: 400,
	notFound: 404,
	exists: 409,
	parentNotFolder: 409,
	tooLarge: 413,
	ownData: 403,
	broad: 403,
	diskFull: 507,
	badArchive: 400,
	changed: 409,
	refused: 403,
	offset: 409,
	unknownUpload: 404,
	incomplete: 409,
};

const CODES = new Set(Object.keys(COPY_STATUS));
export const isRemoteCopyCode = (v: unknown): v is RemoteCopyCode => typeof v === "string" && CODES.has(v);

/**
 * A copy refused or failed, on either side: `code` says why, `message` in words a model can act on, and `there` whether the
 * other computer said so (its answer to a request) rather than this one.
 */
export class RemoteCopyError extends Error {
	constructor(
		message: string,
		readonly code: RemoteCopyCode,
		readonly there = false,
	) {
		super(message);
	}
	get status(): number {
		return COPY_STATUS[this.code];
	}
}

/** What `POST /api/remote-run/file/<id>` answers: what was put in place, and where. */
export interface CopyDone {
	path: string;
	kind: CopyKind;
	files: number;
	bytes: number;
	/** Something was there and was replaced (`overwrite`). */
	replaced: boolean;
}

/**
 * The tool as omp is told of it, for a conversation given `computers` (their names). Served with `remote_run`, in the same
 * set (`server/remote-run/service.ts`).
 */
export function remoteCopyTool(computers: readonly string[]): HostToolDefinition {
	return {
		name: REMOTE_COPY_TOOL,
		label: "Copy to or from a remote computer",
		loadMode: "essential",
		description:
			`Copy a file or a folder between this computer and one of the person's other computers: ${computers.map((c) => JSON.stringify(c)).join(", ")}. ` +
			'direction "to" copies local (on this computer) to remote (on that computer); "from" copies remote to local. ' +
			"local: a path on this computer, relative to this conversation's folder, or absolute, or ~/… for this computer's home. " +
			"remote: a path on that computer, absolute or ~/… (relative: to its home folder). " +
			"A folder is copied whole, with everything in it; links inside it are copied as links when they stay inside it (others, and special files, are left out and counted). " +
			`At most ${REMOTE_COPY_MAX_BYTES / GiB} GB of files per call. Missing folders above the target are made. ` +
			"The target must not exist unless overwrite is true: then it is replaced whole (a folder by the folder copied, not merged into). " +
			"Use this instead of cat, base64 or heredocs through remote_run.",
		parameters: {
			type: "object",
			properties: {
				computer: {
					type: "string",
					enum: [...computers],
					description: "The other computer, by its name.",
				},
				direction: {
					type: "string",
					enum: ["to", "from"],
					description: '"to": this computer → that one; "from": that computer → this one.',
				},
				local: {
					type: "string",
					description: "The path on this computer: relative to this conversation's folder, absolute, or ~/….",
				},
				remote: {
					type: "string",
					description: "The path on that computer: absolute or ~/… (relative: to its home folder).",
				},
				overwrite: {
					type: "boolean",
					description: "Replace what is at the target (default false: the call fails if something is there).",
				},
			},
			required: ["computer", "direction", "local", "remote"],
			additionalProperties: false,
		},
	};
}

/** A call's arguments as they were checked. */
export interface RemoteCopyArgs {
	computer: string;
	direction: "to" | "from";
	local: string;
	remote: string;
	overwrite: boolean;
}

/** A path as a call or a request may name it: some text, on one line, with no control character. */
export function pathProblem(name: string, value: unknown): string | null {
	if (typeof value !== "string" || value.trim() === "") return `${name} must be a path.`;
	if (value.length > 4096) return `${name} is too long to be a path.`;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused.
	if (/[\u0000-\u001f\u007f]/.test(value)) return `${name} must be one line, with no control characters.`;
	return null;
}

/** The arguments of a call as the model sent them, checked against `computers`, or why they are refused. */
export function parseRemoteCopyArgs(args: unknown, computers: readonly string[]): RemoteCopyArgs | { error: string } {
	if (!isRecord(args)) return { error: "Give the computer, the direction and the two paths." };
	const names = computers.map((c) => JSON.stringify(c)).join(", ");
	if (typeof args.computer !== "string" || !computers.includes(args.computer))
		return { error: `computer must be one of the computers this conversation was given: ${names}.` };
	if (args.direction !== "to" && args.direction !== "from")
		return { error: 'direction must be "to" (this computer → that one) or "from" (that computer → this one).' };
	const problem = pathProblem("local", args.local) ?? pathProblem("remote", args.remote);
	if (problem) return { error: problem };
	if (args.overwrite !== undefined && args.overwrite !== null && typeof args.overwrite !== "boolean")
		return { error: "overwrite must be true or false." };
	return {
		computer: args.computer,
		direction: args.direction,
		local: args.local as string,
		remote: args.remote as string,
		overwrite: args.overwrite === true,
	};
}

/** Bytes as a person reads them: `512 bytes`, `1.5 MB` (powers of 1000, as Finder counts). */
export function bytesText(n: number): string {
	if (n < 1000) return `${n} ${n === 1 ? "byte" : "bytes"}`;
	const units = ["KB", "MB", "GB", "TB"];
	let v = n / 1000;
	let i = 0;
	while (v >= 1000 && i < units.length - 1) {
		v /= 1000;
		i++;
	}
	return `${v.toFixed(1)} ${units[i]}`;
}

/** What a copy came to, for `describeCopy`. */
export interface RemoteCopyResult {
	kind: CopyKind;
	files: number;
	bytes: number;
	/** Links that lead out of the folder, and special files (sockets, devices): not copied. */
	leftOut: number;
	/** Something was at the target and was replaced. */
	replaced: boolean;
	/** Where it was read and where it was put, each on its computer, as resolved there. */
	from: string;
	to: string;
	ms: number;
}

/** What the agent is told of a copy: one line of what came of it, then where from and where to. */
export function describeCopy(name: string, direction: "to" | "from", r: RemoteCopyResult): string {
	const files = `${r.files} ${r.files === 1 ? "file" : "files"}`;
	const lines = [`${name} · copied ${files}, ${bytesText(r.bytes)} · ${(r.ms / 1000).toFixed(1)}s`];
	const here = "this computer";
	lines.push(`From: ${r.from} (${direction === "to" ? here : name})`);
	lines.push(`To: ${r.to} (${direction === "to" ? name : here})`);
	if (r.replaced) lines.push("What was at the target was replaced.");
	if (r.leftOut > 0)
		lines.push(
			`Left out: ${r.leftOut} ${r.leftOut === 1 ? "entry" : "entries"} (links that lead out of the folder, or special files).`,
		);
	return lines.join("\n");
}
