import type { Page, WebSocketRoute } from "@playwright/test";
import { ReplyAssembler } from "../../shared/reply-parts.ts";
import { isOverStatus } from "../../shared/subagent-status.ts";

/** An omp RPC command, the `command` of an `rpc` message. */
export interface Command {
	type?: string;
	[key: string]: unknown;
}

/** A JSON message on the socket; only the fields specs look at are typed. */
export interface Msg {
	t?: string;
	req?: string;
	command?: Command;
	/** Where an `open` request starts omp (`guidance`: what the main agent is told, #641). */
	target?: {
		kind?: string;
		cwd?: string;
		args?: string[];
		guidance?: { template?: string; text?: string };
		/** Whether the conversation starts unattended (#646). */
		unattended?: boolean;
	};
	[key: string]: unknown;
}

type Reply = { ok: true; data?: unknown } | { ok: false; error: string };

/**
 * What a spec sees of the page's WebSocket: every message the page sends, plus ways to push
 * frames to the page and to answer `rpc` commands without the real omp. Lets specs drive UI
 * states that otherwise need a model call (a dialog omp is waiting on, a goal, saved accounts).
 */
export interface SocketTap {
	/** Everything the page sent, in order. */
	sent: Msg[];
	/** The `rpc` commands of one type the page sent, in order. */
	commands(type: string): Command[];
	/** `data` of the real server's replies to commands of one type, in order. */
	replies(type: string): unknown[];
	/** Deliver a server → page message (a `frame`, `live`, …). */
	push(msg: Msg): void;
	/**
	 * Answer commands of one type locally; return `undefined` to let the real server take that one. An answer for
	 * `get_subagents` replaces the default one (see `tapSocket`).
	 */
	answer(type: string, handler: (command: Command) => Reply | undefined): void;
	/**
	 * Change what the real server tells the page: `fn` gets every server → page message and, for a reply, the page's
	 * request it answers, and what it returns is delivered (the same message: unchanged). For what only the server
	 * can hold and a spec cannot bring about without a model call, such as omp's own retry backoff in a `LiveInfo`.
	 */
	rewrite(fn: ((msg: Msg, request?: Msg) => Msg) | null): void;
	/** Close the page's connection, both sides: the page reconnects by itself and attaches again, missing what came meanwhile. */
	drop(): void;
}

/**
 * Install before `page.goto`: the tap sees the page's socket from its first connection.
 *
 * omp's registry (`get_subagents`, which the page reads when it attaches, on Retry, on resume and when a conversation is
 * unpaused) agrees by default with the subagent frames a spec pushed (#772): a subagent pushed as started is listed as
 * running, one pushed as over (completed, failed…) is not, on top of what the real omp lists. Without that, the page takes
 * a pushed subagent the real omp never heard of as ended at its next read (#748). A spec that sets its own answer
 * (`answer("get_subagents", …)`) gets that instead.
 */
export async function tapSocket(page: Page): Promise<SocketTap> {
	const sent: Msg[] = [];
	const handlers = new Map<string, (command: Command) => Reply | undefined>();
	/** Forwarded commands awaiting the server's reply: req → command type. */
	const awaiting = new Map<string, string>();
	const replied = new Map<string, unknown[]>();
	let rewriter: ((msg: Msg, request?: Msg) => Msg) | null = null;
	/** The parts of big replies on their way from the server. */
	const parts = new ReplyAssembler();
	/** The subagent lifecycle frames pushed, the last of each subagent, by conversation: liveId → id → payload. */
	const pushed = new Map<string, Map<string, Record<string, unknown>>>();
	/** The conversation of each `get_subagents` the real server is asked: req → liveId. */
	const registryOf = new Map<string, string>();
	/** omp's registry as the real one answered, brought up to the frames pushed to the conversation (see above). */
	const withPushed = (ours: Map<string, Record<string, unknown>>, data: unknown): unknown => {
		const record =
			data !== null && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
		const raw = Array.isArray(data) ? data : record.subagents;
		const listed = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
		const over = (id: unknown) => {
			const p = ours.get(String(id));
			return p !== undefined && isOverStatus(String(p.status));
		};
		const kept = listed.filter((s) => !over(s.id));
		const known = new Set(kept.map((s) => String(s.id)));
		const added = [...ours.values()]
			.filter((p) => !isOverStatus(String(p.status)) && !known.has(String(p.id)))
			.map((p) => ({ ...p, status: p.status === "started" ? "running" : p.status }));
		return Array.isArray(data) ? [...kept, ...added] : { ...record, subagents: [...kept, ...added] };
	};
	let current: WebSocketRoute | null = null;
	let upstream: WebSocketRoute | null = null;
	await page.routeWebSocket(/\/ws$/, (ws) => {
		current = ws;
		const server = ws.connectToServer();
		upstream = server;
		ws.onMessage((raw) => {
			// The page and the server both speak JSON; only the fields declared on `Msg` are read.
			const msg: Msg = JSON.parse(String(raw));
			sent.push(msg);
			if (msg.t === "rpc" && msg.command) {
				const reply = handlers.get(msg.command.type ?? "")?.(msg.command);
				if (reply) {
					ws.send(JSON.stringify({ t: "reply", req: msg.req, ...reply }));
					return;
				}
				awaiting.set(String(msg.req), msg.command.type ?? "");
				if (msg.command.type === "get_subagents") registryOf.set(String(msg.req), String(msg.liveId));
			}
			server.send(raw);
		});
		server.onMessage((raw) => {
			// A big reply comes in parts (see `shared/reply-parts.ts`): each goes on to the page as it is, and the reply is
			// recorded when the last has come.
			const part = parts.push(String(raw));
			if (part !== null) {
				const type = part.data === null ? undefined : awaiting.get(part.req);
				if (type !== undefined && part.data !== null) {
					awaiting.delete(part.req);
					replied.set(type, [...(replied.get(type) ?? []), JSON.parse(part.data)]);
				}
				return ws.send(raw);
			}
			const msg: Msg = JSON.parse(String(raw));
			const type = msg.t === "reply" ? awaiting.get(String(msg.req)) : undefined;
			// The registry the page is told agrees with the frames pushed to it (see `tapSocket`).
			let agreed = msg;
			if (type === "get_subagents") {
				const ours = pushed.get(registryOf.get(String(msg.req)) ?? "");
				registryOf.delete(String(msg.req));
				if (ours && msg.ok === true) agreed = { ...msg, data: withPushed(ours, msg.data) };
			}
			if (type !== undefined) {
				awaiting.delete(String(msg.req));
				replied.set(type, [...(replied.get(type) ?? []), agreed.data]);
			}
			if (!rewriter) return ws.send(agreed === msg ? raw : JSON.stringify(agreed));
			const request = msg.t === "reply" ? sent.findLast((m) => m.req === msg.req) : undefined;
			const out = rewriter(agreed, request);
			ws.send(out === msg ? raw : JSON.stringify(out));
		});
	});
	return {
		sent,
		commands: (type) => sent.flatMap((m) => (m.t === "rpc" && m.command?.type === type ? [m.command] : [])),
		replies: (type) => replied.get(type) ?? [],
		push: (msg) => {
			const frame = msg.t === "frame" ? (msg.frame as { type?: unknown; payload?: Record<string, unknown> }) : null;
			if (frame?.type === "subagent_lifecycle" && frame.payload?.id !== undefined) {
				const live = String(msg.liveId);
				const ours = pushed.get(live) ?? new Map<string, Record<string, unknown>>();
				pushed.set(live, ours);
				ours.set(String(frame.payload.id), { ...ours.get(String(frame.payload.id)), ...frame.payload });
			}
			current?.send(JSON.stringify(msg));
		},
		answer: (type, handler) => void handlers.set(type, handler),
		rewrite: (fn) => {
			rewriter = fn;
		},
		drop: () => {
			void upstream?.close();
			void current?.close();
		},
	};
}
