import { PREF, QUIT_ACTIONS, type QuitAction, quitActionOf } from "@shared/prefs.ts";
import { useEffect, useState } from "react";
import "../i18n/later.ts";
import { type MessageKey, useT } from "../i18n/index.ts";
import { onPrefsChanged, setPref } from "../lib/prefs.ts";
import { inShell } from "../lib/shell-notify.ts";
import { CardHeader, cx } from "./ui.tsx";

const LABELS: Record<QuitAction, { label: MessageKey; hint: MessageKey }> = {
	ask: { label: "pages.settingsQuitAsk", hint: "pages.settingsQuitAskHint" },
	background: { label: "pages.settingsQuitBackground", hint: "pages.settingsQuitBackgroundHint" },
	quit: { label: "pages.settingsQuitQuit", hint: "pages.settingsQuitQuitHint" },
};

const chosen = (): QuitAction => quitActionOf(localStorage.getItem(PREF.quitAction));
const iconAlways = (): boolean => localStorage.getItem(PREF.menuIcon) !== "off";

/**
 * What quitting the macOS app does: ask (the default), run in the background (the window goes; the app, its server, its
 * conversations and remote access run on, and the menu bar icon brings the window back) or quit. The app asks, with "Don't ask
 * again" on the question, and this is where that answer is undone. The shell reads the choice from the server when it is asked
 * to quit (`macos/quit.swift`), so the card is only there in the app: a browser has no such thing as quitting.
 *
 * Also whether the menu bar icon is there beside the window (`ompw.menuIcon`, on unless turned off): the app hears it from the
 * server's stream as it changes. In the background the icon is always there, for it is the way back.
 */
export function QuitSettings() {
	const t = useT();
	const [action, setAction] = useState(chosen);
	const [icon, setIcon] = useState(iconAlways);
	// The app wrote it (the question's "Don't ask again"), or another window chose it.
	useEffect(
		() =>
			onPrefsChanged((keys) => {
				if (keys.includes(PREF.quitAction)) setAction(chosen());
				if (keys.includes(PREF.menuIcon)) setIcon(iconAlways());
			}),
		[],
	);
	if (!inShell()) return null;
	return (
		<section className="rounded-2xl border border-border bg-surface p-4" data-testid="quit-settings">
			<CardHeader title={t("pages.settingsQuit")} />
			<fieldset className="space-y-1">
				<legend className="mb-1.5 text-sm">{t("pages.settingsQuitWhen")}</legend>
				{QUIT_ACTIONS.map((a) => {
					const on = action === a;
					return (
						<label
							key={a}
							className={cx(
								"flex cursor-pointer items-start gap-3 rounded-xl border px-3 py-2 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
								on ? "border-accent bg-accent-soft" : "border-border hover:bg-hover",
							)}
						>
							<input
								type="radio"
								name="quit-action"
								className="mt-1 accent-[var(--accent)]"
								data-testid={`quit-action-${a}`}
								checked={on}
								onChange={() => {
									setPref(PREF.quitAction, a);
									setAction(a);
								}}
							/>
							<span>
								{t(LABELS[a].label)}
								<span className="block text-xs text-muted">{t(LABELS[a].hint)}</span>
							</span>
						</label>
					);
				})}
			</fieldset>
			<p className="mt-3 text-xs text-muted">{t("pages.settingsQuitNote")}</p>
			<label className="mt-4 flex cursor-pointer items-start gap-3 text-sm">
				<input
					type="checkbox"
					className="mt-1 accent-[var(--accent)]"
					data-testid="menu-icon-always"
					checked={icon}
					onChange={(e) => {
						setPref(PREF.menuIcon, e.target.checked ? "on" : "off");
						setIcon(e.target.checked);
					}}
				/>
				<span>
					{t("pages.settingsMenuIcon")}
					<span className="block text-xs text-muted">{t("pages.settingsMenuIconHint")}</span>
				</span>
			</label>
		</section>
	);
}
