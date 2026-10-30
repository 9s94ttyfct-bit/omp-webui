import { randomUUID } from "node:crypto";
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../shared/guards.ts";
import { generateVapidKey, type VapidKey, vapidKeyOf } from "./crypto.ts";

/**
 * The key this server signs its pushes with (VAPID, RFC 8292), kept in `<data dir>/push-vapid.json` for its user alone
 * (0600, like the token). A browser subscribes against its public half, so the key is for good: a new one would make every
 * subscription made with the old one useless. It is therefore made once, never replaced while the file can be read, and a
 * file that is missing, or is there but is not a key (cut short, edited), is replaced by a new key (with a warning when it was
 * there); the devices that were subscribed with the old one are dropped with it (`PushDevices`), since no push service would
 * take a message for them. A file that cannot be read for any other reason (permissions, a full descriptor table, a failing
 * disk) is no evidence that the key is gone: that error is thrown and the key is left alone, so a hiccup never rotates it.
 */
export const VAPID_FILE = "push-vapid.json";

export function loadVapid(dataDir: string): Promise<VapidKey> {
	return open(join(dataDir, VAPID_FILE));
}

async function read(file: string): Promise<VapidKey | null> {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
		throw e;
	}
	try {
		const stored: unknown = JSON.parse(text);
		return await vapidKeyOf(isRecord(stored) ? stored.jwk : null);
	} catch {
		return null;
	}
}

async function open(file: string): Promise<VapidKey> {
	const known = await read(file);
	if (known) {
		// A file that an earlier version or a copy made with other permissions: it holds a private key.
		chmodSync(file, 0o600);
		return known;
	}
	const made = await generateVapidKey();
	const text = JSON.stringify({ v: 1, jwk: made.jwk });
	try {
		// Never over a file that is there: two servers starting together must end with the same key.
		writeFileSync(file, text, { mode: 0o600, flag: "wx" });
		return made;
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
	}
	// A file is there, and it was not readable a moment ago: another server may have just written it.
	const raced = await read(file);
	if (raced) return raced;
	console.warn("omp-webui: the Web Push key could not be read; a new one was made, and devices must subscribe again");
	// Written whole and moved into place: a crash mid-write leaves the old file, never half of one.
	const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
	writeFileSync(tmp, text, { mode: 0o600 });
	renameSync(tmp, file);
	return made;
}
