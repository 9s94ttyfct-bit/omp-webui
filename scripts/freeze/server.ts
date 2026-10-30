#!/usr/bin/env bun
import { heapStats } from "bun:jsc";
/**
 * The web UI's server, run for the long-run harness (scripts/freeze/run.ts) with a monitor beside it. The monitor
 * lives in the server's own process, so what it reads is what the server's one thread went through:
 *
 * - event-loop lag: a 10 ms timer's drift. Whatever blocks the thread (a parse, a gzip, a scan) delays it by as much.
 * - memory: RSS, the JS heap, objects.
 * - the session index's work per change: scans, files summarized, subagent transcripts read again.
 *
 * One JSON line per second goes to FREEZE_MONITOR. The server itself is `server/main.ts`, unchanged.
 */
import { appendFileSync } from "node:fs";
import { RelayProc } from "../../server/omp/relay-client.ts";
import { RpcClient } from "../../server/omp/rpc-client.ts";
import { SessionStore } from "../../server/sessions/store.ts";
import { SubagentIndex } from "../../server/sessions/subagents.ts";
import { WsOutbox } from "../../server/ws-out.ts";

const log = process.env.FREEZE_MONITOR ?? "freeze-monitor.jsonl";

interface Work {
	calls: number;
	ms: number;
	bytes: number;
	/** The longest single call that did not return a promise, ms. */
	maxMs: number;
}
const work: Record<string, Work> = {};

type Method = (...args: unknown[]) => unknown;

/** The `size` of a file's stat, as the methods below are passed it. */
function sizeOf(stat: unknown): number {
	return typeof stat === "object" && stat !== null && "size" in stat && typeof stat.size === "number" ? stat.size : 0;
}

/** Count and time every call of `proto[name]` (a promise's whole wait included), and the bytes it reads, as `bytes` says from the instance and the arguments. */
function instrument(proto: object, name: string, bytes: (self: object, args: unknown[]) => number): void {
	// A method of a class of the server, found by name: the shape is whatever the class says.
	const original = Reflect.get(proto, name) as Method;
	Reflect.set(proto, name, function (this: object, ...args: unknown[]) {
		let w = work[name];
		if (!w) {
			w = { calls: 0, ms: 0, bytes: 0, maxMs: 0 };
			work[name] = w;
		}
		const counted = w;
		const began = performance.now();
		w.calls++;
		w.bytes += bytes(this, args);
		const result = original.apply(this, args);
		if (result instanceof Promise) {
			return result.finally(() => {
				counted.ms += performance.now() - began;
			});
		}
		const spent = performance.now() - began;
		counted.ms += spent;
		counted.maxMs = Math.max(counted.maxMs, spent);
		return result;
	});
}

// The steps of the path a large answer takes on the server's thread, by the longest single call (`maxMs`): what holds the loop is one call, not their sum.
instrument(RpcClient.prototype, "acceptChunk", () => 0);
instrument(RpcClient.prototype, "handleLine", () => 0);
instrument(RelayProc.prototype, "receive", () => 0);
instrument(WsOutbox.prototype, "send", (_out, args) => (typeof args[0] === "string" ? args[0].length : 0));
instrument(SessionStore.prototype, "scan", () => 0);
// A file that grew is read from where its summary stopped (`tails`), not from its start.
instrument(SessionStore.prototype, "summarizeFile", (store, args) => {
	const tails = Reflect.get(store, "tails") as Map<string, { upto: number }>;
	return Math.max(0, sizeOf(args[1]) - (tails.get(String(args[0]))?.upto ?? 0));
});
instrument(SubagentIndex.prototype, "parse", (_index, args) => sizeOf(args[2]));

// What the subagent index says it read (`bytesRead`), where it counts: the whole file is what the wrapper above can see of a read.
let subagentIndex: object | null = null;
const parseSubagent = Reflect.get(SubagentIndex.prototype, "parse") as Method;
Reflect.set(SubagentIndex.prototype, "parse", function (this: object, ...args: unknown[]) {
	subagentIndex = this;
	return parseSubagent.apply(this, args);
});

/** The parts of Bun's `ServerWebSocket` the monitor looks at. */
interface SocketSends {
	send(data: string, compress?: boolean): number;
	getBufferedAmount(): number;
}

/** Count what is `amount` of `name`: calls, and bytes (or, for a maximum, the largest). */
function tally(name: string, bytes: number, max = false): void {
	let w = work[name];
	if (!w) {
		w = { calls: 0, ms: 0, bytes: 0, maxMs: 0 };
		work[name] = w;
	}
	w.calls++;
	w.bytes = max ? Math.max(w.bytes, bytes) : w.bytes + bytes;
}

// Every message the server sends over a WebSocket: how many Bun throws away (a send that comes back 0), and the most it ever holds for one socket.
const serve = Bun.serve.bind(Bun);
Reflect.set(Bun, "serve", (options: { websocket?: { open?: (ws: SocketSends) => unknown } }) => {
	const handlers = options.websocket;
	const open = handlers?.open;
	if (handlers && open) {
		handlers.open = (ws) => {
			const send = ws.send.bind(ws);
			ws.send = (data, compress) => {
				const result = send(data, compress);
				tally("wsSend", data.length);
				if (result === 0) tally("wsDropped", data.length);
				tally("wsBuffered", ws.getBufferedAmount(), true);
				return result;
			};
			return open.call(handlers, ws);
		};
	}
	return serve(options as never);
});

// Event-loop lag: a timer every 10 ms, and how late each tick was. Memory is looked at on the same tick, for the peak of each second:
// a collection that has not run yet leaves what a request needed standing, and that is what shows.
const TICK = 10;
let lags: number[] = [];
let last = performance.now();
let peakHeap = 0;
let peakRss = 0;
setInterval(() => {
	const now = performance.now();
	lags.push(Math.max(0, now - last - TICK));
	last = now;
	const mem = process.memoryUsage();
	peakHeap = Math.max(peakHeap, mem.heapUsed);
	peakRss = Math.max(peakRss, mem.rss);
}, TICK);

const quantile = (sorted: number[], q: number): number =>
	sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
const round = (n: number): number => Math.round(n * 10) / 10;
let second = 0;
setInterval(() => {
	const sorted = lags.sort((a, b) => a - b);
	lags = [];
	const mem = process.memoryUsage();
	const heap = heapStats();
	const sample: Record<string, unknown> = {
		t: Date.now(),
		second: second++,
		lagMax: round(quantile(sorted, 1)),
		lagP99: round(quantile(sorted, 0.99)),
		lagP50: round(quantile(sorted, 0.5)),
		ticks: sorted.length,
		peakHeap,
		peakRss,
		rss: mem.rss,
		heapUsed: mem.heapUsed,
		external: mem.external,
		arrayBuffers: mem.arrayBuffers,
		objects: heap.objectCount,
		heapSize: heap.heapSize,
		extra: heap.extraMemorySize,
		work,
		subBytesRead: subagentIndex === null ? undefined : Reflect.get(subagentIndex, "bytesRead"),
		// CPU time the process has used so far, µs: what the server costs, whether or not it is ever late.
		cpu: process.cpuUsage().user + process.cpuUsage().system,
	};
	appendFileSync(log, `${JSON.stringify(sample)}\n`);
	peakHeap = 0;
	peakRss = 0;
	// Once a minute, a full collection: what is still there afterwards is what the server holds on to, whatever the collector had
	// not got round to. Its pause is the probe's doing, not the server's: it is left out of the lag.
	if (second % 60 === 0) {
		const began = performance.now();
		Bun.gc(true);
		const ms = performance.now() - began;
		const after = heapStats();
		const counts = after.objectTypeCounts;
		appendFileSync(
			log,
			`${JSON.stringify({
				kind: "gc",
				t: Date.now(),
				second,
				ms: round(ms),
				rss: process.memoryUsage().rss,
				heapUsed: process.memoryUsage().heapUsed,
				objects: after.objectCount,
				functions: counts.Function,
				lexicalEnvironments: counts.JSLexicalEnvironment,
				promises: counts.Promise,
				types: Object.fromEntries(
					Object.entries(counts)
						.sort((a, b) => b[1] - a[1])
						.slice(0, 12),
				),
			})}\n`,
		);
		lags = [];
		last = performance.now();
	}
}, 1000);

// The patches above must be in place before the server's modules run, which a static import would not allow.
await import("../../server/main.ts");
