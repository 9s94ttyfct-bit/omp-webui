import { PREF } from "@shared/prefs.ts";
import { useEffect, useState } from "react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { onPrefsChanged, setPref } from "../lib/prefs.ts";
import { useApp } from "../store/app.ts";
import { CardHeader } from "./ui.tsx";

/**
 * Settings › Sleep (#647): the Mac is kept from going to *idle* sleep while a conversation works, so that a turn is not
 * cut in half by a machine that decided it was idle.
 *
 * The card says what this does *not* do, because both are the questions it raises: the display still sleeps (only idle
 * sleep is held off, `caffeinate -i`), and closing the lid still sleeps the machine (macOS's own rule). What it cannot do
 * at all is on a machine that has no `caffeinate` (anything but macOS): `/api/meta` says so (`keepAwakeAvailable`), and the
 * card says the setting is not available there rather than showing a switch that would do nothing.
 *
 * A page that is not on this computer reads it and cannot change it, as it cannot change the guard's settings: the server
 * refuses `ompw.keepAwake` from such a page (`/api/prefs`), and the switch says why rather than failing on a click.
 *
 * The switch's value is the preference, read here as everything reads it (`localStorage`, kept in step with the server by
 * `lib/prefs.ts`): the server applies it as it changes, because the page is not the only way it changes (the app's other
 * window, a browser tab). Unset is on, which is how the server reads it too.
 */
export function SleepSettings() {
	const t = useT();
	const [on, setOn] = useState(() => localStorage.getItem(PREF.keepAwake) !== "off");
	// Whether this machine can be held awake at all: a server of an earlier version does not say, and had no such setting.
	const available = useApp((s) => s.meta?.keepAwakeAvailable) === true;
	const remote = useApp((s) => s.meta?.remote === true);
	useEffect(
		() =>
			onPrefsChanged((keys) => keys.includes(PREF.keepAwake) && setOn(localStorage.getItem(PREF.keepAwake) !== "off")),
		[],
	);
	return (
		<section className="rounded-2xl border border-border bg-surface p-4" data-testid="sleep-settings">
			<CardHeader title={t("pages.settingsSleep")} hint={t("pages.settingsSleepIntro")} />
			<label className="flex cursor-pointer items-start gap-3 text-sm">
				<input
					type="checkbox"
					className="mt-1 accent-[var(--accent)]"
					data-testid="keep-awake"
					checked={available && on}
					disabled={!available || remote}
					onChange={(e) => {
						setPref(PREF.keepAwake, e.target.checked ? "on" : "off");
						setOn(e.target.checked);
					}}
				/>
				<span>
					{t("pages.settingsKeepAwake")}
					<span className="block text-xs text-muted" data-testid="keep-awake-hint">
						{t(
							remote
								? "pages.settingsKeepAwakeRemote"
								: available
									? "pages.settingsKeepAwakeHint"
									: "pages.settingsKeepAwakeUnavailable",
						)}
					</span>
				</span>
			</label>
			<p className="mt-3 max-w-prose text-xs text-muted" data-testid="sleep-after">
				{t("pages.settingsSleepAfter")}
			</p>
		</section>
	);
}
