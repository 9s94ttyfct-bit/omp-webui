import "../i18n/later.ts";
import { t } from "../i18n/index.ts";
import { PAGE_VERSION } from "../lib/page-build.ts";
import { reloadNow } from "../lib/reload.ts";
import { useApp } from "../store/app.ts";

/** The server version the page last told of: told once per version, not at every reconnect. */
let told = "";

/**
 * The notice that the server runs another version than this page's code (a tab left open across an update), with the
 * button that loads the page again. Behind `import()`: only a page that is told needs it.
 */
export function tellNewBuild(server: string): void {
	if (told === server) return;
	told = server;
	useApp.getState().toast("warning", t("pages.newBuild", { page: PAGE_VERSION, server }), {
		label: t("pages.newBuildReload"),
		run: () => reloadNow(),
	});
}
