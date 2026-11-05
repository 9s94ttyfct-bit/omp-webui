import { useState } from "react";
import { t } from "../i18n/index.ts";
import { useApp } from "../store/app.ts";

/**
 * Put `text` on the clipboard, and tell whether it is there. A browser refuses the write when the page has no focus or
 * the permission was refused, and a page on an `http:` address other than localhost has no clipboard at all: a toast says
 * it could not copy.
 */
export async function copyText(text: string): Promise<boolean> {
	try {
		await navigator.clipboard.writeText(text);
		return true;
	} catch {
		useApp.getState().toast("error", t("common.copyFailed"));
		return false;
	}
}

/** A copy button's state: `copy` puts the text on the clipboard, and `done` is true for a moment once it is there. */
export function useCopy(): { done: boolean; copy: (text: string) => void } {
	const [done, setDone] = useState(false);
	const copy = (text: string) => {
		void copyText(text).then((copied) => {
			if (!copied) return;
			setDone(true);
			setTimeout(() => setDone(false), 1200);
		});
	};
	return { done, copy };
}
