import { FOLDER_LIMITS, type FolderSaved, type FolderSaveRequest } from "@shared/folder.ts";
import { CSRF_HEADER, ERROR_HEADER } from "@shared/transfer.ts";
import { t } from "../i18n/index.ts";
import { fmtBytes } from "./files-rows.ts";
import type { FolderScope } from "./folder-api.ts";
import { failureOf, TransferError } from "./transfer-api.ts";
import { describeFailure } from "./transfer-words.ts";

/**
 * The page's side of saving the text of a file (`POST /api/folder/file`, see `server/folder-write.ts`): the request, what its
 * refusals say in the page's language, and the line endings a text is written with. Loaded with the editor, not before.
 */

/**
 * The line ending a text is saved with: the one most of its lines end with, so that a file written with CRLF comes back with
 * CRLF. (The editor holds lines, not their endings; a file that mixes them is saved with its commonest one.)
 */
export function eolOf(text: string): "\n" | "\r\n" {
	let crlf = 0;
	let lf = 0;
	for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) {
		if (text.charCodeAt(at - 1) === 13) crlf++;
		else lf++;
	}
	return crlf > lf ? "\r\n" : "\n";
}

/** Save `text` as the new content of `path`, made from the file whose etag is `etag`. Throws a `TransferError` for what the server says no to (409 `conflict` carries the etag the file has now). */
export async function saveFile(scope: FolderScope, path: string, text: string, etag: string): Promise<FolderSaved> {
	const body: FolderSaveRequest = {
		...(scope.live ? { live: scope.live } : {}),
		...(scope.file ? { file: scope.file } : {}),
		path,
		text,
		etag,
	};
	let res: Response;
	try {
		res = await fetch("/api/folder/file", {
			method: "POST",
			headers: { "content-type": "application/json", [CSRF_HEADER]: "1" },
			body: JSON.stringify(body),
		});
	} catch {
		throw new TransferError("The connection failed", "failed", 0);
	}
	const answer = await res.text().catch(() => "");
	if (!res.ok)
		throw failureOf({ status: res.status, text: answer, code: res.headers.get(ERROR_HEADER), retryAfterMs: 0 });
	return JSON.parse(answer) as FolderSaved;
}

/** What a failed save says, for the file `name`: the transfer's words, except where saving needs others. */
export function saveFailureText(e: unknown, name: string): string {
	if (!(e instanceof TransferError)) return e instanceof Error ? e.message : String(e);
	switch (e.code) {
		case "secret":
			return t("files.editErrSecret", { name });
		case "protected":
			return t("files.editErrProtected");
		case "homeFolder":
			return t("files.editErrHomeFolder");
		case "refused":
			return t("files.editErrRefused", { name });
		case "tooLarge":
			return t("files.editErrTooLarge", { limit: fmtBytes(e.limit ?? FOLDER_LIMITS.editBytes) });
		default:
			return describeFailure(e, name);
	}
}
