import { activeMsOf, foldUsageLine, newUsageFold, type TranscriptUsage } from "../../server/sessions/parse.ts";

/** What one transcript spent, from its whole text: the server's own fold (`foldUsageLine`), line by line (#401). */
export function transcriptUsage(text: string): TranscriptUsage {
	const fold = newUsageFold();
	for (const line of text.split("\n")) foldUsageLine(fold, line);
	return { usage: fold.usage, startedAt: fold.startedAt, providers: fold.providers, activeMs: activeMsOf(fold) };
}
