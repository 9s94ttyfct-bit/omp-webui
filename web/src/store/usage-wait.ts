import { useEffect } from "react";
import { create } from "zustand";
import { sessionActions, type UsageWait } from "../lib/api.ts";
import { socket } from "../lib/ws.ts";

/**
 * Whether a failed turn waits out its provider's usage limit: omp's own setting (`retry.waitForUsageReset`, the same
 * one `omp config` shows and changes) and the choices made for single conversations. The server reads omp's value from
 * omp itself, so this is a copy: loaded when something first shows it, loaded again when omp's config.yml changes
 * (`model_config_changed`: a change made in the terminal, or by another tab) and after a reconnect.
 */
interface State {
	/** omp's value; undefined until the server has said, null when omp could not be asked. */
	omp: boolean | null | undefined;
	/** The choice made for a conversation, by session file; null: it follows omp's. Absent until the server has said. */
	sessions: Record<string, boolean | null>;
}

const useStore = create<State>(() => ({ omp: undefined, sessions: {} }));

let following = false;
/** How many places show each file's choice right now: those files are asked again together with omp's value. */
const shown = new Map<string, number>();

function load(file: string | null): void {
	void sessionActions
		.usageWait(file)
		.then((r) =>
			useStore.setState((s) => ({
				omp: r.omp,
				sessions: file === null ? s.sessions : { ...s.sessions, [file]: r.session },
			})),
		)
		.catch(() => {});
}

function reload(): void {
	load(null);
	for (const file of shown.keys()) load(file);
}

function follow(): void {
	if (following) return;
	following = true;
	socket.on((msg) => {
		if (msg.t === "model_config_changed") reload();
	});
	socket.onStatus((connected) => connected && reload());
}

/**
 * Show omp's own value, and the choice made for `file` (null: only omp's value), and keep both true until the returned
 * function is called: while shown they are asked again after a reconnect and a change of omp's config, and a
 * conversation whose popover is closed is not asked about any more.
 */
export function watchUsageWait(file: string | null): () => void {
	follow();
	load(file);
	if (file === null) return () => {};
	shown.set(file, (shown.get(file) ?? 0) + 1);
	return () => {
		const left = (shown.get(file) ?? 1) - 1;
		if (left > 0) shown.set(file, left);
		else shown.delete(file);
	};
}

/** omp's own value, and the choice made for `file` (null while none is shown). `loaded`: the server has answered. */
export function useUsageWait(file: string | null): { loaded: boolean; omp: boolean | null; session: boolean | null } {
	useEffect(() => watchUsageWait(file), [file]);
	const omp = useStore((s) => s.omp);
	const session = useStore((s) => (file === null ? undefined : s.sessions[file]));
	return {
		loaded: omp !== undefined && (file === null || session !== undefined),
		omp: omp ?? null,
		session: session ?? null,
	};
}

/** Show `next` at once and keep the server's answer instead when it comes; a refusal puts the old state back and throws. */
async function change(next: (s: State) => State, ask: () => Promise<UsageWait>, file: string | null): Promise<void> {
	const before = useStore.getState();
	useStore.setState(next(before));
	try {
		const r = await ask();
		useStore.setState((s) => ({
			omp: r.omp,
			sessions: file === null ? s.sessions : { ...s.sessions, [file]: r.session },
		}));
	} catch (e) {
		useStore.setState(before);
		throw e;
	}
}

/** Set omp's own `retry.waitForUsageReset`, as `omp config set` does. */
export function setUsageWaitDefault(enabled: boolean): Promise<void> {
	return change(
		(s) => ({ ...s, omp: enabled }),
		() => sessionActions.setUsageWait(enabled),
		null,
	);
}

/** `enabled` null: the conversation follows omp's setting again. */
export function setConversationUsageWait(file: string, enabled: boolean | null): Promise<void> {
	return change(
		(s) => ({ ...s, sessions: { ...s.sessions, [file]: enabled } }),
		() => sessionActions.setSessionUsageWait(file, enabled),
		file,
	);
}
