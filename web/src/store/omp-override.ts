import { useEffect } from "react";
import { create } from "zustand";
import { socket } from "../lib/ws.ts";

/**
 * One of omp's settings that a conversation can choose for itself (whether a turn waits out a usage limit, how many
 * subagents run at once, where it compacts): omp's own value and the choices of single conversations. The server reads
 * omp's value from omp itself, so this is a copy: loaded when something first shows it, loaded again when omp's
 * config.yml changes (`model_config_changed`: a change made in the terminal, or by another tab) and after a reconnect.
 */

/** What the server answers: omp's value (null when omp could not be asked) and the conversation's (null: it follows omp's). */
interface OverrideAnswer<O, S> {
	omp: O | null;
	session: S | null;
}

interface State<O, S> {
	/** omp's value; undefined until the server has said, null when omp could not be asked. */
	omp: O | null | undefined;
	/** The choice made for a conversation, by session file; null: it follows omp's. Absent until the server has said. */
	sessions: Record<string, S | null>;
}

/** The stores being shown: each is asked again, for omp's value and the files on screen, after a reconnect or a change of omp's config. */
const reloads = new Set<() => void>();
let following = false;

function follow(reload: () => void): void {
	reloads.add(reload);
	if (following) return;
	following = true;
	const all = () => {
		for (const r of reloads) r();
	};
	socket.on((msg) => {
		if (msg.t === "model_config_changed") all();
	});
	socket.onStatus((connected) => connected && all());
}

interface OmpOverride<O, S, D> {
	/**
	 * Show omp's own value, and the choice made for `file` (null: only omp's value), and keep both true until the returned
	 * function is called: while shown they are asked again after a reconnect and a change of omp's config, and a
	 * conversation that is no longer shown is not asked about any more.
	 */
	watch(file: string | null): () => void;
	/** omp's own value, and the choice made for `file` (null while none is shown). `loaded`: the server has answered. */
	use(file: string | null): { loaded: boolean; omp: O | null; session: S | null };
	/** Set omp's own value, as `omp config set` does. */
	setDefault(value: D): Promise<void>;
	/** `value` null: the conversation follows omp's again. */
	setConversation(file: string, value: S | null): Promise<void>;
}

/**
 * The store of one such setting. `shownDefault` is what omp's value shows as while `setDefault(value)` is on its way
 * (undefined: what it was, until the server answers).
 */
export function ompOverride<O, S, D>(server: {
	get(file: string | null): Promise<OverrideAnswer<O, S>>;
	setDefault(value: D): Promise<OverrideAnswer<O, S>>;
	setSession(file: string, value: S | null): Promise<OverrideAnswer<O, S>>;
	shownDefault(value: D): O | undefined;
}): OmpOverride<O, S, D> {
	const useStore = create<State<O, S>>(() => ({ omp: undefined, sessions: {} }));
	/** How many places show each file's choice right now: those files are asked again together with omp's value. */
	const shown = new Map<string, number>();

	const take = (file: string | null, r: OverrideAnswer<O, S>) =>
		useStore.setState((s) => ({
			omp: r.omp,
			sessions: file === null ? s.sessions : { ...s.sessions, [file]: r.session },
		}));
	const load = (file: string | null): void => {
		void server
			.get(file)
			.then((r) => take(file, r))
			.catch(() => {});
	};
	const reload = (): void => {
		load(null);
		for (const file of shown.keys()) load(file);
	};

	/** Show `next` at once and keep the server's answer instead when it comes; a refusal puts the old state back and throws. */
	async function change(
		next: (s: State<O, S>) => State<O, S>,
		ask: () => Promise<OverrideAnswer<O, S>>,
		file: string | null,
	): Promise<void> {
		const before = useStore.getState();
		useStore.setState(next(before));
		try {
			take(file, await ask());
		} catch (e) {
			useStore.setState(before);
			throw e;
		}
	}

	function watch(file: string | null): () => void {
		follow(reload);
		load(file);
		if (file === null) return () => {};
		shown.set(file, (shown.get(file) ?? 0) + 1);
		return () => {
			const left = (shown.get(file) ?? 1) - 1;
			if (left > 0) shown.set(file, left);
			else shown.delete(file);
		};
	}

	function useOverride(file: string | null): { loaded: boolean; omp: O | null; session: S | null } {
		useEffect(() => watch(file), [file]);
		const omp = useStore((s) => s.omp);
		const session = useStore((s) => (file === null ? undefined : s.sessions[file]));
		return {
			loaded: omp !== undefined && (file === null || session !== undefined),
			omp: omp ?? null,
			session: session ?? null,
		};
	}

	return {
		watch,
		use: useOverride,
		setDefault: (value) =>
			change(
				(s) => {
					const omp = server.shownDefault(value);
					return omp === undefined ? s : { ...s, omp };
				},
				() => server.setDefault(value),
				null,
			),
		setConversation: (file, value) =>
			change(
				(s) => ({ ...s, sessions: { ...s.sessions, [file]: value } }),
				() => server.setSession(file, value),
				file,
			),
	};
}
