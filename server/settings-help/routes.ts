import { isRecord } from "../../shared/guards.ts";
import { SettingValueError } from "./catalog.ts";
import { type SettingsHelp, SettingsHelpError } from "./service.ts";

/**
 * The routes of "Ask agent for help" (`/api/settings-help*`), every one of them for a page on this computer only
 * (`isLocalOnlyRoute`; `route` in `main.ts` refuses any other with 403 before this is reached, and `local` is checked again
 * here): starting the conversation, Revoke now, the Allow / Deny of a sensitive change, and Undo.
 *
 * - `GET /api/settings-help`: the state (`SettingsHelpState`).
 * - `POST /api/settings-help/start`: start a dedicated conversation; answers its `LiveAttached`.
 * - `POST /api/settings-help/revoke` `{ liveId }`: end that conversation's access now.
 * - `POST /api/settings-help/answer` `{ id, allow }`: the person's answer to a sensitive change.
 * - `POST /api/settings-help/undo` `{ id }`: put back what one logged change replaced.
 * - `POST /api/settings-help/undo-all` `{ liveId }`: undo every standing change of one conversation, newest first.
 */
export async function handleSettingsHelp(
	req: Request,
	url: URL,
	help: SettingsHelp,
	local: boolean,
	reply: { json: (data: unknown, status?: number) => Response; fail: (error: string, status?: number) => Response },
): Promise<Response> {
	const { json, fail } = reply;
	if (!local) return fail("Ask agent for help is used on the computer omp-webui runs on", 403);
	const path = url.pathname;
	if (path === "/api/settings-help") return json(help.state());
	if (req.method !== "POST") return fail("POST required", 405);
	const body: unknown = await req.json().catch(() => null);
	const field = (name: string): unknown => (isRecord(body) ? body[name] : undefined);
	try {
		switch (path) {
			case "/api/settings-help/start":
				return json(await help.start());
			case "/api/settings-help/revoke": {
				const liveId = field("liveId");
				if (typeof liveId !== "string" || !help.revoke(liveId, "revoked"))
					return fail("That conversation has no access to revoke", 404);
				return json(help.state());
			}
			case "/api/settings-help/answer":
				help.answer(field("id"), field("allow"));
				return json(help.state());
			case "/api/settings-help/undo":
				return json({ change: await help.undo(field("id")), state: help.state() });
			case "/api/settings-help/undo-all":
				return json({ ...(await help.undoAll(field("liveId"))), state: help.state() });
			default:
				return fail("Not found", 404);
		}
	} catch (e) {
		if (e instanceof SettingsHelpError) return fail(e.message, e.status);
		// A setter's own refusal of an undo (a value it no longer takes) is the page's to read.
		if (e instanceof SettingValueError) return fail(e.message, 409);
		return fail((e as Error).message, 500);
	}
}
