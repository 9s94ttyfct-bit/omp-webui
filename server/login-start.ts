import { homedir } from "node:os";
import { platform } from "./platform/index.ts";
import type { LoginItemOps } from "./platform/types.ts";

/**
 * Settings › App & system › Start at login, for the launcher (the Windows launcher's `omp-webui.exe`, the Linux package's
 * `omp-webui`): at login the system starts it with `--background`, which starts the server without opening a page (see
 * `server/launcher.ts`). The entry is the system's own (`platform.loginItem`: the user's `Run` key on Windows, an XDG
 * autostart entry on Linux), so what it says is what the switch shows: nothing is kept here. Off unless the person turns it
 * on. The macOS app registers itself (macos/loginitem.swift), and a server run from source (`bun server/main.ts`) is no
 * program to start at login: there the route says it is not available.
 *
 * `GET /api/login-start` → `{ available, on }`; `POST /api/login-start` `{ on: boolean }` → the same, as it is afterwards.
 * Local-only (`isLocalOnlyRoute`): a page that is not on this computer is refused it.
 */

export const LOGIN_START_PATH = "/api/login-start";

export interface LoginStartState {
	/** Whether this server can start at login (it runs from the launcher, on a system that has an entry for it). */
	available: boolean;
	on: boolean;
}

export class LoginStart {
	constructor(
		/** The launcher's program (`OMP_WEBUI_LAUNCHER`, which the launcher sets): what the entry starts; absent from source. */
		private readonly program: string | undefined = process.env.OMP_WEBUI_LAUNCHER || undefined,
		private readonly item: LoginItemOps | null = platform.loginItem,
		private readonly home: string = homedir(),
	) {}

	async state(): Promise<LoginStartState> {
		if (!this.program || !this.item) return { available: false, on: false };
		return { available: true, on: await this.item.read(this.home) };
	}

	async handle(req: Request): Promise<Response> {
		if (req.method === "GET") return Response.json(await this.state());
		if (req.method !== "POST") return Response.json({ error: "GET or POST" }, { status: 405 });
		const body = (await req.json().catch(() => null)) as { on?: unknown } | null;
		if (typeof body?.on !== "boolean") return Response.json({ error: "on must be true or false" }, { status: 400 });
		if (!this.program || !this.item)
			return Response.json(
				{ error: "Start at login is set by the macOS app, or needs the installed omp-webui" },
				{ status: 409 },
			);
		try {
			await this.item.write(this.home, body.on ? this.program : null);
		} catch (e) {
			return Response.json({ error: `Start at login could not be changed: ${(e as Error).message}` }, { status: 500 });
		}
		return Response.json(await this.state());
	}
}
