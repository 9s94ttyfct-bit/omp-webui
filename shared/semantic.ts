/**
 * Semantic search (Settings › Conversations › Semantic search): conversations found by what they are about, not only by the
 * words typed. Off until the person turns it on from their own page; turning it on downloads a llama.cpp build and the
 * EmbeddingGemma 2 model into the app's data and indexes every conversation's messages with them, on this computer. Turning
 * it off deletes all of that. What the server says of it (`GET /api/semantic`) and what the page asks (`POST
 * /api/semantic/on`, `POST /api/semantic/off`, `GET /api/semantic/search`).
 */

/** Why the feature stopped: the page says it in words (`panel` strings), with `detail` when there is one. */
export type SemanticFailureCode =
	/** This computer's system or processor has no llama.cpp build to download. */
	| "unsupported"
	/** A download did not complete (no network, a server that answered an error, stalled). */
	| "download"
	/** What was downloaded is not what was expected (its size or its SHA-256). */
	| "verify"
	/** Not enough free space for what is downloaded. */
	| "space"
	/** The llama.cpp archive could not be unpacked, or did not hold `llama-server`. */
	| "unpack"
	/** `llama-server` did not start, or stopped. */
	| "runtime";

export interface SemanticFailure {
	code: SemanticFailureCode;
	detail?: string;
}

/** What a download is at: the files downloaded so far, of all there are. */
export interface SemanticDownload {
	received: number;
	total: number;
}

export interface SemanticStatus {
	/**
	 * `off`: nothing is downloaded (or what was is deleted). `installing`: the downloads are on their way (`download`).
	 * `on`: installed; the conversations are indexed as they are written (`index`). `failed`: turned on, and it stopped
	 * (`failure`); turning it on again tries again.
	 */
	state: "off" | "installing" | "on" | "failed";
	/** This computer has a build to download (its system and processor): when false the switch is not offered. */
	supported: boolean;
	/** The bytes the downloads come to, all of them (the llama.cpp build and the model), for the switch to say. */
	downloadBytes: number;
	download?: SemanticDownload;
	/**
	 * The messages there are to index (as the full-text index holds them), how many of them are, and whether it is embedding
	 * now: new messages are embedded in batches (when enough have gathered, after a while, or after a search), so that the
	 * model is not loaded for every message written.
	 */
	index?: { indexed: number; total: number; running: boolean };
	/**
	 * The device llama.cpp runs the model on, as it names it ("Apple M4 Pro", a Vulkan GPU's name); null when it found
	 * none and runs on the processor. Absent until it was asked (the first start after the install).
	 */
	device?: string | null;
	/** What the downloads take on disk now (the runtime, the model and the index). */
	diskBytes?: number;
	failure?: SemanticFailure;
	/** The page may turn it on or off (the person's own page: this computer's, or one signed in through Access). */
	canChange: boolean;
}

/** A semantic search's hit: the passage of a conversation closest to the query, and how close (cosine, 0–1). */
export interface SemanticHit {
	file: string;
	entryId: string;
	role: string;
	/** The start of the passage, as plain text (no match is marked: it is found by meaning, not by the words). */
	snippet: string;
	timestamp: string;
	title: string | null;
	cwd: string;
	score: number;
}
