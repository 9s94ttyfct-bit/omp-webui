import type { SessionEntry } from "@shared/protocol.ts";
import { BLOB_REF, isBlobHash } from "./blob.ts";
import { Fold } from "./lineage.ts";

/** Display model for omp's AgentMessage union (omp docs: session.md "message"). */

export interface Usage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; total?: number };
}

export interface ContentBlock {
	type: string;
	text?: string;
	thinking?: string;
	/** A thinking block the model addressed to the user: omp shows it as answer text (omp 18.12 `narration`). */
	narration?: boolean;
	redacted?: boolean;
	id?: string;
	name?: string;
	arguments?: Record<string, unknown>;
	data?: string;
	mimeType?: string;
}

/** What omp recorded on a failed assistant message once a retry got past it (`status: "recovered"`), or made it moot. */
export interface RetryRecovery {
	kind?: string;
	status: string;
	/** The attempt that succeeded. */
	attempt?: number;
	recovery?: string;
	note?: string;
}

export interface AgentMessage {
	role: string;
	content?: string | ContentBlock[];
	usage?: Usage;
	api?: string;
	provider?: string;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	retryRecovery?: RetryRecovery;
	timestamp?: number;
	/** Assistant messages: how long the model request took, in ms. */
	duration?: number;
	/** Assistant messages: time from sending the request to its first token, in ms. */
	ttft?: number;
	/** Assistant messages: when the message ended (`timestamp` is when it started), ms since the epoch. */
	completedAt?: number;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	details?: unknown;
	attribution?: string;
	command?: string;
	code?: string;
	output?: string;
	exitCode?: number;
	customType?: string;
	display?: boolean;
	summary?: string;
	/** `fileMention`: files omp read for `@path` mentions in the prompt. */
	files?: { path: string; content?: string; lineCount?: number }[];
}

export function isAgentMessage(v: unknown): v is AgentMessage {
	return Boolean(v) && typeof v === "object" && v !== null && "role" in v && typeof v.role === "string";
}

export function messageOf(e: SessionEntry): AgentMessage | null {
	return e.type === "message" && isAgentMessage(e.message) ? e.message : null;
}

export function roleOf(e: SessionEntry): string | null {
	return messageOf(e)?.role ?? null;
}

/**
 * A content block that is not one the page can read: it keeps the place the file gave it (an index is what a streamed
 * block is told by) and says nothing, and every reader passes over a type it does not know.
 */
export const UNKNOWN_BLOCK: ContentBlock = Object.freeze({ type: "unknown" });

type FieldKind = "string" | "boolean" | "object";

/** The fields the page reads of each kind of block, and what each has to be. */
const FIELDS: Record<string, Record<string, FieldKind>> = {
	text: { text: "string" },
	thinking: { thinking: "string", narration: "boolean", redacted: "boolean" },
	toolCall: { id: "string", name: "string", arguments: "object" },
	image: { data: "string", mimeType: "string" },
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const isKind = (v: unknown, kind: FieldKind): boolean => (kind === "object" ? isRecord(v) : typeof v === kind);

/**
 * `value`, an element of a message's `content`, as a block the page can read. A session file says whatever it says (a hand
 * edit, an interrupted write, another version of omp or another tool wrote it), and a `null`, a number, an object with no
 * `type` or a `text` that is not a string used to throw wherever it was read first, which took the whole chat page down
 * with it. What is not an object with a string `type` is `UNKNOWN_BLOCK`; a field of the wrong type is left out, so it
 * reads as absent. A block that is already as it should be is returned as it is.
 */
export function contentBlock(value: unknown): ContentBlock {
	if (!isRecord(value) || typeof value.type !== "string") return UNKNOWN_BLOCK;
	const fields = Object.hasOwn(FIELDS, value.type) ? FIELDS[value.type] : undefined;
	if (!fields) return value as unknown as ContentBlock;
	const bad = Object.entries(fields).filter(([name, kind]) => value[name] !== undefined && !isKind(value[name], kind));
	if (bad.length === 0) return value as unknown as ContentBlock;
	const clean = { ...value };
	for (const [name] of bad) delete clean[name];
	return clean as unknown as ContentBlock;
}

const NO_BLOCKS: ContentBlock[] = Object.freeze([]) as unknown as ContentBlock[];
/** What `blocks` made of each `content` array it has read: a message's blocks are read many times and made once. */
const read = new WeakMap<object, ContentBlock[]>();

/**
 * The content blocks of a message, every one of them readable (see `contentBlock`): its `content` array itself when it
 * has nothing to correct, so a message that is as it should be costs nothing and keeps its identity. A `content` that is
 * a string is one text block; one that is neither a string nor an array has no blocks.
 */
export function blocks(m: AgentMessage): ContentBlock[] {
	const content: unknown = m.content;
	if (typeof content === "string") return [{ type: "text", text: content }];
	if (!Array.isArray(content)) return NO_BLOCKS;
	let out = read.get(content);
	if (!out) {
		const mapped = content.map(contentBlock);
		out = mapped.every((b, i) => b === content[i]) ? (content as ContentBlock[]) : mapped;
		read.set(content, out);
	}
	return out;
}

/** The words the reader sees as the message: its text blocks and its narration (thinking blocks omp marks as answer text). */
export function textOf(m: AgentMessage): string {
	return blocks(m)
		.filter((b) => b.type === "text" || (b.type === "thinking" && b.narration))
		.map((b) => (b.type === "text" ? b.text : b.thinking) ?? "")
		.join("\n");
}

/** An attachment as omp's `prompt` command takes it. */
export interface PromptImage {
	type: "image";
	data: string;
	mimeType: string;
}

const IMAGE_TYPE = /^image\/[\w.+-]+$/i;

/**
 * Where an image block can be loaded from: omp keeps large images outside the transcript as
 * `blob:sha256:<hash>` references (served by `/api/blob`); live results carry base64. Null for a
 * reference that is not a sha256, so nothing else is ever fetched.
 */
export function imageSrc(data: string, mimeType?: string): string | null {
	if (data.startsWith(BLOB_REF)) {
		const hash = data.slice(BLOB_REF.length);
		return isBlobHash(hash) ? `/api/blob/${hash}` : null;
	}
	return `data:${mimeType && IMAGE_TYPE.test(mimeType) ? mimeType : "image/png"};base64,${data}`;
}

/** An image of a tool result, ready for an `<img>`. */
export interface ResultImage {
	src: string;
	mimeType: string;
}

/** The images among a tool result's content blocks (a saved result's `content`, or a live one's). */
export function imagesOf(content: unknown): ResultImage[] {
	if (!Array.isArray(content)) return [];
	const out: ResultImage[] = [];
	for (const b of content as ContentBlock[]) {
		if (b?.type !== "image" || typeof b.data !== "string" || !b.data) continue;
		const src = imageSrc(b.data, b.mimeType);
		if (src) out.push({ src, mimeType: b.mimeType ?? "image/png" });
	}
	return out;
}

/** The sha256 a `blob:sha256:<hash>` reference names; anything else is not a stored image and is never requested. */
function storedHash(reference: string): string {
	const hash = reference.slice(BLOB_REF.length);
	if (!isBlobHash(hash)) throw new Error("An image of this prompt is not a stored image");
	return hash;
}

/**
 * A prompt's images, ready to send again. omp keeps large images outside the transcript as
 * `blob:sha256:<hash>` references; `loadBlob` turns one back into base64. Order is kept, and an image
 * that cannot be loaded fails the whole call rather than being left out.
 */
export async function promptImages(
	m: AgentMessage,
	loadBlob: (hash: string) => Promise<string>,
): Promise<PromptImage[]> {
	const stored = blocks(m).flatMap((b) =>
		b.type === "image" && b.data ? [{ data: b.data, mimeType: b.mimeType ?? "image/png" }] : [],
	);
	return Promise.all(
		stored.map(async ({ data, mimeType }) => ({
			type: "image" as const,
			data: data.startsWith(BLOB_REF) ? await loadBlob(storedHash(data)) : data,
			mimeType,
		})),
	);
}

/** Tool results by toolCallId, so tool-call cards can show their output inline. */
export function toolResultsById(entries: SessionEntry[]): Map<string, AgentMessage> {
	const out = new Map<string, AgentMessage>();
	for (const e of entries) {
		const m = messageOf(e);
		if (m?.role === "toolResult" && m.toolCallId) out.set(m.toolCallId, m);
	}
	return out;
}

/** What a tool card asks of the saved results: the one for its call. */
export interface ToolResults {
	get(id: string): AgentMessage | undefined;
}

/**
 * The saved results of tool calls as a log that only grows, so that taking a snapshot of it costs nothing: a snapshot
 * answers for the results the log held when it was taken, which is what `toolResultsById` of the entries then
 * would have said. The saved results change with every step of a goal run, and a map made anew for each of them is
 * work proportional to the whole conversation.
 */
export class ToolResultLog {
	private readonly calls = new Map<string, { message: AgentMessage; at: number }>();
	private readonly order: string[] = [];

	/**
	 * Add what an entry holds, if it is a tool's result. False when that call already has another result: a snapshot
	 * cannot say both, and the caller derives the results anew.
	 */
	add(e: SessionEntry): boolean {
		const m = messageOf(e);
		if (m?.role !== "toolResult" || !m.toolCallId) return true;
		const known = this.calls.get(m.toolCallId);
		if (known) return known.message === m;
		this.calls.set(m.toolCallId, { message: m, at: this.order.length });
		this.order.push(m.toolCallId);
		return true;
	}

	snapshot(): ToolResults {
		return new ToolResultSnapshot(this, this.order.length);
	}

	/** @internal */
	resultAt(id: string, count: number): AgentMessage | undefined {
		const c = this.calls.get(id);
		return c && c.at < count ? c.message : undefined;
	}

	/** @internal */
	idsBetween(from: number, to: number): string[] {
		return this.order.slice(from, to);
	}
}

class ToolResultSnapshot implements ToolResults {
	constructor(
		readonly log: ToolResultLog,
		readonly count: number,
	) {}

	get(id: string): AgentMessage | undefined {
		return this.log.resultAt(id, this.count);
	}
}

/**
 * The calls whose saved result `now` has and `before` did not; null when that is not known (they are not snapshots of
 * one log), in which case every call has to be looked at.
 */
export function resultsAdded(before: ToolResults, now: ToolResults): readonly string[] | null {
	if (before === now) return [];
	if (!(before instanceof ToolResultSnapshot) || !(now instanceof ToolResultSnapshot)) return null;
	if (before.log !== now.log || before.count > now.count) return null;
	return now.log.idsBetween(before.count, now.count);
}

/** Entries that render as a visible row in the transcript. */
export function isVisible(e: SessionEntry): boolean {
	if (e.type === "message") {
		const m = messageOf(e);
		return Boolean(m && m.role !== "toolResult");
	}
	if (e.type === "custom_message") return e.display !== false;
	return (
		e.type === "branch_summary" || e.type === "compaction" || e.type === "model_change" || e.type === "live_notice"
	);
}

/** The timestamps of the messages a path holds: which streamed messages the saved transcript has by now. */
export function savedTimestamps(path: SessionEntry[]): ReadonlySet<number> {
	return timestamps.run(path);
}

const timestamps = new Fold<SessionEntry, Set<number>>(
	() => new Set(),
	(seen, path, from) => {
		for (let i = from; i < path.length; i++) {
			const at = messageOf(path[i])?.timestamp;
			if (at) seen.add(at);
		}
		return seen;
	},
	true,
);
