import { Lock, ScanEye } from "lucide-react";
import { type KeyboardEvent, lazy, type ReactNode, Suspense, useEffect, useId, useRef, useState } from "react";
import { useT } from "../i18n/index.ts";
import { guardApi } from "../lib/guard-api.ts";
import { MODE_TEXT } from "../lib/guard-format.ts";
import { useGuardStrings } from "../lib/guard-strings.ts";
import { showSettingsCard } from "../lib/shortcut-view.ts";
import { useApp } from "../store/app.ts";
import { useGuard } from "../store/guard.ts";
import GuardDecisions from "./GuardDecisions.tsx";
import { Button, cx, Empty, Spinner } from "./ui.tsx";

// The policy editor and the benchmark have strings, requests and code of their own: they load when their tab is first opened.
const GuardPolicy = lazy(() => import("./GuardPolicy.tsx"));
const GuardBench = lazy(() => import("./GuardBench.tsx"));

type Tab = "decisions" | "policy" | "bench";

const TABS: readonly { value: Tab; label: "guard.tabDecisions" | "guard.tabPolicy" | "guard.tabBench" }[] = [
	{ value: "decisions", label: "guard.tabDecisions" },
	{ value: "policy", label: "guard.tabPolicy" },
	{ value: "bench", label: "guard.tabBench" },
];

/**
 * The Guard page ("Guard dangerous commands" at full size): what the guard decided, in a list of its own (Decisions); how
 * strict it is for each kind of call and the rules the reviewer follows (Policy); and a benchmark that shows what it would
 * stop and what it would let through (Benchmark). It is the page of this computer: the guard is changed here, and a page that
 * came through the tunnel is told so and asks for nothing (the routes refuse it too).
 *
 * The tabs are written out here, not taken from Radix: its tab list shares two packages with the panel's, which a bundler then
 * moves into the first page load for the sake of one more page that uses them.
 */
export default function GuardPage() {
	const t = useT();
	const ready = useGuardStrings();
	const meta = useApp((s) => s.meta);
	const remote = meta?.remote === true;
	const live = meta !== null && !remote;
	const config = useGuard((s) => s.config);
	const [tab, setTab] = useState<Tab>("decisions");
	const ids = useId();
	const triggers = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});

	useEffect(() => {
		if (live) void guardApi.config().catch(() => {});
	}, [live]);

	if (!ready) return null;

	const title = (
		<h1 className="flex items-center gap-3 text-xl font-semibold">
			<ScanEye className="shrink-0 text-accent" /> {t("guard.pageTitle")}
		</h1>
	);
	const shell = (body: ReactNode) => (
		<div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden" data-testid="guard-page">
			{body}
		</div>
	);

	if (remote) {
		return shell(
			<div className="mx-auto w-full max-w-xl space-y-6 px-6 py-8">
				{title}
				<div data-testid="guard-page-remote">
					<Empty icon={<Lock size={28} className="text-accent" />} title={t("guard.pageRemoteTitle")}>
						{t("guard.pageRemoteHint")}
					</Empty>
				</div>
			</div>,
		);
	}
	if (!live) {
		return shell(
			<div className="flex justify-center py-20">
				<Spinner />
			</div>,
		);
	}

	// Left and Right move between the tabs, Home and End go to the first and last: the keys of a tab list.
	const onKeyDown = (e: KeyboardEvent, at: number) => {
		const last = TABS.length - 1;
		const to =
			e.key === "ArrowRight"
				? at === last
					? 0
					: at + 1
				: e.key === "ArrowLeft"
					? at === 0
						? last
						: at - 1
					: e.key === "Home"
						? 0
						: e.key === "End"
							? last
							: -1;
		if (to < 0) return;
		e.preventDefault();
		const next = TABS[to].value;
		setTab(next);
		triggers.current[next]?.focus();
	};

	return shell(
		<>
			<div className="px-4 pt-6 sm:px-6">
				{title}
				<p className="mt-1 max-w-prose text-xs text-muted">{t("guard.pageHint")}</p>
				<p className="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-muted" data-testid="guard-page-mode">
					{config ? t("guard.pageMode", { mode: t(MODE_TEXT[config.mode].label) }) : null}
					<Button
						size="sm"
						data-testid="guard-page-settings"
						onClick={() => showSettingsCard('[data-testid="guard-settings"]')}
					>
						{t("guard.pageOpenSettings")}
					</Button>
				</p>
			</div>
			<div
				role="tablist"
				aria-label={t("guard.pageTabs")}
				className="mx-4 mt-3 flex shrink-0 gap-1 overflow-x-auto border-b border-border sm:mx-6"
			>
				{TABS.map((x, at) => (
					<button
						key={x.value}
						type="button"
						role="tab"
						id={`${ids}-tab-${x.value}`}
						ref={(el) => {
							triggers.current[x.value] = el;
						}}
						aria-selected={tab === x.value}
						aria-controls={`${ids}-panel-${x.value}`}
						tabIndex={tab === x.value ? 0 : -1}
						data-testid={`guard-tab-${x.value}`}
						className={cx(
							"-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-accent",
							tab === x.value ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg",
						)}
						onClick={() => setTab(x.value)}
						onKeyDown={(e) => onKeyDown(e, at)}
					>
						{t(x.label)}
					</button>
				))}
			</div>
			<div
				role="tabpanel"
				id={`${ids}-panel-${tab}`}
				aria-labelledby={`${ids}-tab-${tab}`}
				className={cx("flex min-h-0 flex-1 flex-col", tab !== "decisions" && "overflow-y-auto")}
			>
				{tab === "decisions" ? <GuardDecisions /> : null}
				<Suspense fallback={null}>
					{tab === "policy" ? <GuardPolicy /> : null}
					{tab === "bench" ? <GuardBench /> : null}
				</Suspense>
			</div>
		</>,
	);
}
