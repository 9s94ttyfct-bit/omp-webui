import { t } from "../i18n/index.ts";
import { useApp } from "../store/app.ts";
import { sessionActions } from "./api.ts";

/**
 * Archive or restore conversations (a web UI preference kept by the server). Archiving says how many went and
 * offers an Undo, since the rows leave the list they were just clicked in. Resolves to whether it worked.
 */
export async function setArchived(files: string[], archived: boolean): Promise<boolean> {
	const { set, toast } = useApp.getState();
	try {
		set({ archived: await sessionActions.setArchived(files, archived) });
	} catch (e) {
		toast("error", t("shell.sidebarArchiveFailed", { error: (e as Error).message }));
		return false;
	}
	if (archived) {
		const n = files.length;
		toast("info", t(n === 1 ? "shell.sidebarArchivedToastOne" : "shell.sidebarArchivedToast", { n }), {
			label: t("shell.toastUndo"),
			run: () => void setArchived(files, false),
		});
	}
	return true;
}

/**
 * Sending to an archived conversation brings it back: otherwise the sidebar hides it while it runs, so its
 * running dot (and the way back to it) is never seen. A conversation that is not archived costs nothing.
 */
export function unarchiveOnSend(file: string | null | undefined): void {
	if (file && useApp.getState().archived.includes(file)) void setArchived([file], false);
}
