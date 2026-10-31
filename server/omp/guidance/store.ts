import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../../shared/guards.ts";
import {
	BUILTIN_GUIDANCE,
	GUIDANCE_ID_MAX,
	GUIDANCE_MAX,
	GUIDANCE_NAME_MAX,
	GUIDANCE_TEMPLATES_MAX,
	type GuidanceProblem,
	type GuidanceTemplate,
	type GuidanceTemplates,
	guidanceNameProblem,
	guidanceProblemText,
	guidanceText,
} from "../../../shared/model-guidance.ts";

/**
 * The model-guidance templates the person saved (Settings › Model guidance, and the New chat picker): kept in
 * `<data dir>/model-guidance.json`, so that they follow the person across origins and browsers, travel with Move to
 * another computer (the file is a `webui` data file: `server/migrate/layout.ts`), and are the same for a page on this
 * computer and one through the tunnel.
 *
 * The file, not this object, is the truth, as it is for the other stores of the data dir: another server on the same data
 * dir (a second copy of the app, one that lingers) writes it too. So it is read again before every snapshot and before
 * every change, and a change is merged into what is there; the revision only ever goes up, whoever wrote last.
 *
 * A file that cannot be read is kept aside (`model-guidance.json.damaged`) and the shipped templates stand in its place:
 * a damaged file never stops a conversation from starting, and never loses what it held without leaving it on disk.
 * A data dir with no file at all (a fresh install, or one from before this feature) holds the shipped templates, and
 * nothing is written until the person changes something.
 */

/** A change the store refuses: the whole request is rejected and nothing is applied. */
export class GuidanceStoreError extends Error {
	constructor(
		readonly problem: GuidanceProblem,
		message: string,
	) {
		super(message);
	}
}

/**
 * What `value` may be as a template: the fields the store keeps, as they are, or null when it is not a template at all.
 * Lengths are not cut here: a name or a text over its limit is refused by `save` (the page is told which), and one read
 * from a file is dropped by `templatesOf` rather than quietly shortened into something the person did not write.
 */
function templateOf(value: unknown): GuidanceTemplate | null {
	if (!isRecord(value)) return null;
	const { id, name, text } = value;
	if (typeof id !== "string" || !id || id.length > GUIDANCE_ID_MAX) return null;
	if (typeof name !== "string" || typeof text !== "string") return null;
	const kept: GuidanceTemplate = { id, name, text };
	// Only a template whose id is one the app ships says it ships, and only while it still holds the shipped text: it is
	// what Restore defaults puts back, and what a conversation that picked it by id is told it may see change.
	const shipped = BUILTIN_GUIDANCE.find((b) => b.id === id);
	if (shipped && guidanceText(shipped.text) === guidanceText(text)) kept.builtin = true;
	return kept;
}

/** The templates a stored value holds, in order, dropping what is not a template and repeating ids. */
function templatesOf(value: unknown): GuidanceTemplate[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const out: GuidanceTemplate[] = [];
	for (const raw of value) {
		const t = templateOf(raw);
		if (!t || t.name.length > GUIDANCE_NAME_MAX || t.text.length > GUIDANCE_MAX || seen.has(t.id)) continue;
		seen.add(t.id);
		out.push(t);
		if (out.length >= GUIDANCE_TEMPLATES_MAX) break;
	}
	return out;
}

/** The shipped templates, each as it ships. */
const shipped = (): GuidanceTemplate[] => BUILTIN_GUIDANCE.map((t) => ({ ...t }));

/** The built-ins a file written before it listed them (`builtins`) was made with: the two that shipped first. */
const FIRST_BUILTINS = ["builtin-one-of-each", "builtin-simple-complex"];

export class GuidanceStore {
	private readonly file: string;
	private rev = 0;
	private templates: GuidanceTemplate[] = shipped();
	/** How the file looked when this store last read or wrote it: what says whether it must be read again. */
	private seen = "";

	constructor(private readonly dataDir: string) {
		this.file = join(dataDir, "model-guidance.json");
		this.read();
		this.seen = this.stamp();
	}

	/**
	 * Take the file's state. No file leaves the shipped templates in place; one that cannot be read is kept aside and the
	 * shipped templates stand in its place.
	 */
	private read(): void {
		let text: string;
		try {
			text = readFileSync(this.file, "utf8");
		} catch (e) {
			// No file yet (a fresh data dir): there is nothing to take, and nothing is written until something changes.
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") this.keepAside(e);
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			this.keepAside(new Error("it is not JSON"));
			return;
		}
		if (!isRecord(parsed) || !Array.isArray(parsed.templates)) {
			this.keepAside(new Error("it does not hold a list of templates"));
			return;
		}
		this.rev = Number.isInteger(parsed.rev) && (parsed.rev as number) >= 0 ? (parsed.rev as number) : 0;
		this.templates = templatesOf(parsed.templates);
		// A built-in shipped since the file was written joins it, at its place in the shipped order; one the person
		// deleted is among those the file was made with, and stays deleted.
		const made = Array.isArray(parsed.builtins)
			? parsed.builtins.filter((id): id is string => typeof id === "string")
			: FIRST_BUILTINS;
		BUILTIN_GUIDANCE.forEach((builtin, order) => {
			if (made.includes(builtin.id) || this.templates.some((t) => t.id === builtin.id)) return;
			this.templates.splice(Math.min(order, this.templates.length), 0, { ...builtin });
		});
	}

	/**
	 * The file that cannot be read is kept beside the store, so that nothing it held is lost without a trace. An earlier
	 * damaged copy is never written over: a later one is named with the time (it still ends in `.damaged`, which Move to
	 * another computer ignores).
	 */
	private keepAside(why: unknown): void {
		let aside = `${this.file}.damaged`;
		for (let n = 0; existsSync(aside); n++) aside = `${this.file}.${Date.now()}${n ? `-${n}` : ""}.damaged`;
		try {
			renameSync(this.file, aside);
			console.warn(
				`omp-webui: ${this.file} could not be read (${why instanceof Error ? why.message : String(why)}); it was moved to ${aside}, and the shipped templates are used`,
			);
		} catch {
			// Nothing to move: it went while this was read.
		}
		this.templates = shipped();
	}

	/** Written whole and moved into place: a crash mid-write leaves the old file, never half of one. */
	private writeFile(): void {
		mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
		const tmp = `${this.file}.${process.pid}.tmp`;
		const builtins = BUILTIN_GUIDANCE.map((b) => b.id);
		writeFileSync(tmp, `${JSON.stringify({ rev: this.rev, builtins, templates: this.templates }, null, "\t")}\n`, {
			mode: 0o600,
		});
		chmodSync(tmp, 0o600);
		renameSync(tmp, this.file);
		this.seen = this.stamp();
	}

	/** How the file looks, "" for none: a file written or replaced by anyone else looks different. */
	private stamp(): string {
		try {
			const st = statSync(this.file);
			return `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
		} catch {
			return "";
		}
	}

	/** What the store holds now, as another server on this data dir may have left it. */
	snapshot(): GuidanceTemplates {
		const now = this.stamp();
		if (now !== this.seen) {
			this.seen = now;
			this.read();
		}
		return { templates: this.templates.map((t) => ({ ...t })), rev: this.rev };
	}

	/** The templates as they are now, for the text a conversation carries. */
	list(): readonly GuidanceTemplate[] {
		this.snapshot();
		return this.templates;
	}

	/**
	 * Save `template`: by id, replacing the one that has it, else added — unless `update`, when a template that is not
	 * there (deleted meanwhile) is refused (`gone`) instead of added again (#715). A name may not repeat another template's
	 * (the person picks by name) and neither name nor text may be empty. The answer is the store as it is now.
	 */
	save(input: unknown, update = false): GuidanceTemplates {
		const t = templateOf(input);
		if (!t) throw new GuidanceStoreError("unknown", "Not a guidance template");
		const text = guidanceText(t.text);
		const name = t.name.trim();
		// Empty or too long is the name alone; repeating another's is read against the file as it is now, below.
		const unnamed = guidanceNameProblem(name, []);
		if (unnamed) throw new GuidanceStoreError(unnamed, guidanceProblemText(unnamed));
		if (!text) throw new GuidanceStoreError("textEmpty", "The template needs some text");
		if (text.length > GUIDANCE_MAX)
			throw new GuidanceStoreError("textTooLong", `The text is at most ${GUIDANCE_MAX} characters`);
		this.snapshot();
		if (guidanceNameProblem(name, this.templates, t.id) === "nameRepeated")
			throw new GuidanceStoreError("nameRepeated", `There is already a template named “${name}”`);
		const at = this.templates.findIndex((x) => x.id === t.id);
		if (at < 0 && update) throw new GuidanceStoreError("gone", "That template does not exist any more");
		if (at < 0 && this.templates.length >= GUIDANCE_TEMPLATES_MAX)
			throw new GuidanceStoreError("tooMany", `Keep at most ${GUIDANCE_TEMPLATES_MAX} templates`);
		const kept: GuidanceTemplate = { id: t.id, name, text, ...(t.builtin ? { builtin: true as const } : {}) };
		if (at < 0) this.templates.push(kept);
		else this.templates[at] = kept;
		this.rev++;
		this.writeFile();
		return this.snapshot();
	}

	/**
	 * Forget the template `id`. A conversation that picked it keeps the text it stood for: its own record of the
	 * guidance names the text as well (see `server/omp/guidance/session.ts`).
	 */
	remove(id: unknown): GuidanceTemplates {
		if (typeof id !== "string" || !id) throw new GuidanceStoreError("unknown", "Not a guidance template");
		this.snapshot();
		const at = this.templates.findIndex((t) => t.id === id);
		if (at < 0) return this.snapshot();
		this.templates.splice(at, 1);
		this.rev++;
		this.writeFile();
		return this.snapshot();
	}

	/**
	 * Put the shipped templates back as they ship: one the person deleted comes back where it ships, and one they edited
	 * is set to the shipped text. Templates they made are left alone.
	 */
	restoreDefaults(): GuidanceTemplates {
		this.snapshot();
		BUILTIN_GUIDANCE.forEach((shippedTemplate, order) => {
			const at = this.templates.findIndex((t) => t.id === shippedTemplate.id);
			const restored: GuidanceTemplate = { ...shippedTemplate };
			if (at < 0) this.templates.splice(Math.min(order, this.templates.length), 0, restored);
			else this.templates[at] = restored;
		});
		this.rev++;
		this.writeFile();
		return this.snapshot();
	}
}
