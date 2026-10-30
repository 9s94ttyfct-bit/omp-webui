import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HIGH_WATER, ServerLink } from "../../server/omp/relay.ts";
import { Backlog } from "../../server/omp/relay-backlog.ts";
import { encodeFrame, FROM_RELAY } from "../../server/omp/relay-protocol.ts";

/**
 * What the relay keeps of omp's output while no server is connected: whole frames, oldest first, in memory and then in
 * a file of its own, up to a bound; and how `ServerLink` hands it over before anything newer.
 */

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
	const dir = mkdtempSync("/tmp/ompw-bl-");
	dirs.push(dir);
	return dir;
}

/** A frame of `size` bytes in all, filled with `fill`. */
function frame(size: number, fill: number): Buffer {
	return encodeFrame(FROM_RELAY.stdout, Buffer.alloc(size - 5, fill));
}

function takeAll(backlog: Backlog, max: number): Buffer[] {
	const all: Buffer[] = [];
	while (backlog.size > 0) all.push(...backlog.take(max));
	return all;
}

test("frames come back whole and in order across memory and the file, one far bigger than a read; the file leaves no name behind", () => {
	const dir = tmp();
	const backlog = new Backlog(join(dir, "r.sock.spill"), 1000, 1 << 30);
	// Sizes that are not multiples of anything, so that reads cut inside frames: 40 small ones, one of 600 KB, 40 more.
	const sizes = [
		...Array.from({ length: 40 }, (_, i) => 200 + ((i * 37) % 300)),
		600_000,
		...Array.from({ length: 40 }, (_, i) => 5 + i),
	];
	const pushed = sizes.map((size, i) => frame(size, i));
	for (const f of pushed) expect(backlog.push(f)).toBe(true);
	expect(backlog.size).toBe(sizes.reduce((a, b) => a + b, 0));
	// Not a name in the directory: the relay's file goes with the relay, however it ends.
	expect(readdirSync(dir)).toEqual([]);

	const got = takeAll(backlog, 4096);
	expect(got.length).toBe(pushed.length);
	for (let i = 0; i < got.length; i++) expect(got[i].equals(pushed[i])).toBe(true);
	expect(backlog.size).toBe(0);

	// Empty again: the next frame is kept like the first.
	const again = frame(3000, 9);
	expect(backlog.push(again)).toBe(true);
	expect(takeAll(backlog, 1)[0].equals(again)).toBe(true);
	backlog.close();
});

test("what is kept stops at the bound, and room is made by taking: omp waits only beyond it", () => {
	const backlog = new Backlog(join(tmp(), "r.sock.spill"), 300, 1000);
	let kept = 0;
	while (backlog.push(frame(100, kept))) kept++;
	expect(kept).toBe(10);
	expect(backlog.size).toBe(1000);
	expect(backlog.take(100)).toHaveLength(1);
	expect(backlog.push(frame(100, 99))).toBe(true);
	expect(backlog.push(frame(100, 98))).toBe(false);
	backlog.close();
});

test("a frame bigger than the bound is kept when nothing else is, so that omp can still go on; one that has no file is limited to memory", () => {
	const backlog = new Backlog(join(tmp(), "r.sock.spill"), 300, 1000);
	const huge = frame(5000, 1);
	expect(backlog.push(huge)).toBe(true);
	expect(backlog.push(frame(10, 2))).toBe(false);
	expect(backlog.take(1)[0].equals(huge)).toBe(true);
	backlog.close();

	const memoryOnly = new Backlog(null, 300);
	expect(memoryOnly.push(frame(200, 1))).toBe(true);
	expect(memoryOnly.push(frame(200, 2))).toBe(false);
});

test("a file that cannot be made is a full backlog, not a crash", () => {
	const backlog = new Backlog(join(tmp(), "no-such-dir", "r.sock.spill"), 100, 1000);
	expect(backlog.push(frame(80, 1))).toBe(true);
	expect(backlog.push(frame(80, 2))).toBe(false);
	expect(backlog.take(1)).toHaveLength(1);
});

class RecordingSocket {
	/** What the peer will still take. */
	room = Number.POSITIVE_INFINITY;
	chunks: Buffer[] = [];

	write(data: Uint8Array): number {
		const n = Math.min(this.room, data.length);
		this.room -= n;
		this.chunks.push(Buffer.from(data.subarray(0, n)));
		return n;
	}

	flush(): void {}

	end(): void {}

	get bytes(): Buffer {
		return Buffer.concat(this.chunks);
	}
}

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

test("output that comes while the kept output is still being given to a server is kept behind it: the server reads it all in order", async () => {
	const link = new ServerLink();
	link.hold = true;
	// Each bigger than what the relay lets pile up for a server (HIGH_WATER): giving it the first stops the replay.
	const size = HIGH_WATER + 200_000;
	const first = frame(size, 0x61);
	const second = frame(size, 0x62);
	await link.deliver(FROM_RELAY.stdout, first.subarray(5));
	await link.deliver(FROM_RELAY.stdout, second.subarray(5));

	const socket = new RecordingSocket();
	socket.room = 0;
	const attached = link.attach(socket);
	const replaying = link.replay(attached);
	await settle();
	// The server takes nothing: the replay waits with the second still kept, and the third has to go behind it.
	const third = frame(100, 0x63);
	let delivered = false;
	const late = link.deliver(FROM_RELAY.stdout, third.subarray(5)).then(() => {
		delivered = true;
	});
	await late;
	expect(delivered).toBe(true);
	expect(link.backlog.size).toBe(second.length + third.length);

	socket.room = Number.POSITIVE_INFINITY;
	attached.out.drain();
	await replaying;
	expect(socket.bytes.equals(Buffer.concat([first, second, third]))).toBe(true);

	// All given: what comes now goes straight to the server.
	const live = frame(50, 0x64);
	await link.deliver(FROM_RELAY.stdout, live.subarray(5));
	expect(link.backlog.size).toBe(0);
	expect(socket.bytes.subarray(-live.length).equals(live)).toBe(true);
});

test("at the bound omp waits for room, and goes on when the next server has taken what was kept", async () => {
	const link = new ServerLink(new Backlog(null, 1000));
	link.hold = true;
	await link.deliver(FROM_RELAY.stdout, Buffer.alloc(595, 1));
	let waited = true;
	const full = link.deliver(FROM_RELAY.stdout, Buffer.alloc(595, 2)).then(() => {
		waited = false;
	});
	await settle();
	expect(waited).toBe(true);

	const socket = new RecordingSocket();
	const attached = link.attach(socket);
	await link.replay(attached);
	await full;
	expect(waited).toBe(false);
	// The first came from the replay; the one that waited went straight on behind it.
	expect(socket.bytes.equals(Buffer.concat([frame(600, 1), frame(600, 2)]))).toBe(true);
});
