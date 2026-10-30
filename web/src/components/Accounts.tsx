import type { LiveInfo } from "@shared/protocol.ts";
import { ChevronRight, CircleCheck, ExternalLink, KeyRound, LogIn, LogOut, Plus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { webUrl } from "../lib/web-url.ts";
import { socket } from "../lib/ws.ts";
import { closeLive, openLive, useApp } from "../store/app.ts";
import { UIRequests } from "./UIRequests.tsx";
import { Badge, Button, CardHeader, cx, Modal, Spinner, WithCode } from "./ui.tsx";

interface Provider {
	id: string;
	name: string;
	available: boolean;
	authenticated: boolean;
}

interface Account {
	credentialId: number;
	provider: string;
	label?: string;
	detail?: string;
	type?: string;
	active?: boolean;
}

/** How a row and the logout confirmation name an account: its label (or type), plus its detail when it has one. */
function accountName(a: Account): string {
	const name = a.label ?? a.type ?? `#${a.credentialId}`;
	return a.detail ? `${name} (${a.detail})` : name;
}

/** How the Accounts section starts its omp: no conversation, in the home folder. */
const HELPER_ARGS = ["--no-session"];

/** Whether a process is the Accounts section's helper rather than a conversation (Settings names it so). */
export function isAccountsHelper(info: LiveInfo, home: string | undefined): boolean {
	return info.sessionFile === null && info.cwd === home && HELPER_ARGS.every((a) => info.args.includes(a));
}

/**
 * Provider logins through omp's RPC (`get_login_providers`, `login`,
 * `get_logout_accounts`, `logout`), using a session-less omp process.
 * Credentials are stored by omp exactly as `omp login` would. That process costs a full omp, so it starts only when
 * the list is asked for ("Show accounts") and stops when the list is hidden or Settings is left.
 */
export function Accounts({
	onSignedIn,
	openAtStart = false,
}: {
	onSignedIn?: (count: number) => void;
	/** Load the list at once (the setup wizard's sign-in step), rather than on "Show accounts" (Settings). */
	openAtStart?: boolean;
} = {}) {
	const t = useT();
	const { meta, toast } = useApp(useShallow((s) => ({ meta: s.meta, toast: s.toast })));
	// The server's answer about itself comes again, as a new object, after every reconnect: only the home matters here.
	const home = meta?.home;
	const [shown, setShown] = useState(openAtStart);
	const [liveId, setLiveId] = useState<string | null>(null);
	const [providers, setProviders] = useState<Provider[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loggingIn, setLoggingIn] = useState<string | null>(null);
	const [accounts, setAccounts] = useState<{ provider: string; list: Account[] } | null>(null);
	const [pendingLogout, setPendingLogout] = useState<Account | null>(null);
	const [loggingOut, setLoggingOut] = useState(false);
	// omp's RPC has no login cancel: cancelling stops this session-less process and starts a fresh one.
	const [generation, setGeneration] = useState(0);
	const cancelled = useRef(false);
	/** The other providers' list: open by default only while nothing is signed in; `null` follows that default. */
	const [othersOpen, setOthersOpen] = useState<boolean | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: `generation` restarts the process after a cancelled sign-in.
	useEffect(() => {
		if (!home || !shown) return;
		let started: string | null = null;
		let alive = true;
		setProviders(null);
		setError(null);
		openLive({ kind: "new", cwd: home, args: HELPER_ARGS })
			.then(async (id) => {
				started = id;
				if (!alive) return closeLive(id);
				setLiveId(id);
				const r = await socket.rpc<{ providers: Provider[] }>(id, { type: "get_login_providers" });
				if (alive) setProviders(r.providers);
			})
			.catch((e) => alive && setError(e.message));
		return () => {
			alive = false;
			if (started) closeLive(started);
			setLiveId(null);
			setAccounts(null);
		};
	}, [home, generation, shown]);

	const refresh = async () => {
		if (!liveId) return;
		const r = await socket.rpc<{ providers: Provider[] }>(liveId, { type: "get_login_providers" });
		setProviders(r.providers);
	};

	/** What was done worked (it is not reported as failed); only the list on screen could not be brought up to date. */
	const refreshAfter = () =>
		refresh().catch((e: Error) => toast("error", t("pages.accRefreshFailed", { error: e.message })));

	const login = (p: Provider) => {
		if (!liveId) return;
		cancelled.current = false;
		setLoggingIn(p.id);
		socket
			.rpc(liveId, { type: "login", providerId: p.id })
			.then(
				() => {
					toast("success", t("pages.accLoggedIn", { name: p.name }));
					return refreshAfter();
				},
				(e) =>
					cancelled.current
						? toast("info", t("pages.accSignInCancelled"))
						: toast("error", t("pages.accLoginFailed", { error: e.message })),
			)
			.finally(() => setLoggingIn(null));
	};

	const cancelLogin = () => {
		if (!liveId) return;
		cancelled.current = true;
		closeLive(liveId);
		setLiveId(null);
		setGeneration((g) => g + 1);
	};

	const toggleAccounts = async (p: Provider) => {
		if (!liveId) return;
		if (accounts?.provider === p.id) return setAccounts(null);
		try {
			const r = await socket.rpc<{ accounts: Account[] }>(liveId, { type: "get_logout_accounts", providerId: p.id });
			setAccounts({ provider: p.id, list: r.accounts });
		} catch (e) {
			toast("error", t("pages.accListFailed", { error: (e as Error).message }));
		}
	};

	const logout = async (a: Account) => {
		if (!liveId) return;
		try {
			const r = await socket.rpc<{ remainingSource?: string }>(liveId, {
				type: "logout",
				providerId: a.provider,
				credentialId: a.credentialId,
			});
			toast(
				"success",
				r?.remainingSource ? t("pages.accLoggedOutVia", { source: r.remainingSource }) : t("pages.accLoggedOut"),
			);
			setAccounts(null);
		} catch (e) {
			toast("error", t("pages.accLogoutFailed", { error: (e as Error).message }));
			return;
		}
		await refreshAfter();
	};

	const confirmLogout = async () => {
		if (!pendingLogout) return;
		setLoggingOut(true);
		try {
			await logout(pendingLogout);
		} finally {
			setLoggingOut(false);
			setPendingLogout(null);
		}
	};

	// What the confirmation names: the provider as listed above, and the account as its row names it.
	const logoutProvider = pendingLogout
		? (providers?.find((p) => p.id === pendingLogout.provider)?.name ?? pendingLogout.provider)
		: "";
	const logoutAccount = pendingLogout ? accountName(pendingLogout) : "";

	// Providers you are signed in to come first; the rest wait behind a disclosure.
	const signedIn = (providers ?? []).filter((p) => p.authenticated);
	const others = (providers ?? []).filter((p) => !p.authenticated);
	const showOthers = othersOpen ?? signedIn.length === 0;
	// The first-time setup waits for a sign-in: it is told how many providers there are once the list is known.
	const signedInCount = signedIn.length;
	useEffect(() => {
		if (providers) onSignedIn?.(signedInCount);
	}, [providers, signedInCount, onSignedIn]);

	const providerRow = (p: Provider) => {
		const accountsOpen = accounts?.provider === p.id;
		const cannotLogIn = !p.available || loggingIn !== null;
		return (
			<li key={p.id} className="py-2" data-testid="provider" data-provider={p.id}>
				{/* On a phone the signed-in row's three controls would squeeze the name to nothing: they wrap under it. */}
				<div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm">
					<span className="min-w-0 flex-1 basis-40 truncate">{p.name}</span>
					<div className="ml-auto flex flex-wrap items-center justify-end gap-2">
						{p.authenticated ? (
							<>
								<Badge tone="success" className="whitespace-nowrap">
									<CircleCheck size={11} /> {t("pages.accSignedIn")}
								</Badge>
								<Button
									size="sm"
									variant="ghost"
									aria-expanded={accountsOpen}
									aria-label={t("pages.accManageAria", { name: p.name })}
									onClick={() => void toggleAccounts(p)}
								>
									{t("pages.accManage")}
								</Button>
								<Button
									size="sm"
									disabled={cannotLogIn}
									aria-label={t("pages.accAddAccountAria", { name: p.name })}
									onClick={() => login(p)}
								>
									<Plus size={13} /> {t("pages.accAddAccount")}
								</Button>
							</>
						) : (
							<Button
								size="sm"
								disabled={cannotLogIn}
								aria-label={t("pages.accLogInTo", { name: p.name })}
								onClick={() => login(p)}
							>
								<LogIn size={13} /> {t("pages.accLogIn")}
							</Button>
						)}
					</div>
				</div>
				{accountsOpen && accounts ? (
					<div className="mt-2 rounded-lg bg-bg-soft p-2 text-xs" data-testid="provider-accounts">
						{accounts.list.length ? (
							accounts.list.map((a) => (
								<div key={a.credentialId} className="flex items-center gap-2 py-1">
									<span className="min-w-0 flex-1 truncate">
										{a.label ?? a.type} {a.detail ? <span className="text-muted">· {a.detail}</span> : null}
										{a.active ? <span className="text-success"> · {t("pages.accInUse")}</span> : null}
									</span>
									<Button
										size="sm"
										variant="ghost"
										aria-label={t("pages.accLogOutAria", { account: accountName(a) })}
										onClick={() => setPendingLogout(a)}
									>
										<LogOut size={12} /> {t("pages.accLogOut")}
									</Button>
								</div>
							))
						) : (
							<span className="text-muted">{t("pages.accNoAccounts")}</span>
						)}
					</div>
				) : null}
			</li>
		);
	};

	// Only the helper's own process: a frame of any other conversation is none of this list's business.
	const live = useApp((s) => (liveId ? s.lives[liveId] : undefined));
	const pendingUrl = live?.loginUrl;
	// What omp (or an extension) names as the sign-in page is a link only if it is a web address: `javascript:` would run here.
	const loginHref = webUrl(pendingUrl?.launchUrl) ?? webUrl(pendingUrl?.url);
	// The helper was closed from outside (Settings › Running sessions) or died: fold the list; "Show accounts" starts a new one.
	const helperGone = live?.info.exited === true;
	useEffect(() => {
		if (helperGone) setShown(false);
	}, [helperGone]);
	return (
		<section className="rounded-2xl border border-border bg-surface p-4" data-testid="accounts">
			<CardHeader
				icon={<KeyRound size={16} />}
				title={t("pages.accTitle")}
				hint={<WithCode text={t("pages.accIntro")} />}
			/>
			<Button
				size="sm"
				className="mb-3"
				data-testid="accounts-toggle"
				aria-expanded={shown}
				aria-controls="accounts-body"
				disabled={loggingIn !== null}
				onClick={() => setShown(!shown)}
			>
				<ChevronRight size={13} className={cx("transition-transform", shown && "rotate-90")} />{" "}
				{t(shown ? "pages.accHide" : "pages.accShow")}
			</Button>
			{shown ? null : <p className="text-xs text-muted">{t("pages.accLazyHint")}</p>}
			<div id="accounts-body">
				{error ? <div className="text-sm text-danger">{error}</div> : null}
				{!providers && !error && shown ? <Spinner /> : null}
				{loggingIn && live ? (
					<div
						className="mb-3 rounded-xl border border-accent/40 bg-accent-soft p-3 text-sm"
						data-testid="login-progress"
					>
						<div className="mb-1 font-medium">
							{t("pages.accSigningIn", { name: providers?.find((p) => p.id === loggingIn)?.name ?? "" })}
						</div>
						{pendingUrl ? (
							<>
								{loginHref ? (
									<a
										href={loginHref}
										target="_blank"
										rel="noreferrer noopener"
										className="inline-flex items-center gap-1 text-accent underline"
										data-testid="login-link"
									>
										{t("pages.accOpenPage")} <ExternalLink size={13} />
									</a>
								) : (
									<p className="text-xs text-muted" data-testid="login-link-refused">
										{t("pages.accNotAWebAddress")}
									</p>
								)}
								{pendingUrl.instructions ? <p className="mt-1 text-xs text-muted">{pendingUrl.instructions}</p> : null}
							</>
						) : (
							<Spinner size={14} />
						)}
						<div className="mt-3">
							<UIRequests live={live} />
						</div>
						<div className="mt-2 flex justify-end">
							<Button size="sm" variant="ghost" onClick={cancelLogin} data-testid="cancel-login">
								{t("pages.accCancelSignIn")}
							</Button>
						</div>
					</div>
				) : null}
				{signedIn.length ? <ul className="divide-y divide-border">{signedIn.map(providerRow)}</ul> : null}
				{others.length ? (
					<div className={cx(signedIn.length > 0 && "mt-3 border-t border-border pt-2")}>
						<button
							type="button"
							data-testid="other-providers"
							aria-expanded={showOthers}
							aria-controls="accounts-other-providers"
							onClick={() => setOthersOpen(!showOthers)}
							className="flex w-full items-center gap-1.5 rounded-lg px-1 py-1.5 text-left text-xs font-medium text-muted hover:bg-hover hover:text-fg"
						>
							<ChevronRight size={14} className={cx("transition-transform", showOthers && "rotate-90")} />
							{t(signedIn.length ? "pages.accOtherProviders" : "pages.accProviders", { n: others.length })}
						</button>
						<ul id="accounts-other-providers" className="divide-y divide-border" hidden={!showOthers}>
							{others.map(providerRow)}
						</ul>
					</div>
				) : null}
			</div>
			<Modal
				open={pendingLogout !== null}
				onOpenChange={(o) => !o && !loggingOut && setPendingLogout(null)}
				title={t("pages.accLogoutTitle", { name: logoutProvider })}
				description={t("pages.accLogoutDescription", { account: logoutAccount })}
			>
				<div className="flex justify-end gap-2">
					<Button variant="ghost" disabled={loggingOut} onClick={() => setPendingLogout(null)}>
						{t("common.cancel")}
					</Button>
					<Button
						variant="danger"
						data-testid="confirm-logout"
						disabled={loggingOut}
						onClick={() => void confirmLogout()}
					>
						{loggingOut ? <Spinner size={14} /> : <LogOut size={13} />} {t("pages.accLogOut")}
					</Button>
				</div>
			</Modal>
		</section>
	);
}
