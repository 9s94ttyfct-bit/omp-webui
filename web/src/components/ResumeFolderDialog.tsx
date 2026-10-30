import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { DirBrowser } from "./DirBrowser.tsx";

/**
 * Shown when a conversation cannot be resumed where it ran (its folder is gone, or its file names none): omp's tools
 * run in the folder it is started in, so the user chooses one. Resolves with that folder, or null when they back out.
 */
export function ResumeFolderDialog({
	prompt,
}: {
	prompt: { reason: string; start: string; resolve: (folder: string | null) => void } | null;
}) {
	const t = useT();
	return (
		<DirBrowser
			open={prompt !== null}
			onOpenChange={(o) => !o && prompt?.resolve(null)}
			start={prompt?.start ?? ""}
			title={t("chat.resumeFolderTitle")}
			description={`${prompt?.reason ?? ""} ${t("chat.resumeFolderDesc")}`}
			onPick={(folder) => prompt?.resolve(folder)}
		/>
	);
}
