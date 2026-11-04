/**
 * The parts of Usage & cost that `omp stats --json` has no answer for: which conversations, tools and errors a range
 * holds, and when in the day the requests were made. The server reads them from omp's statistics database for the range
 * the page asked (`server/omp/stats-db.ts`) and sends them as `analysis` beside omp's figures; omp's own answer (the
 * fallback of the last 24 hours) has none.
 *
 * Each part is null when the database cannot answer it (an older omp's database without the column or the table it is
 * read from): the page then leaves that part out and shows the rest.
 */

/** One conversation's requests in the range: its own and those of its subagents and advisors. */
export interface UsageConversation {
	/** The conversation's own transcript (symlinks resolved), which is how the page opens it. */
	file: string;
	/** The folder omp files the conversation under (`-tmp-dev-acme-api`). */
	folder: string;
	requests: number;
	tokens: number;
	cost: number;
	/** The share of `cost` that the conversation's subagents and its advisors spent. */
	subagentCost: number;
	advisorCost: number;
	/** The models its requests went to, the one that cost the most first. */
	models: string[];
	lastTimestamp: number;
}

/** One tool's calls in the range. */
export interface UsageTool {
	tool: string;
	calls: number;
	errors: number;
	/** Errors over the calls whose result was recorded; null when none was. */
	errorRate: number | null;
	/** Characters of a result, on average over the calls that recorded one; null when none did. */
	avgResultChars: number | null;
}

/** One error message of one model, and how often it came in the range. */
export interface UsageError {
	provider: string;
	model: string;
	/** What the provider said; null for errors that recorded no message. */
	message: string | null;
	count: number;
	lastTimestamp: number;
}

/** The requests and their cost made in one hour of the day (0–23), in the page's time zone. */
export interface UsageHour {
	hour: number;
	requests: number;
	cost: number;
}

export interface UsageAnalysis {
	/** The costliest conversations of the range, at most `TOP_CONVERSATIONS`. */
	conversations: UsageConversation[] | null;
	/** Every tool called in the range, the most called first. */
	tools: UsageTool[] | null;
	/** The most frequent error messages of the range, at most `TOP_ERRORS`. */
	errors: UsageError[] | null;
	/** The 24 hours of the day, from midnight. */
	hours: UsageHour[] | null;
	/** The time zone `hours` are in: the one the page asked for, or UTC when it named none the server knows. */
	timeZone: string;
}

export const TOP_CONVERSATIONS = 20;
export const TOP_ERRORS = 20;
