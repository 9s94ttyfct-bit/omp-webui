import { useEffect, useRef, useState } from "react";
import { t } from "../i18n/index.ts";
import { useApp } from "../store/app.ts";

/**
 * Put `text` on the clipboard, and tell whether it is there. A browser refuses the write when the page has no focus or
 * the permission was refused, and a page on an `http:` address other than localhost has no clipboard at all. Every copy
 * of the page goes through here; one that says the failure in its own words (beside its button) calls this, the others
 * `copyText`.
 */
export async function writeClipboard(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		return false;
	}
}

/** `writeClipboard`, and a toast that says it could not copy when the text is not there. */
export async function copyText(text: string): Promise<boolean> {
	if (await writeClipboard(text)) return true;
	useApp.getState().toast("error", t("common.copyFailed"));
	return false;
}

/**
 * A copy button's state: `copy` puts the text on the clipboard, and `done` is true for a moment once it is there (another
 * copy in that moment starts it again).
 */
export function useCopy(): { done: boolean; copy: (text: string) => void } {
	const [done, setDone] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);
	const copy = (text: string) => {
		void copyText(text).then((copied) => {
			if (!copied) return;
			setDone(true);
			clearTimeout(timer.current);
			timer.current = setTimeout(() => setDone(false), 1200);
		});
	};
	return { done, copy };
}
