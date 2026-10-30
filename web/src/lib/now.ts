import { useEffect, useState } from "react";

/** The current time, refreshed every `intervalMs` while the component is mounted; `null` stops the clock. */
export function useNow(intervalMs: number | null): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (intervalMs === null) return;
		setNow(Date.now());
		const id = setInterval(() => setNow(Date.now()), intervalMs);
		return () => clearInterval(id);
	}, [intervalMs]);
	return now;
}
