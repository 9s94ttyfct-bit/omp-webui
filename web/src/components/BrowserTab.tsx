import type { PageInfo, PageMode, Size } from "@shared/browser-protocol.ts";
import { PREF } from "@shared/prefs.ts";
import { ArrowLeft, ArrowRight, Globe, Plus, RotateCw, SquareCode, TriangleAlert, X } from "lucide-react";
import { type FormEvent, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { en } from "../i18n/browser.ts";
import { registerStrings, useT } from "../i18n/index.ts";
import { storedBrowserSize } from "../lib/browser-size.ts";
import { onPrefsChanged } from "../lib/prefs.ts";
import { hasBrowserBridge, postBrowserBridge } from "../lib/shell-notify.ts";
import { useApp } from "../store/app.ts";
import { browserApi, useBrowserState } from "../store/browser.ts";
import { holdScreen, sendScreen, useScreen } from "../store/browser-screen.ts";
import { BrowserConsole } from "./BrowserConsole.tsx";
import { BrowserScreen } from "./BrowserScreen.tsx";
import { Button, cx, Empty, IconButton, Spinner } from "./ui.tsx";

// This tab is a lazy chunk; the strings are not in the first page, so it brings its own (Settings › Browser does too).
registerStrings("browser", en);

const NO_PAGES: readonly PageInfo[] = [];

/** The page each conversation's tab showed last, for when it is shown again. */
const lastShown = new Map<string, string>();
/** Pages given the desktop size of Settings › Browser by this page already (a page the person sized is left alone). */
const sized = new Set<string>();

function useDesktopSize(): Size {
	const [size, setSize] = useState(storedBrowserSize);
	useEffect(() => onPrefsChanged((keys) => keys.includes(PREF.browserSize) && setSize(storedBrowserSize())), []);
	return size;
}

/** The size of an element's box in CSS pixels, as it changes. */
function useBoxSize(el: HTMLElement | null): Size | null {
	const [size, setSize] = useState<Size | null>(null);
	useEffect(() => {
		if (!el) return;
		const observer = new ResizeObserver(() => {
			const w = Math.round(el.clientWidth);
			const h = Math.round(el.clientHeight);
			setSize((s) => (s && s.w === w && s.h === h ? s : { w, h }));
		});
		observer.observe(el);
		return () => observer.disconnect();
	}, [el]);
	return size;
}

/** `value`, once it has stayed the same for `ms` (a panel being dragged settles before the page is told). */
function useSettled<T>(value: T, ms: number): T {
	const [settled, setSettled] = useState(value);
	useEffect(() => {
		const timer = setTimeout(() => setSettled(value), ms);
		return () => clearTimeout(timer);
	}, [value, ms]);
	return settled;
}

/**
 * The side panel's Browser tab (docs/agents/browser.md): the pages of the conversation `owner` (its session file) as tabs,
 * an address field, back / forward / reload, a new page, and the page's layout size (desktop, the panel's, a phone's). The
 * page itself is the screencast (`BrowserScreen`), or in the Mac app's own window its native view, placed over the frame
 * area through `ompwBrowser`. Under it, the page's console.
 */
export function BrowserTab({ owner }: { owner: string }) {
	const t = useT();
	const state = useBrowserState((s) => s.state);
	const listed = useScreen((s) => (s.owner === owner ? s.pages : NO_PAGES));
	const answered = useScreen((s) => s.answered);
	const unavailable = useScreen((s) => s.unavailable);
	const bridge = useMemo(hasBrowserBridge, []);
	const desktop = useDesktopSize();
	const [selected, setSelected] = useState<string | null>(() => lastShown.get(owner) ?? null);
	/** The pages there were when the person asked for a new one: the first that was not is shown. */
	const opening = useRef<Set<string> | null>(null);
	// The frame area mounts after the server's first answer: its element is state, so its size is watched from then on.
	const [frameEl, setFrameEl] = useState<HTMLDivElement | null>(null);
	const frame = useRef<HTMLDivElement | null>(null);
	const box = useBoxSize(frameEl);
	const room = useSettled(box, 120);
	const address = useRef<HTMLInputElement>(null);

	useEffect(() => holdScreen(), []);
	useEffect(() => {
		browserApi.load().catch(() => {});
	}, []);

	const current = listed.find((p) => p.targetId === selected) ?? null;
	// The page shown: the one chosen while it is there; a new one the person asked for once it is; else the first.
	useEffect(() => {
		if (opening.current) {
			const added = listed.find((p) => !opening.current?.has(p.targetId));
			if (added) {
				opening.current = null;
				setSelected(added.targetId);
				return;
			}
		}
		if (!answered || (selected && listed.some((p) => p.targetId === selected))) return;
		setSelected(listed[0]?.targetId ?? null);
	}, [listed, answered, selected]);
	useEffect(() => {
		if (selected) lastShown.set(owner, selected);
	}, [owner, selected]);

	// Watch the conversation's pages and the frames of the one shown, at the room the frame area has (in device pixels).
	// Asked again when the engine was installed or updated.
	const installedVersion = state?.installed?.version ?? null;
	const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
	const watchedPage = current?.targetId ?? (answered ? null : selected);
	const panelW = room ? Math.max(1, Math.round(room.w * dpr)) : 1;
	const panelH = room ? Math.max(1, Math.round(room.h * dpr)) : 1;
	// biome-ignore lint/correctness/useExhaustiveDependencies: installedVersion asks again after an install.
	useEffect(() => {
		sendScreen({ t: "watch", owner, targetId: bridge ? null : watchedPage, panel: { w: panelW, h: panelH } });
	}, [owner, watchedPage, panelW, panelH, bridge, installedVersion]);
	useEffect(() => () => sendScreen({ t: "unwatch" }), []);

	// A page shown for the first time is laid out at the desktop size of Settings › Browser, when it is not that already.
	useEffect(() => {
		if (current?.mode !== "desktop" || sized.has(current.targetId)) return;
		sized.add(current.targetId);
		if (current.w !== desktop.w || current.h !== desktop.h)
			sendScreen({ t: "size", targetId: current.targetId, mode: "desktop", desktop });
	}, [current, desktop]);
	// "Follow the panel": the page takes the size of the panel that last changed it. This one changes it when its own size
	// changes, not each time it is told the page's (another panel may have set it since).
	const followed = useRef<Size | null>(null);
	useEffect(() => {
		const before = followed.current;
		followed.current = room;
		if (current?.mode !== "panel" || !room || room.w < 1 || room.h < 1) return;
		if (before && before.w === room.w && before.h === room.h) return;
		if (current.w === room.w && current.h === room.h) return;
		sendScreen({ t: "size", targetId: current.targetId, mode: "panel", panel: room });
	}, [current, room]);

	const setMode = (mode: PageMode) => {
		if (!current) return;
		sized.add(current.targetId);
		sendScreen({
			t: "size",
			targetId: current.targetId,
			mode,
			...(mode === "panel" && room ? { panel: room } : {}),
			desktop,
		});
	};
	const newPage = () => {
		opening.current = new Set(listed.map((p) => p.targetId));
		sendScreen({ t: "open", owner, url: "about:blank" });
		address.current?.focus();
	};

	if (state && !state.installed && (unavailable !== null || state.job)) return <NotInstalled />;
	if (state && !state.installed && !answered) {
		return (
			<div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted" data-testid="browser-tab">
				<Spinner size={14} /> {t("browser.waiting")}
			</div>
		);
	}

	return (
		<div className="flex min-h-0 flex-1 flex-col" data-testid="browser-tab">
			{listed.length ? (
				<div className="flex items-center gap-1 border-b border-border px-1.5 py-1">
					<div
						className="flex min-w-0 flex-1 gap-1 overflow-x-auto"
						role="tablist"
						aria-label={t("browser.pagesLabel")}
					>
						{listed.map((p) => {
							// A blank page is a new one (Chrome calls it by its address).
							const title = !p.url || p.url === "about:blank" ? t("browser.untitled") : p.title || p.url;
							const on = p.targetId === current?.targetId;
							return (
								<div
									key={p.targetId}
									className={cx(
										"flex max-w-44 min-w-0 shrink-0 items-center rounded-md text-xs",
										on ? "bg-hover text-fg" : "text-muted hover:bg-hover",
									)}
								>
									<button
										type="button"
										role="tab"
										aria-selected={on}
										className="min-w-0 truncate py-1 pr-1 pl-2 text-left"
										title={p.url}
										data-testid="browser-page-tab"
										data-target={p.targetId}
										onClick={() => setSelected(p.targetId)}
									>
										{title}
									</button>
									<IconButton
										size="xs"
										label={t("browser.closePage", { title })}
										onClick={() => sendScreen({ t: "close", targetId: p.targetId })}
										data-testid="browser-page-close"
									>
										<X size={12} />
									</IconButton>
								</div>
							);
						})}
					</div>
					<IconButton size="sm" label={t("browser.newPage")} onClick={newPage} data-testid="browser-new">
						<Plus size={15} />
					</IconButton>
				</div>
			) : null}
			<div className="flex items-center gap-0.5 border-b border-border px-1.5 py-1">
				<IconButton
					size="sm"
					label={t("browser.back")}
					disabled={!current?.canBack}
					onClick={() => current && sendScreen({ t: "navigate", targetId: current.targetId, action: "back" })}
					data-testid="browser-back"
				>
					<ArrowLeft size={15} />
				</IconButton>
				<IconButton
					size="sm"
					label={t("browser.forward")}
					disabled={!current?.canForward}
					onClick={() => current && sendScreen({ t: "navigate", targetId: current.targetId, action: "forward" })}
					data-testid="browser-forward"
				>
					<ArrowRight size={15} />
				</IconButton>
				<IconButton
					size="sm"
					label={t("browser.reload")}
					disabled={!current}
					onClick={() => current && sendScreen({ t: "navigate", targetId: current.targetId, action: "reload" })}
					data-testid="browser-reload"
				>
					<RotateCw size={14} />
				</IconButton>
				<AddressField
					inputRef={address}
					url={current?.url ?? ""}
					onGo={(url) => {
						if (current) sendScreen({ t: "navigate", targetId: current.targetId, action: "url", url });
						else {
							opening.current = new Set(listed.map((p) => p.targetId));
							sendScreen({ t: "open", owner, url });
						}
					}}
				/>
				{listed.length ? null : (
					<IconButton size="sm" label={t("browser.newPage")} onClick={newPage} data-testid="browser-new">
						<Plus size={15} />
					</IconButton>
				)}
				{bridge && current ? (
					<IconButton
						size="sm"
						label={t("browser.devtools")}
						onClick={() => postBrowserBridge({ type: "devtools", targetId: current.targetId })}
						data-testid="browser-devtools"
					>
						<SquareCode size={15} />
					</IconButton>
				) : null}
			</div>
			<SizeSwitch page={current} desktop={desktop} onMode={setMode} />
			{unavailable ? (
				<p
					className="flex items-start gap-1.5 border-b border-border px-2.5 py-1.5 text-xs text-warning"
					role="status"
					data-testid="browser-unavailable"
				>
					<TriangleAlert size={13} className="mt-px shrink-0" /> {t("browser.unavailable", { reason: unavailable })}
				</p>
			) : null}
			<div
				ref={(el) => {
					frame.current = el;
					setFrameEl(el);
				}}
				className="relative flex min-h-0 flex-1 flex-col"
				data-testid="browser-frame"
			>
				{current ? (
					bridge ? (
						<NativeArea frame={frame} page={current} />
					) : (
						<BrowserScreen key={current.targetId} page={current} />
					)
				) : (
					<div className="flex flex-1 items-center justify-center p-4" data-testid="browser-empty">
						<Empty icon={<Globe size={22} />} title={t("browser.emptyTitle")}>
							{t("browser.emptyBody")}
						</Empty>
					</div>
				)}
			</div>
			{current ? <BrowserConsole page={current} /> : null}
			{bridge && !current ? <HideNative /> : null}
		</div>
	);
}

/** The address of the page shown, until the person edits it; Enter goes to what is typed. */
function AddressField({
	url,
	onGo,
	inputRef,
}: {
	url: string;
	onGo: (url: string) => void;
	inputRef: RefObject<HTMLInputElement | null>;
}) {
	const t = useT();
	const [draft, setDraft] = useState(url);
	const [editing, setEditing] = useState(false);
	useEffect(() => {
		if (!editing) setDraft(url === "about:blank" ? "" : url);
	}, [url, editing]);
	const submit = (e: FormEvent) => {
		e.preventDefault();
		const typed = draft.trim();
		if (!typed) return;
		setEditing(false);
		onGo(typed);
		inputRef.current?.blur();
	};
	return (
		<form className="min-w-0 flex-1" onSubmit={submit}>
			<input
				ref={inputRef}
				type="text"
				inputMode="url"
				enterKeyHint="go"
				autoCapitalize="off"
				autoComplete="off"
				autoCorrect="off"
				spellCheck={false}
				value={draft}
				aria-label={t("browser.address")}
				placeholder={t("browser.addressPlaceholder")}
				className="h-7 w-full rounded-md border border-border bg-bg px-2 text-xs outline-none focus:border-accent"
				data-testid="browser-address"
				onFocus={(e) => e.currentTarget.select()}
				onChange={(e) => {
					setEditing(true);
					setDraft(e.target.value);
				}}
				onBlur={() => setEditing(false)}
				onKeyDown={(e) => {
					if (e.key !== "Escape") return;
					setEditing(false);
					setDraft(url === "about:blank" ? "" : url);
				}}
			/>
		</form>
	);
}

/** Desktop / Panel / Phone: the layout size of the page shown, and that size. */
function SizeSwitch({
	page,
	desktop,
	onMode,
}: {
	page: PageInfo | null;
	desktop: Size;
	onMode: (mode: PageMode) => void;
}) {
	const t = useT();
	const modes: { mode: PageMode; label: string; hint: string }[] = [
		{
			mode: "desktop",
			label: t("browser.sizeDesktop"),
			hint: t("browser.sizeDesktopHint", { w: desktop.w, h: desktop.h }),
		},
		{ mode: "panel", label: t("browser.sizePanel"), hint: t("browser.sizePanelHint") },
		{ mode: "phone", label: t("browser.sizePhone"), hint: t("browser.sizePhoneHint") },
	];
	return (
		<div className="flex items-center gap-2 border-b border-border px-2 py-1 text-xs">
			<fieldset className="flex rounded-md border border-border p-0.5" aria-label={t("browser.sizeLabel")}>
				{modes.map((m) => (
					<button
						key={m.mode}
						type="button"
						aria-pressed={page?.mode === m.mode}
						disabled={!page}
						title={m.hint}
						className={cx(
							"rounded px-2 py-0.5 disabled:opacity-40",
							page?.mode === m.mode ? "bg-hover font-medium text-fg" : "text-muted hover:text-fg",
						)}
						data-testid={`browser-size-${m.mode}`}
						onClick={() => onMode(m.mode)}
					>
						{m.label}
					</button>
				))}
			</fieldset>
			{page ? (
				<span className="text-faint tabular-nums" data-testid="browser-page-size">
					{page.w}×{page.h}
				</span>
			) : null}
		</div>
	);
}

/** Whether a menu, popover or dialog of the page (a Radix portal that is open) lies over `rect`. */
function covered(rect: DOMRect): boolean {
	const root = document.getElementById("root");
	for (const el of document.querySelectorAll<HTMLElement>('[data-state="open"]')) {
		if (root?.contains(el)) continue;
		const r = el.getBoundingClientRect();
		if (r.width && r.height && r.left < rect.right && r.right > rect.left && r.top < rect.bottom && r.bottom > rect.top)
			return true;
	}
	return false;
}

/**
 * In the Mac app's own window: the frame area the native view is laid over. Its place is told on every change (a frame
 * at a time, so a resize, a panel drag, a scroll or a tab switch all move the view with it), whether something of the page
 * covers it, and that it is gone when it is (a folded pane, another tab, the panel closed).
 */
function NativeArea({ frame, page }: { frame: RefObject<HTMLDivElement | null>; page: PageInfo }) {
	useEffect(() => {
		let last = "";
		let lastCover: boolean | null = null;
		let request = 0;
		const tick = () => {
			request = requestAnimationFrame(tick);
			const el = frame.current;
			if (!el) return;
			const r = el.getBoundingClientRect();
			if (r.width < 1 || r.height < 1) {
				if (last !== "hide") postBrowserBridge({ type: "hide" });
				last = "hide";
				return;
			}
			const rect = { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
			const key = `${page.targetId}|${page.mode}|${rect.x},${rect.y},${rect.w},${rect.h}`;
			if (key !== last) postBrowserBridge({ type: "place", targetId: page.targetId, rect, mode: page.mode });
			last = key;
			const now = covered(r);
			if (now !== lastCover) postBrowserBridge({ type: "cover", covered: now });
			lastCover = now;
		};
		tick();
		return () => {
			cancelAnimationFrame(request);
			postBrowserBridge({ type: "hide" });
		};
	}, [frame, page.targetId, page.mode]);
	return <div className="flex-1" data-testid="browser-native" />;
}

/** In the Mac app's own window, with no page to show: the native view is put away. */
function HideNative() {
	useEffect(() => postBrowserBridge({ type: "hide" }), []);
	return null;
}

/** The engine is not installed: says so, and offers Install to a page that may install it. */
function NotInstalled() {
	const t = useT();
	const state = useBrowserState((s) => s.state);
	const setView = useApp((s) => s.setView);
	const toast = useApp((s) => s.toast);
	if (!state) return null;
	return (
		<div className="flex flex-1 items-center justify-center p-4" data-testid="browser-tab">
			<div className="max-w-xs space-y-3 text-center" data-testid="browser-not-installed">
				<Globe size={22} className="mx-auto text-muted" />
				<h3 className="text-sm font-semibold">{t("browser.notInstalledTitle")}</h3>
				<p className="text-xs text-muted">
					{state.canManage ? t("browser.notInstalledBody") : t("browser.notInstalledCannot")}
				</p>
				{state.job ? (
					<p className="flex items-center justify-center gap-2 text-xs" role="status">
						<Spinner size={13} /> {t("browser.jobInstall")}
					</p>
				) : (
					<div className="flex flex-wrap justify-center gap-2">
						{state.canManage ? (
							<Button
								variant="primary"
								size="sm"
								data-testid="browser-install"
								onClick={() => browserApi.install().catch((e: Error) => toast("error", e.message))}
							>
								{t("browser.install")}
							</Button>
						) : null}
						<Button
							size="sm"
							data-testid="browser-open-settings"
							onClick={() => setView({ kind: "settings", page: "app" })}
						>
							{t("browser.openSettings")}
						</Button>
					</div>
				)}
			</div>
		</div>
	);
}
