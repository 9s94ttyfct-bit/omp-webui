import { useEffect, useState } from "react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { type LoginStartAnswer, loadLoginStart, setLoginStart } from "../lib/login-start.ts";
import { inShell } from "../lib/shell-notify.ts";
import { CardHeader } from "./ui.tsx";

/**
 * Settings › App & system › Start at login (off unless turned on): the macOS app as its own login item, opening no window;
 * the launcher on Windows and Linux, started with `--background` (see `lib/login-start.ts`). Not shown where this page
 * cannot change it: a browser on a Mac (the app's window can), a server run from source, a page that is not the person's own.
 */
export function LoginStartSettings() {
	const t = useT();
	const [answer, setAnswer] = useState<LoginStartAnswer | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		let gone = false;
		loadLoginStart()
			.then((a) => gone || setAnswer(a))
			.catch(() => {});
		return () => {
			gone = true;
		};
	}, []);
	if (!answer) return null;
	const on = answer.state !== "off";
	const change = async (next: boolean) => {
		setBusy(true);
		setError(null);
		try {
			const now = await setLoginStart(next);
			setAnswer(now);
			if (now.error) setError(now.error);
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	};
	return (
		<section className="rounded-2xl border border-border bg-surface p-4" data-testid="login-start-settings">
			<CardHeader title={t("pages.settingsLoginStart")} />
			<label className="flex cursor-pointer items-start gap-3 text-sm">
				<input
					type="checkbox"
					className="mt-1 accent-[var(--accent)]"
					data-testid="login-start"
					checked={on}
					disabled={busy}
					onChange={(e) => void change(e.target.checked)}
				/>
				<span>
					{t("pages.settingsLoginStartSwitch")}
					<span className="block text-xs text-muted">
						{t(inShell() ? "pages.settingsLoginStartHintApp" : "pages.settingsLoginStartHintLauncher")}
					</span>
				</span>
			</label>
			{answer.state === "approval" && (
				<p className="mt-2 text-xs text-muted" data-testid="login-start-approval">
					{t("pages.settingsLoginStartApproval")}
				</p>
			)}
			{error && (
				<p className="mt-2 text-xs text-danger" role="alert" data-testid="login-start-error">
					{t("pages.settingsLoginStartFailed", { error })}
				</p>
			)}
		</section>
	);
}
