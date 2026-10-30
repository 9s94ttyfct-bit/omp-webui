import type { PushDevice } from "@shared/push.ts";
import { BellRing, Check, Smartphone, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { type MessageKey, useT } from "../i18n/index.ts";
import { ApiError } from "../lib/api.ts";
import { errorText } from "../lib/error-text.ts";
import { fmtRelative } from "../lib/format.ts";
import {
	disablePush,
	enablePush,
	PushBlocked,
	type PushSupport,
	pushApi,
	pushSupport,
	revokeAllDevices,
	revokeDevice,
} from "../lib/push.ts";
import { pushDevice } from "../lib/push-presence.ts";
import { usePushStrings } from "../lib/push-strings.ts";
import { Switch } from "./Switch.tsx";
import { Badge, Button, CardHeader, Spinner } from "./ui.tsx";

type Outcome =
	| { state: "idle" }
	| { state: "busy" }
	| { state: "done"; text: MessageKey }
	| { state: "error"; text: MessageKey; error: unknown };

/** Why this browser cannot be switched on, as the sentence that says it. */
const WHY: Record<Exclude<PushSupport, "ok">, MessageKey> = {
	macApp: "push.macApp",
	needsHttps: "push.needsHttps",
	needsApp: "push.needsApp",
	unsupported: "push.unsupported",
};

/**
 * Settings › Notifications when this page is closed (#629): turn Web Push on for this browser (a phone's home-screen app, a
 * computer's browser), see the devices the server notifies, say for each whether its notification carries a line of the message,
 * send a test, and revoke one or all. Not for the macOS app (it shows its own). A card of its own chunk, with its own strings.
 */
export function PushSettings() {
	const t = useT();
	const ready = usePushStrings();
	const support = pushSupport();
	const [devices, setDevices] = useState<PushDevice[] | null>(null);
	const [outcome, setOutcome] = useState<Outcome>({ state: "idle" });
	/** The id the server gave this browser, which it keeps (`push-presence.ts`); null: this browser is not notified. */
	const [mine, setMine] = useState(() => pushDevice()?.id ?? null);
	const [permission, setPermission] = useState(() =>
		typeof Notification === "undefined" ? "default" : Notification.permission,
	);

	const load = useCallback(async () => {
		try {
			setDevices((await pushApi.list()).devices);
		} catch (error) {
			setOutcome({ state: "error", text: "push.loadFailed", error });
		}
	}, []);
	useEffect(() => {
		if (support !== "macApp") void load();
	}, [support, load]);

	if (!ready || support === "macApp") return null;

	/** Run a change, then read the list again: what it did is what the server has now. */
	const run = async (
		change: () => Promise<unknown>,
		done: MessageKey | null,
		failed: MessageKey = "push.changeFailed",
	) => {
		setOutcome({ state: "busy" });
		try {
			await change();
			setOutcome(done ? { state: "done", text: done } : { state: "idle" });
		} catch (error) {
			if (error instanceof PushBlocked) setPermission("denied");
			setOutcome({ state: "error", text: error instanceof PushBlocked ? "push.blocked" : failed, error });
		}
		if (typeof Notification !== "undefined") setPermission(Notification.permission);
		setMine(pushDevice()?.id ?? null);
		await load();
	};
	const busy = outcome.state === "busy";
	const on = mine !== null && devices?.some((d) => d.id === mine) === true;
	const blocked = support === "ok" && permission === "denied" && !on;

	return (
		<section
			className="rounded-2xl border border-border bg-surface p-4"
			data-testid="push-settings"
			data-index-title={t("push.indexTitle")}
		>
			<CardHeader title={t("push.title")} icon={<BellRing size={16} />} hint={t("push.hint")} />
			{support === "ok" ? (
				<div className="flex items-start gap-3">
					<Switch
						checked={on}
						label={t("push.enable")}
						data-testid="push-enable"
						busy={busy}
						disabled={blocked}
						onCheckedChange={(next) => void run(() => (next ? enablePush() : disablePush()), null, "push.failed")}
					/>
					<div className="min-w-0 flex-1 text-sm">
						{on ? t("push.disable") : t("push.enable")}
						<span className="block text-xs text-muted" data-testid="push-state" data-on={on ? "on" : "off"}>
							{blocked ? t("push.blocked") : on ? t("push.enabledNote") : ""}
						</span>
					</div>
				</div>
			) : (
				<p className="flex items-start gap-1.5 text-xs text-warning" data-testid="push-unsupported" data-why={support}>
					<TriangleAlert size={12} className="mt-0.5 shrink-0" aria-hidden /> {t(WHY[support])}
				</p>
			)}

			<h3 className="mt-4 mb-1 text-sm font-medium">{t("push.devices")}</h3>
			{devices === null ? null : devices.length === 0 ? (
				<p className="text-xs text-muted" data-testid="push-none">
					{t("push.none")}
				</p>
			) : (
				<ul className="divide-y divide-border text-sm" data-testid="push-devices">
					{devices.map((d) => (
						<li
							key={d.id}
							className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2"
							data-testid="push-device"
							data-id={d.id}
						>
							<Smartphone size={14} className="shrink-0 text-muted" aria-hidden />
							<span className="min-w-0 flex-1">
								<span className="flex flex-wrap items-center gap-1.5">
									<span className="truncate">{d.label}</span>
									{d.id === mine ? <Badge>{t("push.current")}</Badge> : null}
								</span>
								<span className="block text-xs text-muted">
									{d.lastSentAt === null
										? t("push.neverSent")
										: t("push.lastSent", { when: fmtRelative(d.lastSentAt) })}
								</span>
							</span>
							<div className="flex items-center gap-1.5 text-xs text-muted" title={t("push.previewHint")}>
								<Switch
									checked={d.preview}
									label={t("push.preview")}
									data-testid="push-preview"
									disabled={busy}
									onCheckedChange={(preview) => void run(() => pushApi.preview(d.id, preview), null)}
								/>
								{t("push.preview")}
							</div>
							<Button
								size="sm"
								data-testid="push-test"
								disabled={busy}
								onClick={() =>
									void run(
										async () => {
											const tested = await pushApi.test(d.id).catch((error: unknown) => {
												// The server's own sentence is English: the page says it in its language.
												throw error instanceof ApiError && error.status === 429 ? new Error(t("push.testWait")) : error;
											});
											if (!tested.ok) {
												throw new Error(
													tested.status === 404 || tested.status === 410
														? t("push.testGone")
														: t("push.testRefused", { status: tested.status }),
												);
											}
										},
										"push.testSent",
										"push.testFailed",
									)
								}
							>
								{t("push.test")}
							</Button>
							<Button
								size="sm"
								variant="ghost"
								data-testid="push-revoke"
								disabled={busy}
								aria-label={t("push.revokeLabel", { name: d.label })}
								onClick={() => void run(() => revokeDevice(d.id), "push.revoked")}
							>
								{t("push.revoke")}
							</Button>
						</li>
					))}
				</ul>
			)}
			{devices && devices.length > 1 ? (
				<div className="mt-2">
					<Button
						size="sm"
						data-testid="push-revoke-all"
						disabled={busy}
						onClick={() => void run(() => revokeAllDevices(), "push.revoked")}
					>
						{t("push.revokeAll")}
					</Button>
				</div>
			) : null}

			<p className="mt-2 text-xs text-faint">{t("push.remoteNote")}</p>
			<div className="mt-2 min-h-5 text-xs" role="status" data-testid="push-status" data-state={outcome.state}>
				{outcome.state === "busy" ? (
					<span className="inline-flex items-center gap-1.5 text-muted">
						<Spinner size={12} /> {t("push.enabling")}
					</span>
				) : outcome.state === "done" ? (
					<span className="inline-flex items-center gap-1.5 text-success">
						<Check size={12} aria-hidden /> {t(outcome.text)}
					</span>
				) : outcome.state === "error" ? (
					<span className="text-danger" data-testid="push-error">
						{t(outcome.text, { error: errorText(outcome.error) })}
					</span>
				) : null}
			</div>
		</section>
	);
}
