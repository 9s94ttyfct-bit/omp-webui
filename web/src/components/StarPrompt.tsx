import { REPO_URL } from "@shared/repo.ts";
import { Star } from "lucide-react";
import { useEffect, useState } from "react";
import { useT } from "../i18n/index.ts";
import { api } from "../lib/api.ts";
import {
	answerStar,
	onUsageChange,
	type RepoLookup,
	STAR_LOOKUP_RETRY_MS,
	STAR_SNOOZE_MS,
	showStarPrompt,
	starLookupWanted,
	starPromptDue,
} from "../lib/usage-days.ts";
import { Button } from "./ui.tsx";

/**
 * A small card in the sidebar asking for a GitHub star after sustained use: enough days with a message, and
 * only while the repository is public (the server asks GitHub; if it cannot tell, the repository counts as
 * private and the card never shows; a lookup that could not tell is made again a day later). "Not now" waits a
 * month; "Don't ask again", the star link and Settings' switch are final until turned back on.
 */
export function StarPrompt() {
	const t = useT();
	const [, setVersion] = useState(0);
	const [lookup, setLookup] = useState<RepoLookup | null>(null);
	useEffect(() => onUsageChange(() => setVersion((v) => v + 1)), []);
	const due = starPromptDue(localStorage, Date.now());
	// Asked only once the user's own history says the prompt is due (and Settings allows it): a private repository,
	// or a user who turned the prompt off, costs no request before then.
	const wanted = due && starLookupWanted(lookup, Date.now());
	useEffect(() => {
		if (!wanted) return;
		let alive = true;
		const found = (isPublic: boolean | null) => alive && setLookup({ public: isPublic, at: Date.now() });
		api.repoPublic().then(
			(r) => found(r.public),
			() => found(null),
		);
		return () => {
			alive = false;
		};
	}, [wanted]);
	// A lookup that could not tell: ask again after a day, if the page is still open.
	useEffect(() => {
		if (!due || lookup?.public !== null) return;
		const timer = setTimeout(() => setVersion((v) => v + 1), STAR_LOOKUP_RETRY_MS);
		return () => clearTimeout(timer);
	}, [due, lookup]);
	if (!showStarPrompt(localStorage, Date.now(), lookup?.public === true)) return null;
	return (
		<section
			aria-label={t("feedback.starTitle")}
			data-testid="star-prompt"
			className="mx-2 mt-2 rounded-xl border border-border bg-bg-soft p-3 text-sm"
		>
			<div className="flex items-center gap-1.5 font-medium">
				<Star size={14} className="text-warning" /> {t("feedback.starTitle")}
			</div>
			<p className="mt-1 text-xs text-muted">{t("feedback.starBody")}</p>
			<div className="mt-2 flex flex-wrap items-center gap-1.5">
				<a
					href={REPO_URL}
					target="_blank"
					rel="noreferrer noopener"
					data-testid="star-link"
					// After the click has opened the link: the card (and with it the link) goes away on this answer.
					onClick={() => setTimeout(() => answerStar({ never: true }), 0)}
					className="inline-flex h-7 items-center justify-center gap-1.5 rounded-lg bg-accent px-2.5 text-xs font-medium text-accent-fg transition-colors hover:brightness-110"
				>
					{t("feedback.starAction")}
				</a>
				<Button
					size="sm"
					variant="ghost"
					data-testid="star-later"
					onClick={() => answerStar({ until: Date.now() + STAR_SNOOZE_MS })}
				>
					{t("feedback.starLater")}
				</Button>
				<Button size="sm" variant="ghost" data-testid="star-never" onClick={() => answerStar({ never: true })}>
					{t("feedback.starNever")}
				</Button>
			</div>
		</section>
	);
}
