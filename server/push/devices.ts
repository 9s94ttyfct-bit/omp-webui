import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../shared/guards.ts";
import { cleanLabel, MAX_PUSH_DEVICES, PUSH_DEVICE_ID, type PushDevice } from "../../shared/push.ts";
import { type Receiver, receiverOf } from "./crypto.ts";
import { allowedEndpoint } from "./endpoint.ts";

/**
 * The devices that have Web Push turned on, in `<data dir>/push-devices.json` (0600): for each the subscription its browser
 * made, which is a capability to send it notifications (the endpoint, and the keys that its messages are encrypted with),
 * so it is never shown to a page and never logged. The file holds the public key of the VAPID key the subscriptions were made
 * with: a different key (the key file was lost) makes every one of them useless, and they are not read.
 */
export const DEVICES_FILE = "push-devices.json";

/** What a device is, as kept. */
export interface DeviceRecord {
	/** What a revoke names: random, kept apart from `device`, which a page says of itself over the socket. */
	id: string;
	/** The page's own name for it (`PUSH_DEVICE_ID`): how a page that is on screen is matched to its subscription. */
	device: string;
	endpoint: string;
	p256dh: string;
	auth: string;
	label: string;
	/** The page's interface language when it subscribed (`en`, `zh-CN`): its notifications' words when none was saved. */
	lang: string | null;
	preview: boolean;
	/** Subscribed through the tunnel: its notifications stop while remote access is off. */
	remote: boolean;
	createdAt: number;
	lastSentAt: number | null;
}

/** A request the store refuses, with the status that fits. */
export class DeviceError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

export interface NewDevice {
	device: string;
	endpoint: string;
	p256dh: string;
	auth: string;
	label: string;
	lang: string | null;
	preview: boolean;
	remote: boolean;
}

function recordOf(raw: unknown, extra: readonly string[]): DeviceRecord | null {
	if (!isRecord(raw)) return null;
	const { id, device, endpoint, p256dh, auth, label, lang, preview, remote, createdAt, lastSentAt } = raw;
	if (typeof id !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) return null;
	if (typeof device !== "string" || !PUSH_DEVICE_ID.test(device)) return null;
	if (!allowedEndpoint(endpoint, extra)) return null;
	try {
		receiverOf(p256dh, auth);
	} catch {
		return null;
	}
	if (typeof p256dh !== "string" || typeof auth !== "string" || typeof createdAt !== "number") return null;
	return {
		id,
		device,
		endpoint,
		p256dh,
		auth,
		label: cleanLabel(label) || "Browser",
		lang: typeof lang === "string" ? lang : null,
		preview: preview === true,
		remote: remote === true,
		createdAt,
		lastSentAt: typeof lastSentAt === "number" ? lastSentAt : null,
	};
}

export class PushDevices {
	private readonly file: string;
	private devices: DeviceRecord[] = [];

	/** `publicKey`: the VAPID key in use; what was subscribed with another is not read. `extra`: endpoint origins the person allowed. */
	constructor(
		dataDir: string,
		private readonly publicKey: string,
		private readonly extra: readonly string[] = [],
	) {
		this.file = join(dataDir, DEVICES_FILE);
		this.load();
	}

	private load(): void {
		let stored: unknown;
		try {
			stored = JSON.parse(readFileSync(this.file, "utf8"));
		} catch {
			return;
		}
		if (!isRecord(stored) || stored.vapid !== this.publicKey || !Array.isArray(stored.devices)) return;
		const seen = new Set<string>();
		for (const raw of stored.devices) {
			// What cannot be sent to as it stands (an endpoint no longer allowed, keys cut short) is dropped as it is read.
			const record = recordOf(raw, this.extra);
			if (!record || seen.has(record.id) || seen.has(record.device)) continue;
			seen.add(record.id);
			seen.add(record.device);
			this.devices.push(record);
		}
		if (this.devices.length > MAX_PUSH_DEVICES) this.devices.length = MAX_PUSH_DEVICES;
	}

	/** Written whole and moved into place: a crash mid-write leaves the old file, never half of one. */
	private save(): void {
		const tmp = `${this.file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
		writeFileSync(tmp, JSON.stringify({ v: 1, vapid: this.publicKey, devices: this.devices }), { mode: 0o600 });
		renameSync(tmp, this.file);
	}

	get size(): number {
		return this.devices.length;
	}

	all(): readonly DeviceRecord[] {
		return this.devices;
	}

	get(id: string): DeviceRecord | undefined {
		return this.devices.find((d) => d.id === id);
	}

	/** What Settings shows of each device. */
	list(): PushDevice[] {
		return this.devices.map(({ id, label, createdAt, lastSentAt, preview }) => ({
			id,
			label,
			createdAt,
			lastSentAt,
			preview,
		}));
	}

	/**
	 * Remember a device, or the same device again: one browser has one subscription, so a device that subscribes again (its
	 * browser made a new one) or an endpoint that is known again replaces what was kept, under the id it had.
	 */
	upsert(input: NewDevice, now: number): DeviceRecord {
		const at = this.devices.findIndex((d) => d.device === input.device || d.endpoint === input.endpoint);
		if (at < 0 && this.devices.length >= MAX_PUSH_DEVICES) {
			throw new DeviceError(`At most ${MAX_PUSH_DEVICES} devices can have push turned on: revoke one first`, 409);
		}
		const before = at < 0 ? undefined : this.devices[at];
		const record: DeviceRecord = {
			...input,
			id: before?.id ?? randomBytes(12).toString("base64url"),
			createdAt: before?.createdAt ?? now,
			lastSentAt: before?.lastSentAt ?? null,
		};
		// Two records for one device or one endpoint are never kept: the other one that matched goes.
		this.devices = this.devices.filter((d) => d.device !== input.device && d.endpoint !== input.endpoint);
		this.devices.push(record);
		this.save();
		return record;
	}

	setPreview(id: string, preview: boolean): boolean {
		const record = this.get(id);
		if (!record) return false;
		if (record.preview !== preview) {
			record.preview = preview;
			this.save();
		}
		return true;
	}

	/** A push to it went through. Kept to the minute: nothing is written for each notification. */
	sent(id: string, now: number): void {
		const record = this.get(id);
		if (!record || (record.lastSentAt !== null && now - record.lastSentAt < 60_000)) return;
		record.lastSentAt = now;
		this.save();
	}

	remove(id: string): boolean {
		const had = this.devices.length;
		this.devices = this.devices.filter((d) => d.id !== id);
		if (this.devices.length === had) return false;
		this.save();
		return true;
	}

	removeAll(): number {
		const had = this.devices.length;
		if (had === 0) return 0;
		this.devices = [];
		this.save();
		return had;
	}

	receiver(record: DeviceRecord): Receiver {
		return receiverOf(record.p256dh, record.auth);
	}
}
