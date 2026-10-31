import { NotebookPen } from "lucide-react";
import { useContext } from "react";
import "../../i18n/later.ts";
import { useT } from "../../i18n/index.ts";
import { linkedMarkdown, MdOpenContext, openLinked } from "../../lib/md-open.ts";
import { useApp } from "../../store/app.ts";
import { IconButton } from "../ui.tsx";

/**
 * The button beside a file a tool wrote or edited that opens it in the Markdown editor: only for a Markdown file, in a
 * conversation (`MdOpenContext`). A path outside the conversation's folder is not opened (a toast says so).
 */
export function MdOpenButton({ path }: { path: string }) {
	const t = useT();
	const md = useContext(MdOpenContext);
	const linked = md ? linkedMarkdown(path, md.base) : null;
	if (!md || !linked) return null;
	return (
		<IconButton
			label={t("chat.mdOpenFile")}
			size="xs"
			data-testid="tool-md-open"
			onClick={(e) =>
				void openLinked(md, linked, e.currentTarget, (message) => useApp.getState().toast("error", message))
			}
		>
			<NotebookPen size={13} />
		</IconButton>
	);
}
