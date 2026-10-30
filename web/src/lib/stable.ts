import { useCallback, useLayoutEffect, useRef } from "react";

/**
 * `fn` under a name that never changes, always running the latest `fn`: handed to a memoized child it does not
 * make the child render again, however often the parent does.
 */
export function useStable<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
	const latest = useRef(fn);
	useLayoutEffect(() => {
		latest.current = fn;
	});
	return useCallback((...args: A) => latest.current(...args), []);
}
