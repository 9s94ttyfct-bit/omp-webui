/**
 * What omp reports with `get_state`, for specs that answer it themselves (see `SocketTap.answer`): an idle process on
 * Opus 5.5. `extra` adds to or overrides it (`todoPhases`, `usageLimit`, `fastModeActive`, …).
 */
export function rpcState(extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		isStreaming: false,
		isCompacting: false,
		steeringMode: "all",
		followUpMode: "all",
		interruptMode: "immediate",
		messageCount: 2,
		queuedMessageCount: 0,
		thinkingLevel: "high",
		model: { id: "claude-opus-5-5", name: "Opus 5.5", provider: "anthropic", contextWindow: 1_000_000 },
		contextUsage: { tokens: 390_000, contextWindow: 1_000_000, percent: 39 },
		...extra,
	};
}
