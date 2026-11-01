import { useT } from "../i18n/index.ts";
import { sessionActions } from "../lib/api.ts";
import { type ChangeFolderAsk, useChangeFolder } from "../lib/change-folder.ts";
import { shortPath } from "../lib/format.ts";
import { useApp } from "../store/app.ts";
import { DirBrowser } from "./DirBrowser.tsx";

/**
 * The folder picker of "Change folder…" (see `lib/change-folder.ts`), and the move: the server has omp move the
 * conversation (`/move`, `POST /api/session/move`), and the page follows it to its new file when it is the one on screen
 * and has no process of its own (one that has follows by itself: its file is the process's).
 */
export function ChangeFolderDialog() {
	const t = useT();
	const ask = useChangeFolder((s) => s.ask);
	const home = useApp((s) => s.meta?.home);
	return (
		<DirBrowser
			open={ask !== null}
			onOpenChange={(open) => {
				if (!open) useChangeFolder.setState({ ask: null });
			}}
			start={ask?.cwd ?? home ?? ""}
			title={t("shell.changeFolderTitle")}
			description={t("shell.changeFolderDesc")}
			creatable
			onPick={(folder) => {
				if (ask) void move(ask, folder, home, t);
			}}
		/>
	);
}

async function move(ask: ChangeFolderAsk, folder: string, home: string | undefined, t: ReturnType<typeof useT>) {
	if (folder === ask.cwd) return;
	useChangeFolder.setState({ moving: true });
	const st = useApp.getState();
	try {
		const moved = await sessionActions.move({ file: ask.file, liveId: ask.liveId, folder });
		const view = useApp.getState().view;
		if (view.kind === "chat" && ask.file !== null && view.file === ask.file && moved.file && moved.file !== ask.file)
			st.setView({ kind: "chat", file: moved.file, liveId: view.liveId });
		await st.loadSessions();
		st.toast("success", t("shell.changeFolderDone", { folder: shortPath(moved.cwd, home) }));
	} catch (e) {
		st.toast("error", t("shell.changeFolderFailed", { error: (e as Error).message }));
	} finally {
		useChangeFolder.setState({ moving: false });
	}
}
