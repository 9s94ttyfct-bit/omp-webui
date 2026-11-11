import { t } from "../i18n/index.ts";
import { useApp } from "../store/app.ts";
import { sessionActions } from "./api.ts";
import { errorText } from "./error-text.ts";

/**
 * The remote computers last asked for a process from this page, by its liveId (the list's ticks, `SessionRemote.tsx`): what
 * the server settles on, kept after its answer (the process's own record may come later), dropped when it failed. A send
 * right after a tick is then not given the list from before it.
 */
export const choosing = new Map<string, Promise<string[]>>();

/**
 * Give the process `to` (a new project's conversation, started as its first message is sent) the remote computers ticked on
 * New chat's warm-up process `from` (`RemotePicker`); a warning says so when they could not be. Its own module, loaded only
 * then: New chat is in the first paint.
 */
export async function carryRemote(from: string, to: string): Promise<void> {
	const settled = await choosing.get(from)?.catch(() => undefined);
	choosing.delete(from);
	const { lives, meta, toast } = useApp.getState();
	const ids = settled ?? lives[from]?.info.remoteComputers;
	if (!ids || ids.length === 0) return;
	try {
		await sessionActions.setRemoteComputers(to, ids);
	} catch (e) {
		const names = (meta?.macs ?? []).filter((m) => ids.includes(m.id)).map((m) => m.name);
		toast("warning", t("pages.newPickLost", { what: names.join(", "), error: errorText(e) }));
	}
}
