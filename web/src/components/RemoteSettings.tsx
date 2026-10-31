import type { RemoteConfig, RemoteState } from "@shared/remote.ts";
import { DEFAULT_FILE_TRANSFER, type FileTransfer } from "@shared/transfer.ts";
import {
	Check,
	CircleAlert,
	Copy,
	ExternalLink,
	FolderSync,
	Globe,
	Loader2,
	ShieldQuestion,
	Sparkles,
	SquareTerminal,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import "../i18n/later.ts";
import { type MessageKey, useT } from "../i18n/index.ts";
import { remoteApi, useRemote } from "../lib/remote.ts";
import { setUpWithAi } from "../lib/remote-ai.ts";
import { webUrl } from "../lib/web-url.ts";
import { useApp } from "../store/app.ts";
import { RemoteTransfer } from "./RemoteTransfer.tsx";
import { Select } from "./Select.tsx";
import { Switch } from "./Switch.tsx";
import { Button, CardHeader, cx, Spinner } from "./ui.tsx";

/** Where the Access application is made. */
const DASHBOARD = "https://one.dash.cloudflare.com/";

/** How often the card asks again while it waits for the Cloudflare sign-in (the server notices the certificate). */
const LOGIN_POLL_MS = 3000;

const STATE_NAMES: Record<RemoteState, MessageKey> = {
	off: "remote.stateOff",
	starting: "remote.stateStarting",
	connected: "remote.stateConnected",
	error: "remote.stateError",
};

const STATE_DOT: Record<RemoteState, string> = {
	off: "bg-faint",
	starting: "animate-pulse bg-warning",
	connected: "bg-success",
	error: "bg-danger",
};

/**
 * An option's explanation. In a narrow column the card's four long explanations stood one under another as a wall of
 * text: there each shows its first two lines and opens on request. Wider, it is shown whole.
 */
function OptionHint({ id, children }: { id?: string; children: ReactNode }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	return (
		<div className="mt-1.5 text-xs text-muted">
			<p id={id} className={cx(!open && "line-clamp-2 @min-[36rem]:line-clamp-none")}>
				{children}
			</p>
			<button
				type="button"
				aria-expanded={open}
				className="mt-0.5 text-accent underline-offset-2 hover:underline @min-[36rem]:hidden"
				onClick={() => setOpen((o) => !o)}
			>
				{open ? t("common.showLess") : t("common.showMore")}
			</button>
		</div>
	);
}

const field = "h-9 w-full rounded-xl border border-border bg-bg-soft px-3 text-sm outline-none focus:border-faint";

/** What the text fields hold while they are being edited; null until the first keystroke. */
interface Draft {
	hostname: string;
	team: string;
	aud: string;
	emails: string;
}

function draftOf(c: RemoteConfig): Draft {
	return { hostname: c.hostname, team: c.team, aud: c.aud, emails: c.emails.join("\n") };
}

/** The addresses of a textarea: one per line, and commas or spaces are taken for line breaks too. */
function emailsOf(text: string): string[] {
	return [...new Set(text.split(/[\s,;]+/).filter(Boolean))];
}

/** One text field with its name and the line under it that says what goes in it. */
function Field({
	label,
	hint,
	children,
}: {
	label: string;
	hint: string;
	children: (id: string, describedBy: string) => ReactNode;
}) {
	const id = useId();
	const hintId = `${id}-hint`;
	return (
		<div>
			<label htmlFor={id} className="mb-1 block text-sm">
				{label}
			</label>
			{children(id, hintId)}
			<p id={hintId} className="mt-1 text-xs text-muted">
				{hint}
			</p>
		</div>
	);
}

/** The address of the tunnel with a button that copies it. */
function CopyUrl({ url }: { url: string }) {
	const t = useT();
	const [done, setDone] = useState(false);
	return (
		<span className="inline-flex min-w-0 items-center gap-1">
			<code className="truncate font-mono text-sm" data-testid="remote-url">
				{url}
			</code>
			<button
				type="button"
				data-testid="remote-copy"
				aria-label={done ? t("remote.urlCopied") : t("remote.copyUrl")}
				title={t("remote.copyUrl")}
				className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg"
				onClick={() => {
					void navigator.clipboard?.writeText(url);
					setDone(true);
					setTimeout(() => setDone(false), 1200);
				}}
			>
				{done ? <Check size={14} /> : <Copy size={14} />}
			</button>
		</span>
	);
}

/** A step of the set-up: what it is, whether it is done, and the button that does it. */
function Step({
	n,
	done,
	title,
	children,
	testid,
}: {
	n: number;
	done: boolean;
	title: string;
	children?: ReactNode;
	testid: string;
}) {
	return (
		<li className="flex items-center gap-3 py-2" data-testid={testid} data-done={done}>
			<span
				aria-hidden
				className={cx(
					"flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-xs",
					done ? "border-transparent bg-success/15 text-success" : "border-border text-muted",
				)}
			>
				{done ? <Check size={13} /> : n}
			</span>
			<span className={cx("min-w-0 flex-1 text-sm", done && "text-muted")}>{title}</span>
			{children}
		</li>
	);
}

/**
 * Settings › Remote access: reach this app through a Cloudflare tunnel with Cloudflare Access in front. The card walks
 * through what has to be in place, in order (cloudflared, a Cloudflare login, the Access application made in the
 * dashboard, the tunnel itself), says what the tunnel is doing and offers its address. The server owns everything
 * (`server/remote-*.ts`); a page that came in through the tunnel is refused it, so it says that instead.
 */
export function RemoteSettings() {
	const t = useT();
	const toast = useApp((s) => s.toast);
	const remotePage = useApp((s) => s.meta?.remote === true);
	const { snapshot, loaded, loginUrl, busy, error, check } = useRemote();
	const [draft, setDraft] = useState<Draft | null>(null);
	/** The switches as they were left by the last click, until the server has them (the box follows the click at once). */
	const [chosen, setChosen] = useState<{
		autostart?: boolean;
		confirmRisky?: boolean;
		fileTransfer?: FileTransfer;
		remoteShell?: boolean;
	}>({});
	const transferId = useId();

	// Look again whenever the page opens: the tunnel may have changed, and a login made meanwhile is noticed.
	useEffect(() => {
		if (!remotePage) void remoteApi.load();
	}, [remotePage]);

	const signedIn = snapshot?.loggedIn === true;
	// While a sign-in is under way, ask again until the server sees the certificate.
	const waiting = loginUrl !== null && !signedIn;
	useEffect(() => {
		if (!waiting) return;
		const id = setInterval(() => void remoteApi.load(), LOGIN_POLL_MS);
		return () => clearInterval(id);
	}, [waiting]);
	useEffect(() => {
		if (signedIn && loginUrl !== null) useRemote.setState({ loginUrl: null });
	}, [signedIn, loginUrl]);

	if (remotePage) {
		return (
			<section className="rounded-2xl border border-border bg-surface p-4" data-testid="remote-settings">
				<CardHeader icon={<Globe size={16} />} title={t("remote.settingsTitle")} />
				<p className="text-sm text-muted" data-testid="remote-refused">
					{t("remote.settingsRemoteRefused")}
				</p>
			</section>
		);
	}
	if (!loaded) {
		return (
			<section className="rounded-2xl border border-border bg-surface p-4" data-testid="remote-settings">
				<CardHeader icon={<Globe size={16} />} title={t("remote.settingsTitle")} />
				<Spinner />
			</section>
		);
	}
	// A server without the routes: there is no card to show.
	if (!snapshot) return null;

	const { config, status, installed } = snapshot;
	const state = status.state;
	const form = draft ?? draftOf(config);
	const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(draftOf(config));
	const edit = (patch: Partial<Draft>) => setDraft({ ...form, ...patch });
	const url = webUrl(loginUrl);
	const running = state === "starting" || state === "connected";
	const ready = installed && signedIn && config.hostname !== "";

	const save = async () => {
		const done = await remoteApi.setConfig({
			hostname: form.hostname.trim(),
			team: form.team.trim(),
			aud: form.aud.trim(),
			emails: emailsOf(form.emails),
		});
		if (done) {
			setDraft(null);
			toast("success", t("remote.saveDone"));
		}
	};
	/**
	 * A switch: the box follows the click at once (the server is asked in the background), and goes back to what the
	 * server says when its answer says otherwise.
	 */
	const flip = async (patch: {
		autostart?: boolean;
		confirmRisky?: boolean;
		fileTransfer?: FileTransfer;
		remoteShell?: boolean;
	}) => {
		setChosen((c) => ({ ...c, ...patch }));
		await remoteApi.setConfig(patch);
		// The server's answer is the truth: the box reads what it kept, and goes back to it when the change was refused.
		setChosen((c) => {
			const next = { ...c };
			for (const key of Object.keys(patch) as (keyof typeof next)[]) delete next[key];
			return next;
		});
	};
	const login = async () => {
		const answer = await remoteApi.login();
		const target = webUrl(answer?.loginUrl);
		if (target) window.open(target, "_blank", "noopener,noreferrer");
	};

	return (
		<section className="rounded-2xl border border-border bg-surface p-4" data-testid="remote-settings">
			<CardHeader
				icon={<Globe size={16} />}
				title={t("remote.settingsTitle")}
				hint={t("remote.settingsIntro", { hostname: config.hostname || "omp.example.com" })}
			/>

			<div
				className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-border bg-bg-soft px-3 py-2"
				role="status"
				data-testid="remote-status"
				data-state={state}
			>
				<span className="inline-flex items-center gap-2 text-sm font-medium">
					<span aria-hidden className={cx("h-2 w-2 shrink-0 rounded-full", STATE_DOT[state])} />
					{t("remote.stateLabel", { state: t(STATE_NAMES[state]) })}
				</span>
				{snapshot.url ? (
					<CopyUrl url={snapshot.url} />
				) : (
					<span className="text-sm text-muted">{t("remote.urlEmpty")}</span>
				)}
				{status.message ? (
					<span
						className={cx("basis-full text-xs", state === "error" ? "text-danger" : "text-muted")}
						data-testid="remote-message"
					>
						{status.message}
					</span>
				) : null}
			</div>

			{error ? (
				<p className="mt-2 flex items-start gap-1.5 text-xs text-danger" role="alert" data-testid="remote-error">
					<CircleAlert size={14} className="mt-px shrink-0" />
					{t("remote.actionFailed", { error })}
				</p>
			) : null}

			<div className="mt-3 rounded-xl border border-border bg-bg-soft p-3" data-testid="remote-ai">
				<div className="flex items-center gap-3">
					<Sparkles size={15} className="shrink-0 text-accent" aria-hidden />
					<span className="min-w-0 flex-1 text-sm font-medium">{t("remote.aiSwitch")}</span>
					<Switch
						checked={snapshot.ai.enabled}
						onCheckedChange={(on) => void remoteApi.setAi(on)}
						label={t("remote.aiSwitch")}
						busy={busy === "ai"}
						data-testid="remote-ai-switch"
					/>
				</div>
				<OptionHint>{t("remote.aiHint")}</OptionHint>
				<div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5">
					<Button
						variant="primary"
						size="sm"
						data-testid="remote-ai-start"
						disabled={busy !== null}
						onClick={() => void setUpWithAi(snapshot)}
					>
						{busy === "ai" ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}{" "}
						{t("remote.aiButton")}
					</Button>
					{snapshot.ai.conversations.length > 0 ? (
						<span className="text-xs text-muted" data-testid="remote-ai-active">
							{snapshot.ai.conversations.length === 1
								? t("remote.aiActiveOne")
								: t("remote.aiActiveMany", { n: snapshot.ai.conversations.length })}
						</span>
					) : null}
				</div>
			</div>

			<div className="mt-3 rounded-xl border border-border bg-bg-soft p-3" data-testid="remote-confirm-risky">
				<div className="flex items-center gap-3">
					<ShieldQuestion size={15} className="shrink-0 text-accent" aria-hidden />
					<span className="min-w-0 flex-1 text-sm font-medium">{t("remote.confirmRisky")}</span>
					<Switch
						checked={chosen.confirmRisky ?? config.confirmRisky}
						onCheckedChange={(on) => void flip({ confirmRisky: on })}
						label={t("remote.confirmRisky")}
						busy={busy === "config" && chosen.confirmRisky !== undefined}
						data-testid="remote-confirm-risky-switch"
					/>
				</div>
				<OptionHint>{t("remote.confirmRiskyHint")}</OptionHint>
			</div>

			<div className="mt-3 rounded-xl border border-border bg-bg-soft p-3" data-testid="remote-file-transfer">
				{/* Wraps: at phone width the select leaves the title a few letters, so it drops under it. */}
				<div className="flex flex-wrap items-center gap-x-3 gap-y-2">
					<FolderSync size={15} className="shrink-0 text-accent" aria-hidden />
					<label htmlFor={transferId} className="min-w-0 flex-1 basis-32 text-sm font-medium">
						{t("remote.fileTransfer")}
					</label>
					<Select
						id={transferId}
						tone="compact"
						className="w-52 max-w-full shrink-0"
						value={chosen.fileTransfer ?? config.fileTransfer ?? DEFAULT_FILE_TRANSFER}
						disabled={busy === "config" && chosen.fileTransfer !== undefined}
						aria-describedby={`${transferId}-hint`}
						data-testid="remote-file-transfer-select"
						onValueChange={(v) => void flip({ fileTransfer: v as FileTransfer })}
					>
						<option value="off">{t("remote.fileTransferOff")}</option>
						<option value="download">{t("remote.fileTransferDownload")}</option>
						<option value="full">{t("remote.fileTransferFull")}</option>
					</Select>
				</div>
				<OptionHint id={`${transferId}-hint`}>{t("remote.fileTransferHint")}</OptionHint>
			</div>

			<div className="mt-3 rounded-xl border border-border bg-bg-soft p-3" data-testid="remote-shell">
				<div className="flex items-center gap-3">
					<SquareTerminal size={15} className="shrink-0 text-accent" aria-hidden />
					<span className="min-w-0 flex-1 text-sm font-medium">{t("remote.shell")}</span>
					<Switch
						checked={chosen.remoteShell ?? config.remoteShell}
						onCheckedChange={(on) => void flip({ remoteShell: on })}
						label={t("remote.shell")}
						busy={busy === "config" && chosen.remoteShell !== undefined}
						data-testid="remote-shell-switch"
					/>
				</div>
				<OptionHint>{t("remote.shellHint")}</OptionHint>
			</div>

			<ol className="mt-3 divide-y divide-border border-y border-border">
				<Step
					n={1}
					done={installed}
					title={installed ? t("remote.stepInstallDone") : t("remote.stepInstall")}
					testid="remote-step-install"
				>
					{installed ? null : (
						<Button
							size="sm"
							data-testid="remote-install"
							disabled={busy !== null}
							onClick={() => void remoteApi.install()}
						>
							{busy === "install" ? <Loader2 size={13} className="animate-spin" /> : null} {t("remote.stepInstall")}
						</Button>
					)}
				</Step>
				<Step
					n={2}
					done={signedIn}
					title={signedIn ? t("remote.stepLoginDone") : t("remote.stepLogin")}
					testid="remote-step-login"
				>
					{signedIn ? null : (
						<Button
							size="sm"
							data-testid="remote-login"
							disabled={!installed || busy !== null || waiting}
							onClick={() => void login()}
						>
							{busy === "login" || waiting ? <Loader2 size={13} className="animate-spin" /> : null}{" "}
							{t("remote.stepLogin")}
						</Button>
					)}
				</Step>
			</ol>
			{waiting ? (
				<p className="mt-2 flex flex-wrap items-center gap-x-2 text-xs text-muted" data-testid="remote-login-waiting">
					{t("remote.stepLoginWaiting")}
					{url ? (
						<a
							href={url}
							target="_blank"
							rel="noreferrer noopener"
							className="inline-flex items-center gap-1 text-accent underline"
							data-testid="remote-login-link"
						>
							{t("remote.loginLink")} <ExternalLink size={12} />
						</a>
					) : null}
				</p>
			) : null}

			<details
				className="group mt-3 rounded-xl border border-border"
				open={config.aud === ""}
				data-testid="remote-guide"
			>
				<summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-sm font-medium [&::-webkit-details-marker]:hidden">
					{t("remote.guideTitle")}
				</summary>
				<div className="border-t border-border px-3 py-2">
					<p className="text-xs text-muted">{t("remote.guideIntro")}</p>
					<ol className="mt-1.5 list-decimal space-y-1 pl-5 text-sm marker:text-muted">
						<li>{t("remote.guideApp")}</li>
						<li>{t("remote.guideHostname")}</li>
						<li>{t("remote.guidePolicy")}</li>
						<li>{t("remote.guideAud")}</li>
						<li>{t("remote.guideSession")}</li>
					</ol>
					<a
						href={DASHBOARD}
						target="_blank"
						rel="noreferrer noopener"
						className="mt-2 inline-flex items-center gap-1 text-sm text-accent underline"
					>
						{t("remote.guideLink")} <ExternalLink size={13} />
					</a>
				</div>
			</details>

			<form
				className="mt-3 space-y-3"
				onSubmit={(e) => {
					e.preventDefault();
					if (dirty && busy === null) void save();
				}}
			>
				<Field label={t("remote.hostname")} hint={t("remote.hostnameHint")}>
					{(id, hint) => (
						<input
							id={id}
							aria-describedby={hint}
							data-testid="remote-hostname"
							className={field}
							value={form.hostname}
							placeholder="omp.example.com"
							autoComplete="off"
							autoCapitalize="off"
							spellCheck={false}
							onChange={(e) => edit({ hostname: e.target.value })}
						/>
					)}
				</Field>
				<Field label={t("remote.team")} hint={t("remote.teamHint")}>
					{(id, hint) => (
						<input
							id={id}
							aria-describedby={hint}
							data-testid="remote-team"
							className={field}
							value={form.team}
							placeholder="your-team"
							autoComplete="off"
							autoCapitalize="off"
							spellCheck={false}
							onChange={(e) => edit({ team: e.target.value })}
						/>
					)}
				</Field>
				<Field label={t("remote.aud")} hint={t("remote.audHint")}>
					{(id, hint) => (
						<input
							id={id}
							aria-describedby={hint}
							data-testid="remote-aud"
							className={cx(field, "font-mono")}
							value={form.aud}
							autoComplete="off"
							autoCapitalize="off"
							spellCheck={false}
							onChange={(e) => edit({ aud: e.target.value })}
						/>
					)}
				</Field>
				<Field label={t("remote.emails")} hint={t("remote.emailsHint")}>
					{(id, hint) => (
						<textarea
							id={id}
							aria-describedby={hint}
							data-testid="remote-emails"
							className="min-h-20 w-full rounded-xl border border-border bg-bg-soft px-3 py-2 text-sm outline-none focus:border-faint"
							value={form.emails}
							rows={3}
							autoComplete="off"
							autoCapitalize="off"
							spellCheck={false}
							onChange={(e) => edit({ emails: e.target.value })}
						/>
					)}
				</Field>
				<div className="flex flex-wrap items-center gap-2">
					<Button type="submit" variant="primary" data-testid="remote-save" disabled={!dirty || busy !== null}>
						{busy === "config" ? <Loader2 size={13} className="animate-spin" /> : null} {t("common.save")}
					</Button>
					{dirty ? (
						<Button data-testid="remote-revert" disabled={busy !== null} onClick={() => setDraft(null)}>
							{t("common.cancel")}
						</Button>
					) : null}
				</div>
			</form>

			<RemoteTransfer
				saved={{ team: config.team, aud: config.aud, emails: config.emails }}
				// A setting a file leaves empty leaves what the card has: a file with only a team does not blank the tag.
				onImport={(s) =>
					edit({
						...(s.team ? { team: s.team } : {}),
						...(s.aud ? { aud: s.aud } : {}),
						...(s.emails.length > 0 ? { emails: s.emails.join("\n") } : {}),
					})
				}
				onExported={(name) => toast("success", t("remote.transferExported", { name }))}
			/>

			{/* Start (or Stop) is the tunnel's main action; setting it up is needed once, and checking the address is a
			 * test: they are quieter, and what they wait for is said rather than left as a row of dimmed buttons. */}
			<div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3">
				{running ? (
					<Button data-testid="remote-stop" disabled={busy !== null} onClick={() => void remoteApi.stop()}>
						{t("remote.stepStop")}
					</Button>
				) : (
					<Button
						variant="primary"
						data-testid="remote-start"
						disabled={dirty || busy !== null}
						onClick={() => void remoteApi.start()}
					>
						{busy === "start" ? <Loader2 size={13} className="animate-spin" /> : null} {t("remote.stepStart")}
					</Button>
				)}
				{running ? null : (
					<Button
						variant="ghost"
						data-testid="remote-setup"
						disabled={!ready || dirty || busy !== null}
						onClick={() => void remoteApi.setup()}
					>
						{busy === "setup" ? <Loader2 size={13} className="animate-spin" /> : null} {t("remote.stepSetup")}
					</Button>
				)}
				<Button
					variant="ghost"
					data-testid="remote-check"
					disabled={config.hostname === "" || busy !== null}
					onClick={() => void remoteApi.check()}
				>
					{busy === "check" ? <Loader2 size={13} className="animate-spin" /> : null} {t("remote.checkButton")}
				</Button>
			</div>
			{!running && !ready ? (
				<p className="mt-1.5 text-xs text-muted" data-testid="remote-setup-needs">
					{t("remote.setupNeeds")}
				</p>
			) : null}
			{check ? (
				<p
					className={cx(
						"mt-2 flex items-start gap-1.5 text-xs",
						check.verdict === "ok" ? "text-success" : "text-danger",
					)}
					role="status"
					data-testid="remote-check-result"
					data-verdict={check.verdict}
				>
					{check.verdict === "ok" ? (
						<Check size={14} className="mt-px shrink-0" />
					) : (
						<CircleAlert size={14} className="mt-px shrink-0" />
					)}
					{check.message}
				</p>
			) : null}

			<label className="mt-3 flex cursor-pointer items-start gap-3 text-sm">
				<input
					type="checkbox"
					className="mt-1 accent-[var(--accent)]"
					data-testid="remote-autostart"
					checked={chosen.autostart ?? config.autostart}
					disabled={busy !== null}
					onChange={(e) => void flip({ autostart: e.target.checked })}
				/>
				<span>{t("remote.autostart")}</span>
			</label>
		</section>
	);
}
