import { useCallback, useState } from "react";

/**
 * Starts omp for the conversation on screen when it has none, for something the user just clicked. Resolves to the
 * id of the process, or null when it did not start (the reason is on screen already) or the user backed out of
 * choosing a model for it; it never rejects. A second call while one is under way joins it, so a double click
 * starts one process.
 */
export type StartLive = () => Promise<string | null>;

/**
 * The open state of a control whose content comes from a running omp. Opening it where none runs starts omp first and
 * opens it once it does: the user clicks once, as they would with the process already there. `starting` is true
 * meanwhile, for the control to say so.
 */
export function useOpenAfterStart(liveId: string | null, start: StartLive | undefined) {
	const [open, setOpen] = useState(false);
	const [starting, setStarting] = useState(false);
	const request = useCallback(
		(next: boolean) => {
			if (!next || liveId || !start) {
				setOpen(next);
				return;
			}
			setStarting(true);
			void start()
				.then((id) => id && setOpen(true))
				.finally(() => setStarting(false));
		},
		[liveId, start],
	);
	return { open, starting, request };
}
