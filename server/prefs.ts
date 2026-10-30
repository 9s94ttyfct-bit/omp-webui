import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	isPrefKey,
	isValidPref,
	MAX_PREF_LENGTH,
	PREF_KEYS,
	PREFS_ELEMENT_ID,
	type PrefKey,
	type PrefsSnapshot,
} from "../shared/prefs.ts";

/** A change the store refuses: the whole request is rejected, nothing is applied. */
export class PrefsError extends Error {}

/**
 * The web UI's preferences (see shared/prefs.ts), kept in `<data dir>/ui-prefs.json` so that they follow the person
 * across origins: localStorage belongs to one `host:port`, and the macOS app moves to another port when its own is taken.
 *
 * The file, not this object, is the truth: another server on the same data dir (a second copy of the app, one that
 * lingers) writes it too. So it is read again before every snapshot and before every change, and a change is merged into
 * what is there; the revision only ever goes up, whoever wrote last.
 */
export class UiPrefs {
	private readonly file: string;
	private id = "";
	private rev = 0;
	private values = new Map<PrefKey, string>();

	constructor(dataDir: string) {
		this.file = join(dataDir, "ui-prefs.json");
		if (!this.refresh()) {
			// No store yet, or one that cannot be read: a new identity, so that no page trusts a copy of the old one.
			this.id = randomUUID();
			this.rev = 0;
			this.values.clear();
			this.save();
		}
	}

	/**
	 * Take the file's state, if it holds a store this one has not seen: another identity (a replaced data dir), or a higher
	 * revision of this one. False when there is nothing readable, which leaves what is in memory alone.
	 */
	private refresh(): boolean {
		try {
			const v: unknown = JSON.parse(readFileSync(this.file, "utf8"));
			if (typeof v !== "object" || v === null) return false;
			const { id, rev, values } = v as Record<string, unknown>;
			if (typeof id !== "string" || !id || !Number.isInteger(rev) || (rev as number) < 0) return false;
			if (typeof values !== "object" || values === null) return false;
			if (id === this.id && (rev as number) <= this.rev) return true;
			this.id = id;
			this.rev = rev as number;
			this.values.clear();
			for (const [k, val] of Object.entries(values)) {
				// What cannot be shown is dropped as it is read: a file from an older build, or edited by hand.
				if (isPrefKey(k) && typeof val === "string" && val.length <= MAX_PREF_LENGTH && isValidPref(k, val)) {
					this.values.set(k, val);
				}
			}
			return true;
		} catch {
			return false;
		}
	}

	/** Written whole and moved into place: a crash mid-write leaves the old file, never half of one. */
	private save(): void {
		// A name of its own: a second server writing at the same moment must not write into this one's file.
		const tmp = `${this.file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
		writeFileSync(tmp, JSON.stringify({ id: this.id, rev: this.rev, values: Object.fromEntries(this.values) }), {
			mode: 0o600,
		});
		renameSync(tmp, this.file);
	}

	snapshot(): PrefsSnapshot {
		this.refresh();
		const values = Object.fromEntries(PREF_KEYS.map((k) => [k, this.values.get(k) ?? null])) as PrefsSnapshot["values"];
		return { id: this.id, rev: this.rev, values };
	}

	/** Set (a string) or forget (null) keys. A change that alters nothing leaves the revision alone. */
	apply(changes: unknown): PrefsSnapshot {
		if (typeof changes !== "object" || changes === null || Array.isArray(changes)) {
			throw new PrefsError("changes must be an object");
		}
		// Nothing is checked against a stale copy: what another server wrote is in before this change is merged into it.
		this.refresh();
		const next = new Map(this.values);
		for (const [key, value] of Object.entries(changes)) {
			if (!isPrefKey(key)) throw new PrefsError(`Unknown preference: ${key}`);
			if (value === null) next.delete(key);
			else if (typeof value !== "string") throw new PrefsError(`${key} must be a string or null`);
			else if (value.length > MAX_PREF_LENGTH) throw new PrefsError(`${key} is too long`);
			else if (!isValidPref(key, value)) throw new PrefsError(`${key} is not a value the app uses`);
			else next.set(key, value);
		}
		const changed = next.size !== this.values.size || [...next].some(([k, v]) => this.values.get(k) !== v);
		if (changed) {
			this.values = next;
			this.rev++;
			this.save();
		}
		return this.snapshot();
	}

	/**
	 * `html` with the snapshot in front of its first script, where the page's inline script finds it before first paint.
	 * A script element of a type the browser does not run is a data block: the page's CSP does not apply to it, and
	 * its text stays what it is. `<` is escaped so that no value can end the element or open a comment.
	 */
	inject(html: string): string {
		const json = JSON.stringify(this.snapshot()).replaceAll("<", "\\u003c");
		const block = `<script type="application/json" id="${PREFS_ELEMENT_ID}">${json}</script>`;
		// A function, so that `$&` and the like inside a value are not read as replacement patterns.
		return html.replace(/<script\b/i, (first) => `${block}${first}`);
	}
}
