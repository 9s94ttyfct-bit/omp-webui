import * as Menu from "@radix-ui/react-dropdown-menu";
import { MAC_LIMIT, type SavedMac } from "@shared/macs.ts";
import { Check, ChevronDown, Monitor, Plus } from "lucide-react";
import { useRef, useState } from "react";
import { useT } from "../i18n/index.ts";
import { fmtRelative } from "../lib/format.ts";
import {
	addMacInApp,
	MACS_DOT,
	MACS_STATE,
	type MacLive,
	openMacInApp,
	openMacInTab,
	useMacLive,
} from "../lib/macs.ts";
import { useMacsStrings } from "../lib/macs-strings.ts";
import { useApp } from "../store/app.ts";
import { MacAddDialog } from "./MacAddDialog.tsx";
import { cx } from "./ui.tsx";

const item =
	"flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-hover max-md:min-h-11";

/** The room the row takes before its strings are there: as high as the row. */
const Room = () => (
	<div className="px-3 pt-2" aria-hidden>
		<div className="h-8" />
	</div>
);

/**
 * The machine switcher row (#628), under the New chat button: `This Mac ▾`, and in its menu the Macs the server has
 * saved (the macOS app's Macs menu keeps the same list), then `Add Mac…` on this computer. This row says which computer the
 * conversations below belong to; it is not a mode, which decides what a new omp process of this Mac loads and runs on
 * (New chat's Full / Light chip).
 *
 * A saved Mac opens as `openMacInApp` and `openMacInTab` say (the app's labelled window, or a new tab). What the row knows of
 * each Mac is only the last time the app opened it: its live state is the seam in `lib/macs.ts`, which a stream from that Mac
 * will fill in.
 */
export default function MachineSwitcher() {
	const ready = useMacsStrings();
	const t = useT();
	const macs = useApp((s) => s.meta?.macs);
	const local = useApp((s) => s.meta?.local === true);
	const connected = useApp((s) => s.connected);
	const toast = useApp((s) => s.toast);
	const states = useMacLive((s) => s.states);
	const trigger = useRef<HTMLButtonElement>(null);
	const [adding, setAdding] = useState(false);
	if (!ready) return <Room />;
	const list = macs ?? [];

	const open = (mac: SavedMac) => {
		const app = openMacInApp(mac);
		// No shell to ask (a browser, a phone, macOS 13): the Mac's own address, in a tab, straight from this click.
		if (app === null) return openMacInTab(mac);
		void app.then((done) => {
			if (!done) toast("error", t("macs.openRefused"));
		});
	};
	const add = () => {
		const app = addMacInApp();
		// The app has its own sheet (it looks at the address first); anywhere else the page asks for the name and the address.
		if (app === null) return setAdding(true);
		void app.then((done) => {
			if (!done) toast("error", t("macs.openRefused"));
		});
	};

	return (
		<div className="px-3 pt-2" data-testid="machine-row">
			<Menu.Root>
				<Menu.Trigger asChild>
					<button
						ref={trigger}
						type="button"
						data-testid="machine-switcher"
						aria-label={t("macs.rowAria")}
						title={t("macs.rowTitle")}
						className="flex h-8 w-full min-w-0 items-center gap-2 rounded-lg border border-border bg-surface px-2.5 text-xs hover:bg-hover data-[state=open]:bg-hover focus-visible:outline-2 focus-visible:outline-accent"
					>
						<Monitor size={13} aria-hidden className="shrink-0 text-muted" />
						<span className="min-w-0 flex-1 truncate text-left font-medium">{t("macs.thisMac")}</span>
						<ChevronDown size={13} aria-hidden className="shrink-0 text-muted" />
					</button>
				</Menu.Trigger>
				<Menu.Portal>
					<Menu.Content
						align="start"
						sideOffset={4}
						aria-label={t("macs.menuLabel")}
						data-testid="machine-menu"
						className="z-50 w-[var(--radix-dropdown-menu-trigger-width)] min-w-56 max-w-[calc(100vw-1rem)] rounded-xl border border-border bg-surface p-1 shadow-2xl"
					>
						<Menu.Item className={item} data-testid="machine-this" aria-current="true">
							<span
								aria-hidden
								className={cx("h-2 w-2 shrink-0 rounded-full", connected ? "bg-success" : "bg-danger")}
								data-testid="machine-this-dot"
							/>
							<span className="min-w-0 flex-1">
								<span className="block truncate font-medium">{t("macs.thisMac")}</span>
								<span className="block truncate text-xs text-muted">
									{connected ? t("macs.hereConnected") : t("macs.hereNotConnected")}
								</span>
							</span>
							<Check size={14} aria-hidden className="shrink-0 text-accent" />
						</Menu.Item>
						{list.map((mac) => {
							const state: MacLive = states[mac.id] ?? "unknown";
							return (
								<Menu.Item
									key={mac.id}
									className={item}
									data-testid="machine-item"
									data-mac={mac.id}
									data-state={state}
									title={t("macs.openTitle", { name: mac.name, host: mac.host })}
									onSelect={() => open(mac)}
								>
									<span
										aria-hidden
										className={cx("h-2 w-2 shrink-0 rounded-full", MACS_DOT[state])}
										data-testid="machine-dot"
									/>
									<span className="min-w-0 flex-1">
										<span className="block truncate font-medium">{mac.name}</span>
										<span className="block truncate text-xs text-muted">
											{state === "unknown" ? null : `${t(MACS_STATE[state])} · `}
											{mac.lastConnected
												? t("macs.lastConnected", { when: fmtRelative(mac.lastConnected) })
												: t("macs.neverConnected")}
										</span>
									</span>
								</Menu.Item>
							);
						})}
						{local ? (
							<>
								<Menu.Separator className="my-1 h-px bg-border" />
								<Menu.Item
									className={item}
									data-testid="machine-add"
									disabled={list.length >= MAC_LIMIT}
									onSelect={add}
								>
									<Plus size={14} aria-hidden className="shrink-0 text-muted" />
									{t("macs.add")}
								</Menu.Item>
							</>
						) : null}
					</Menu.Content>
				</Menu.Portal>
			</Menu.Root>
			{adding ? <MacAddDialog macs={list} onClose={() => setAdding(false)} returnFocusTo={trigger.current} /> : null}
		</div>
	);
}
