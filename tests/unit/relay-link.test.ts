import { expect, test } from "bun:test";
import { ServerLink } from "../../server/omp/relay.ts";
import { encodeFrame, FROM_RELAY } from "../../server/omp/relay-protocol.ts";

/**
 * How the relay hands omp's output to the server connected to it: what it waits for, and what ends the wait. No
 * process and no socket — a socket here takes only as much as it is given room for.
 */

class FakeSocket {
	/** What the peer will still take. */
	room = Number.POSITIVE_INFINITY;
	written = 0;
	ended = false;

	write(data: Uint8Array): number {
		const n = Math.min(this.room, data.length);
		this.room -= n;
		this.written += n;
		return n;
	}

	flush(): void {}

	end(): void {
		this.ended = true;
	}
}

/** A few turns of the microtask queue: what is going to settle without anything outside happening, has. */
async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** More than the relay lets pile up for a server (HIGH_WATER) before it stops reading omp. */
const BIG = Buffer.alloc(2 << 20, 0x78);

test("a server that takes the relay over from one that is not reading gets omp's output, not a wait for the old one", async () => {
	const link = new ServerLink();
	const stuck = new FakeSocket();
	stuck.room = 0;
	link.attach(stuck);

	let delivered = false;
	const waiting = link.deliver(FROM_RELAY.stdout, BIG).then(() => {
		delivered = true;
	});
	await settle();
	// The relay holds omp's output back until the server has taken what it was sent.
	expect(delivered).toBe(false);

	const next = new FakeSocket();
	link.attach(next);
	expect(stuck.ended).toBe(true);
	// Nothing is owed to the server that was replaced any more.
	await waiting;

	await link.deliver(FROM_RELAY.stdout, Buffer.from("line\n"));
	expect(next.written).toBe(5 + 5);
	expect(link.client?.socket).toBe(next);
});

test("a server that goes while the relay waits for it to take frames releases the wait; the next one gets what follows", async () => {
	const link = new ServerLink();
	link.hold = true;
	const stuck = new FakeSocket();
	stuck.room = 0;
	const gone = link.attach(stuck);

	let delivered = false;
	const waiting = link.deliver(FROM_RELAY.stdout, BIG).then(() => {
		delivered = true;
	});
	await settle();
	expect(delivered).toBe(false);

	expect(link.release(gone)).toBe(true);
	await waiting;
	expect(link.client).toBeNull();

	// Held: the next frame is kept for the next server instead of being dropped, and omp is not made to wait for it.
	await link.deliver(FROM_RELAY.stdout, Buffer.from("later\n"));
	const next = new FakeSocket();
	const attached = link.attach(next);
	expect(next.written).toBe(0);
	await link.replay(attached);
	expect(next.written).toBe(5 + 6);
});

test("a connection that was already replaced ending is not the server ending", () => {
	const link = new ServerLink();
	const first = link.attach(new FakeSocket());
	const second = link.attach(new FakeSocket());
	expect(link.release(first)).toBe(false);
	expect(link.client).toBe(second);
	expect(link.release(second)).toBe(true);
});

test("with no server connected, output is kept for the first one that comes, and dropped once one has come and gone unheld", async () => {
	const link = new ServerLink();
	// No server has connected yet: the one that started the relay is still to come. Omp is not held back meanwhile.
	await link.deliver(FROM_RELAY.stdout, Buffer.from("early\n"));
	const first = new FakeSocket();
	const attached = link.attach(first);
	expect(first.written).toBe(0);
	await link.replay(attached);
	expect(first.written).toBe(5 + 6);

	// It goes without the conversation being held: nobody will ever read what omp says now.
	link.release(link.client as NonNullable<typeof link.client>);
	await link.deliver(FROM_RELAY.stdout, Buffer.from("dropped\n"));
	expect(first.written).toBe(5 + 6);
});

test("stderr waits for the server like stdout: a server that does not take it holds omp's error output back, and nothing is kept for none", async () => {
	const link = new ServerLink();
	// No server: said to nobody, kept for nobody, and nothing to wait for.
	await link.tell(FROM_RELAY.stderr, Buffer.from("lost\n"));

	const stuck = new FakeSocket();
	stuck.room = 0;
	link.attach(stuck);
	let told = false;
	const waiting = link.tell(FROM_RELAY.stderr, BIG).then(() => {
		told = true;
	});
	await settle();
	expect(told).toBe(false);

	// The server takes it all: omp's stderr is read again.
	stuck.room = Number.POSITIVE_INFINITY;
	link.client?.out.drain();
	await waiting;
	expect(stuck.written).toBe(5 + BIG.length);
});

test("a frame of pieces is the pieces one after another, each copied once", () => {
	const frame = encodeFrame(FROM_RELAY.stdout, [Buffer.from("one\n"), Buffer.from("two\n")]);
	expect(frame.length).toBe(5 + 8);
	expect(frame[0]).toBe(FROM_RELAY.stdout);
	expect(frame.readUInt32BE(1)).toBe(8);
	expect(frame.subarray(5).toString()).toBe("one\ntwo\n");
	expect(encodeFrame(FROM_RELAY.stdout, [])).toEqual(encodeFrame(FROM_RELAY.stdout, ""));
});
