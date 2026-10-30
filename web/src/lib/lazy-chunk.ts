import { type ComponentType, createElement, lazy } from "react";
import { quietly } from "./reload.ts";

/** What a chunk of one component exports, as `lazy` wants it. */
interface ChunkModule<P> {
	default: ComponentType<P>;
}

/**
 * A component that lives in a chunk of its own: fetched when it is first rendered, or ahead of that by `preload`.
 *
 * `lazy` keeps a failed load for good, so that a network that has come back would still need a reload. Here a failed
 * load is forgotten: whoever caught it (the boundary round the component) calls `retry`, and the next time the
 * component is rendered the chunk is asked for again.
 */
export function lazyChunk<P extends object>(load: () => Promise<ChunkModule<P>>) {
	/** The chunk being fetched, or fetched; one fetch serves the preload and the component. */
	let chunk: Promise<ChunkModule<P>> | undefined;
	const fetchChunk = () => {
		chunk ??= load().catch((error: unknown) => {
			chunk = undefined;
			throw error;
		});
		return chunk;
	};
	let Current = lazy(fetchChunk);
	return {
		/** The component; renders whatever is rendered next after a `retry`. Needs a `Suspense` and a boundary round it. */
		Chunk: (props: P) => createElement(Current, props),
		/** Fetch the chunk before the component is asked for. A failure is for whoever asks for the component, not for this. */
		preload: () => quietly(fetchChunk()),
		/** The component could not be loaded: ask for the chunk again the next time it is rendered. */
		retry: () => {
			Current = lazy(fetchChunk);
		},
	};
}
