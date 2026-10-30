import {
	type ExportRequest,
	type ExportStatus,
	type ImportMode,
	type ImportNoteCode,
	type ImportPreview,
	type ImportRequest,
	type ImportStatus,
	type ImportSummary,
	type ImportWarningCode,
	isMigrateCategory,
	isMigrateDataCategory,
	MIGRATE_API,
	MIGRATE_DATA_CATEGORIES,
	MIGRATE_MIN_PASSWORD,
	type MigrateCategoryId,
	type MigrateDataCategoryId,
	type MigrateLeftOut,
	type MigrateLeftOutReason,
	type MigratePhase,
	type MigratePlan,
	type MigrateProgress,
} from "@shared/migrate.ts";
import { ArrowRightLeft, Check, CircleAlert, Copy, Download, Loader2, RefreshCw, Upload } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useReducer, useRef, useState } from "react";
import { addStrings, type MessageKey, useLang, useT, type Vars } from "../i18n/index.ts";
import { en } from "../i18n/migrate.ts";
import { codedText } from "../lib/error-text.ts";
import { formatBytes, isNetworkError, migrateApi } from "../lib/migrate-api.ts";
import { useApp } from "../store/app.ts";
import { GenerateButton, MadePassword, PasswordField } from "./MigratePassword.tsx";
import { Switch } from "./Switch.tsx";
import { Button, CardHeader, cx, Spinner } from "./ui.tsx";

// This chunk is loaded on its own (SettingsPage): the English strings go in with it, the Chinese ones when they are needed.
addStrings("en", "migrate", en);

/** How often the card asks the server how an export or an import is going. */
const POLL_MS = 500;

/** Whether the Chinese strings of the card are in the dictionary (they are fetched once, the first time they are read). */
let zhAdded = false;

/**
 * True once the card's strings exist in the page's language. English is there as the chunk loads; Chinese is a chunk of
 * its own that only a person reading Chinese downloads. The card shows nothing until then rather than English for a moment.
 */
function useStringsReady(): boolean {
	const lang = useLang((s) => s.lang);
	const [, redraw] = useReducer((n: number) => n + 1, 0);
	useEffect(() => {
		if (lang === "en" || zhAdded) return;
		let live = true;
		// The pack is picked at run time by the interface language, so it cannot be a static import.
		void import("../i18n/zh-CN/migrate.ts")
			.then((m) => addStrings(lang, "migrate", m.zh))
			// A pack that does not arrive leaves English under the Chinese: better than a card that never shows.
			.catch(() => {})
			.finally(() => {
				zhAdded = true;
				if (live) redraw();
			});
		return () => {
			live = false;
		};
	}, [lang]);
	return lang === "en" || zhAdded;
}

const CATEGORY_NAMES: Record<MigrateCategoryId, MessageKey> = {
	conversations: "migrate.catConversations",
	history: "migrate.catHistory",
	memories: "migrate.catMemories",
	settings: "migrate.catSettings",
	customization: "migrate.catCustomization",
	plugins: "migrate.catPlugins",
	webui: "migrate.catWebui",
	credentials: "migrate.catCredentials",
};

/** The names of some categories as one phrase in the page's language ("Conversations and Memories"). */
function useCategoryList(): (ids: readonly MigrateCategoryId[]) => string {
	const t = useT();
	const lang = useLang((s) => s.lang);
	return (ids) => new Intl.ListFormat(lang, { type: "conjunction" }).format(ids.map((id) => t(CATEGORY_NAMES[id])));
}

const REASONS: Record<MigrateLeftOutReason, MessageKey> = {
	cache: "migrate.reasonCache",
	rebuilt: "migrate.reasonRebuilt",
	machine: "migrate.reasonMachine",
	runtime: "migrate.reasonRuntime",
	redownload: "migrate.reasonRedownload",
	secret: "migrate.reasonSecret",
	unknown: "migrate.reasonUnknown",
};

const PHASES: Record<MigratePhase, MessageKey> = {
	scan: "migrate.phaseScan",
	copy: "migrate.phaseCopy",
	verify: "migrate.phaseVerify",
	backup: "migrate.phaseBackup",
	write: "migrate.phaseWrite",
	finish: "migrate.phaseFinish",
};

const WARNINGS: Record<ImportWarningCode, MessageKey> = {
	ompNewer: "migrate.warnOmpNewer",
	webuiNewer: "migrate.warnWebuiNewer",
	homeDiffers: "migrate.warnHomeDiffers",
	skipped: "migrate.warnSkipped",
	diskLow: "migrate.warnDiskLow",
};

const NOTES: Record<ImportNoteCode, MessageKey> = {
	credentialsOmpOlder: "migrate.noteCredentialsOmpOlder",
	credentialsFailed: "migrate.noteCredentialsFailed",
	secretsBlanked: "migrate.noteSecretsBlanked",
	remoteOff: "migrate.noteRemoteOff",
	remoteKept: "migrate.noteRemoteKept",
	sessionDirMoved: "migrate.noteSessionDirMoved",
	banksRenamed: "migrate.noteBanksRenamed",
	banksKept: "migrate.noteBanksKept",
	liveEnded: "migrate.noteLiveEnded",
	openElsewhere: "migrate.noteOpenElsewhere",
	linksRecreated: "migrate.noteLinksRecreated",
	fileFailed: "migrate.noteFileFailed",
};

/** Why the logins of a finished import were not restored. */
const CREDENTIAL_REASONS: Record<string, MessageKey> = {
	notAsked: "migrate.credsNotAsked",
	"omp-older": "migrate.credsOmpOlder",
	absent: "migrate.credsAbsent",
};

/** The longest list of left-out items drawn: the server lists every one, and a list of thousands is of no use to read. */
const LEFT_OUT_SHOWN = 500;

/** A button that is a link (the download): the look of `Button`, which cannot be one. */
const linkButton =
	"inline-flex h-9 items-center justify-center gap-1.5 rounded-lg bg-accent px-3.5 text-sm font-medium text-accent-fg transition-colors hover:brightness-110";

/** What went wrong, as the card keeps it until it is worded: the language may change in between. */
interface Problem {
	message: string;
	code?: string;
	params?: Record<string, string | number>;
	network?: boolean;
}

function problemOf(e: unknown): Problem {
	if (isNetworkError(e)) return { message: "", network: true };
	const { message, code, params } = e as Error & { code?: string; params?: Record<string, string | number> };
	return { message: e instanceof Error ? message : String(e), code, params };
}

function useProblemText(): (p: Problem) => string {
	const t = useT();
	return (p) => (p.network ? t("migrate.networkError") : codedText(p.code, p.params, p.message));
}

/** The text of a word in `Vars` that was not found: the code itself, as the brief says. */
function codeText(
	map: Partial<Record<string, MessageKey>>,
	code: string,
	t: (k: MessageKey, v?: Vars) => string,
	vars?: Vars,
) {
	const key = map[code];
	return key ? t(key, vars) : code;
}

/** A region that scrolls: reachable from the keyboard, or its content cannot be read without a mouse. */
function ScrollBox({ label, className, children }: { label: string; className?: string; children: ReactNode }) {
	return (
		<section
			// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable by keyboard to be read (axe: scrollable-region-focusable).
			tabIndex={0}
			aria-label={label}
			className={cx("overflow-auto", className)}
		>
			{children}
		</section>
	);
}

function Path({ children }: { children: ReactNode }) {
	return <span className="break-all font-mono text-xs">{children}</span>;
}

function Alert({ children, testid }: { children: ReactNode; testid?: string }) {
	return (
		<p className="mt-2 flex items-start gap-1.5 text-xs text-danger" role="alert" data-testid={testid}>
			<CircleAlert size={14} className="mt-px shrink-0" />
			<span className="min-w-0 break-words">{children}</span>
		</p>
	);
}

function Warning({ children, testid }: { children: ReactNode; testid?: string }) {
	return (
		<p className="flex items-start gap-1.5 text-xs text-warning" data-testid={testid}>
			<CircleAlert size={14} className="mt-px shrink-0" />
			<span className="min-w-0 break-words">{children}</span>
		</p>
	);
}

/** Bar and words for a piece of work in progress; no total yet means a bar that only says it is alive. */
function ProgressView({
	label,
	phase,
	done,
	total,
	files,
	current,
}: {
	label: string;
	phase: string;
	done: number;
	total: number;
	files?: { done: number; total: number };
	current?: string;
}) {
	const t = useT();
	const percent = total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : null;
	return (
		<div data-testid="migrate-progress">
			<div
				role="progressbar"
				aria-label={label}
				aria-valuemin={0}
				aria-valuemax={100}
				aria-valuenow={percent ?? undefined}
				className="h-2 overflow-hidden rounded-full bg-hover"
			>
				<div
					className={cx("h-full rounded-full bg-accent", percent === null && "w-1/3 animate-pulse")}
					style={percent === null ? undefined : { width: `${percent}%` }}
				/>
			</div>
			<p aria-live="polite" className="mt-1.5 text-xs text-muted" data-testid="migrate-progress-text">
				{percent === null ? phase : t("migrate.progressPercent", { phase, percent })}
			</p>
			{total > 0 ? (
				<p className="text-xs text-muted">
					{t("migrate.progressBytes", { done: formatBytes(done), total: formatBytes(total) })}
					{files && files.total > 0 ? ` · ${t("migrate.progressFiles", { done: files.done, total: files.total })}` : ""}
				</p>
			) : null}
			{current ? (
				<p className="truncate font-mono text-xs text-muted" title={current}>
					{current}
				</p>
			) : null}
		</div>
	);
}

function ServerProgress({ label, progress }: { label: string; progress: MigrateProgress }) {
	const t = useT();
	return (
		<ProgressView
			label={label}
			phase={t(PHASES[progress.phase] ?? "migrate.phaseFinish")}
			done={progress.doneBytes}
			total={progress.totalBytes}
			files={{ done: progress.doneFiles, total: progress.totalFiles }}
			current={progress.current}
		/>
	);
}

interface Row {
	id: MigrateCategoryId;
	files: number;
	bytes: number;
	added?: number;
	same?: number;
	differs?: number;
}

/** What makes the table of an export a choice: which data categories are ticked, and what the logins row says. */
interface Pick {
	checked: ReadonlySet<MigrateDataCategoryId>;
	/** The logins are on (their own switch, under the table). */
	credentials: boolean;
	disabled: boolean;
	onToggle: (id: MigrateDataCategoryId, on: boolean) => void;
}

/** What is in the archive by category; with the comparison to this Mac's files when the archive is being imported. */
function CategoryTable({ rows, compared, pick }: { rows: Row[]; compared?: boolean; pick?: Pick }) {
	const t = useT();
	const categoryName = (id: MigrateCategoryId) => (isMigrateCategory(id) ? t(CATEGORY_NAMES[id]) : id);
	// A size is one value: "20.6 KB" broke after its number in a narrow table. The box scrolls sideways instead.
	const num = "px-2 py-1 text-right tabular-nums whitespace-nowrap";
	const head = "px-2 py-1 text-right font-medium";
	return (
		<ScrollBox label={t("migrate.tableLabel")} className="rounded-xl border border-border">
			<table className="w-full text-sm" data-testid="migrate-categories">
				<thead className="text-xs text-muted">
					<tr className="border-b border-border">
						<th scope="col" className="px-2 py-1 text-left font-medium">
							{t("migrate.tableCategory")}
						</th>
						<th scope="col" className={head}>
							{t("migrate.tableFiles")}
						</th>
						<th scope="col" className={head}>
							{t("migrate.tableSize")}
						</th>
						{compared ? (
							<>
								<th scope="col" className={head}>
									{t("migrate.tableNew")}
								</th>
								<th scope="col" className={head}>
									{t("migrate.tableSame")}
								</th>
								<th scope="col" className={head}>
									{t("migrate.tableDiffers")}
								</th>
							</>
						) : null}
					</tr>
				</thead>
				<tbody>
					{rows.map((r) => (
						<tr key={r.id} className="border-b border-border last:border-b-0" data-testid={`migrate-cat-${r.id}`}>
							<th scope="row" className="px-2 py-1 text-left font-normal">
								{pick && isMigrateDataCategory(r.id) ? (
									<label className="flex cursor-pointer items-center gap-2">
										<input
											type="checkbox"
											className="accent-[var(--accent)]"
											data-testid={`migrate-pick-${r.id}`}
											checked={pick.checked.has(r.id)}
											disabled={pick.disabled}
											onChange={(e) => pick.onToggle(r.id as MigrateDataCategoryId, e.target.checked)}
										/>
										{categoryName(r.id)}
									</label>
								) : pick ? (
									// The logins have a switch of their own below the table (a password goes with them): the row says where it stands.
									<span className="block pl-6">
										{categoryName(r.id)}
										<span className="block text-xs text-muted" data-testid={`migrate-pick-${r.id}`}>
											{t(pick.credentials ? "migrate.pickLoginsOn" : "migrate.pickLoginsOff")}
										</span>
									</span>
								) : (
									categoryName(r.id)
								)}
							</th>
							<td className={num}>{r.files}</td>
							<td className={num}>{formatBytes(r.bytes)}</td>
							{compared ? (
								<>
									<td className={num}>{r.added ?? 0}</td>
									<td className={num}>{r.same ?? 0}</td>
									<td className={num}>{r.differs ?? 0}</td>
								</>
							) : null}
						</tr>
					))}
				</tbody>
			</table>
		</ScrollBox>
	);
}

/** What is left out, closed until asked for, each with its reason in a few words and its size. */
function LeftOutList({ items }: { items: MigrateLeftOut[] }) {
	const t = useT();
	if (items.length === 0) return null;
	return (
		<details className="mt-3 rounded-xl border border-border" data-testid="migrate-left-out">
			<summary className="cursor-pointer list-none px-3 py-2 text-sm font-medium [&::-webkit-details-marker]:hidden">
				{t("migrate.leftOutTitle", { count: items.length })}
			</summary>
			<ScrollBox label={t("migrate.leftOutList")} className="max-h-56 border-t border-border px-3 py-2">
				<ul className="space-y-1.5">
					{items.slice(0, LEFT_OUT_SHOWN).map((item) => (
						<li key={item.path} className="text-sm" data-testid="migrate-left-out-item">
							<Path>{item.path}</Path>
							<span className="block text-xs text-muted">
								{codeText(REASONS, item.reason, t)} · {formatBytes(item.bytes)}
							</span>
						</li>
					))}
				</ul>
				{items.length > LEFT_OUT_SHOWN ? (
					<p className="mt-1.5 text-xs text-muted">
						{t("migrate.summaryMore", { count: items.length - LEFT_OUT_SHOWN })}
					</p>
				) : null}
			</ScrollBox>
		</details>
	);
}

/** What an export is made of (logins, encrypting the whole file, the password) and the button that starts it. Its passwords live only while it is on the page. */
function ExportForm({
	plan,
	credentials,
	onCredentials,
	picked,
	blocked,
	starting,
	onStart,
}: {
	plan: MigratePlan;
	credentials: boolean;
	onCredentials: (on: boolean) => void;
	picked: ReadonlySet<MigrateDataCategoryId>;
	blocked: boolean;
	starting: boolean;
	onStart: (req: ExportRequest) => void;
}) {
	const t = useT();
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	// Encrypting the whole file follows the logins (a password is being set anyway, and the same one covers everything)
	// until the person decides for themselves.
	const [whole, setWhole] = useState(false);
	const decided = useRef(false);
	// A password made here, or a passphrase taken from the hint, is shown in clear: it has to be saved by the person.
	const [made, setMade] = useState(false);
	const needsPassword = credentials || whole;
	const short = password.length > 0 && password.length < MIGRATE_MIN_PASSWORD;
	const mismatch = confirm.length > 0 && confirm !== password;
	const valid = !needsPassword || (password.length >= MIGRATE_MIN_PASSWORD && confirm === password);
	// The secret values of a category that is not ticked are not in the file either: only those of what goes in are told.
	const secretFiles = plan.secretFiles.filter((f) => isMigrateDataCategory(f.category) && picked.has(f.category));
	const secretValues = secretFiles.reduce((n, f) => n + f.values, 0);
	// Nothing ticked and no logins: there is nothing to put in the file.
	const nothing = picked.size === 0 && !credentials;
	const fill = (chosen: string) => {
		setPassword(chosen);
		setConfirm(chosen);
		setMade(true);
	};
	return (
		<form
			className="mt-3 space-y-3"
			noValidate
			onSubmit={(e) => {
				e.preventDefault();
				if (valid && !nothing && !blocked && !starting) {
					const categories = MIGRATE_DATA_CATEGORIES.filter((id) => picked.has(id));
					onStart(
						needsPassword
							? { credentials, wholeFile: whole, password, categories }
							: { credentials, wholeFile: false, categories },
					);
				}
			}}
		>
			<div className="flex items-start gap-3">
				<Switch
					checked={credentials}
					onCheckedChange={(on) => {
						onCredentials(on);
						if (!decided.current) setWhole(on);
					}}
					label={t("migrate.credSwitch")}
					data-testid="migrate-creds"
				/>
				<div className="min-w-0">
					<p className="text-sm">{t("migrate.credSwitch")}</p>
					<p className="text-xs text-muted">{t("migrate.credHint")}</p>
				</div>
			</div>
			<div className="flex items-start gap-3">
				<Switch
					checked={whole}
					onCheckedChange={(on) => {
						decided.current = true;
						setWhole(on);
					}}
					label={t("migrate.wholeSwitch")}
					data-testid="migrate-whole"
				/>
				<div className="min-w-0">
					<p className="text-sm">{t("migrate.wholeSwitch")}</p>
					<p className="text-xs text-muted">{t("migrate.wholeHint")}</p>
				</div>
			</div>
			{needsPassword ? (
				<div className="space-y-3" data-testid="migrate-creds-fields">
					<PasswordField
						label={t("migrate.password")}
						value={password}
						onChange={(v) => {
							setMade(false);
							setPassword(v);
						}}
						problem={short ? t("migrate.passwordShort", { min: MIGRATE_MIN_PASSWORD }) : null}
						testid="migrate-password"
						autoComplete="new-password"
						reveal={made}
						strength={{ onUse: fill }}
					/>
					<GenerateButton onMade={fill} />
					{made ? <MadePassword password={password} /> : null}
					<PasswordField
						label={t("migrate.passwordConfirm")}
						value={confirm}
						onChange={setConfirm}
						problem={mismatch ? t("migrate.passwordMismatch") : null}
						testid="migrate-password-confirm"
						autoComplete="new-password"
					/>
					{credentials && secretFiles.length > 0 ? (
						<div className="text-xs text-muted" data-testid="migrate-secret-files">
							<p>{t("migrate.secretFilesOn")}</p>
							<ul className="mt-1 space-y-0.5">
								{secretFiles.map((f) => (
									<li key={f.path}>
										<Path>{f.path}</Path> · {t("migrate.secretValues", { count: f.values })}
									</li>
								))}
							</ul>
						</div>
					) : null}
				</div>
			) : null}
			{!credentials && secretFiles.length > 0 ? (
				<p className="text-xs text-muted" data-testid="migrate-secrets-blank">
					{t("migrate.secretFilesOff", { count: secretValues, files: secretFiles.map((f) => f.path).join(", ") })}
				</p>
			) : null}
			{nothing ? (
				<p className="text-xs text-warning" role="status" data-testid="migrate-pick-nothing">
					{t("migrate.pickNothing")}
				</p>
			) : null}
			<Button
				type="submit"
				variant="primary"
				data-testid="migrate-export"
				disabled={!valid || nothing || blocked || starting}
			>
				{starting ? <Loader2 size={13} className="animate-spin" /> : <Download size={14} />} {t("migrate.exportButton")}
			</Button>
		</form>
	);
}

/** What the export would hold, from the server's plan: the ticked categories, and their total. */
function PlanView({ plan, credentials, pick }: { plan: MigratePlan; credentials: boolean; pick: Pick }) {
	const t = useT();
	const ticked = plan.categories.filter((c) => isMigrateDataCategory(c.id) && pick.checked.has(c.id));
	return (
		<div data-testid="migrate-plan">
			<p className="mb-2 text-xs text-muted" data-testid="migrate-pick-hint">
				{t("migrate.pickHint")}
			</p>
			<CategoryTable rows={plan.categories} pick={pick} />
			<p className="mt-2 text-sm" data-testid="migrate-plan-totals">
				{t("migrate.planTotals", {
					files: ticked.reduce((n, c) => n + c.files, 0),
					size: formatBytes(ticked.reduce((n, c) => n + c.bytes, 0)),
				})}
			</p>
			{plan.profiles.length > 0 ? (
				<p className="mt-1 text-xs text-muted" data-testid="migrate-profiles">
					{t("migrate.planProfiles", { names: plan.profiles.join(", ") })}
				</p>
			) : null}
			{plan.sessionDirs.length > 0 && pick.checked.has("conversations") ? (
				<p className="mt-1 text-xs text-muted" data-testid="migrate-session-dirs">
					{t("migrate.planSessionDirs", { paths: plan.sessionDirs.join(", ") })}
				</p>
			) : null}
			{/* With the logins in the archive their files are no longer left out. */}
			<LeftOutList items={credentials ? plan.leftOut.filter((item) => item.reason !== "secret") : plan.leftOut} />
		</div>
	);
}

/** The plan and the form under it: what is ticked and the logins switch decide what the plan says goes in and what is left out. */
function ExportPanel({
	plan,
	blocked,
	starting,
	onStart,
}: {
	plan: MigratePlan;
	blocked: boolean;
	starting: boolean;
	onStart: (req: ExportRequest) => void;
}) {
	const [credentials, setCredentials] = useState(false);
	// Every kind of data is ticked to begin with; the logins are not.
	const [picked, setPicked] = useState<ReadonlySet<MigrateDataCategoryId>>(() => new Set(MIGRATE_DATA_CATEGORIES));
	const toggle = (id: MigrateDataCategoryId, on: boolean) =>
		setPicked((was) => {
			const next = new Set(was);
			if (on) next.add(id);
			else next.delete(id);
			return next;
		});
	return (
		<>
			<PlanView
				plan={plan}
				credentials={credentials}
				pick={{ checked: picked, credentials, disabled: starting, onToggle: toggle }}
			/>
			<ExportForm
				plan={plan}
				credentials={credentials}
				onCredentials={setCredentials}
				picked={picked}
				blocked={blocked}
				starting={starting}
				onStart={onStart}
			/>
		</>
	);
}

/** The result of an export: where the archive is, and the button that saves it. */
function ExportDone({ ex, onDone }: { ex: ExportStatus; onDone: () => void }) {
	const t = useT();
	const listOf = useCategoryList();
	const file = ex.file;
	return (
		<div className="mt-3 space-y-2" data-testid="migrate-export-done">
			{file ? (
				<p className="flex items-center gap-1.5 text-sm" role="status">
					<Check size={14} className="shrink-0 text-success" />
					<span className="min-w-0 break-words">
						{t("migrate.exportDone", { name: file.name, size: formatBytes(file.bytes) })}
					</span>
				</p>
			) : null}
			<p className="text-xs text-muted" data-testid="migrate-export-holds">
				{t("migrate.exportDoneHolds", { names: listOf(ex.categories) })}
			</p>
			<SkippedList files={ex.skipped} />
			<p className="text-xs text-muted">{t("migrate.exportDoneHint")}</p>
			{ex.wholeFile ? (
				<p className="text-xs text-muted" data-testid="migrate-export-encrypted">
					{t("migrate.exportDoneEncrypted")}
				</p>
			) : null}
			<div className="flex flex-wrap items-center gap-2">
				{file ? (
					// A plain navigation, not fetch and a blob: the archive can be many gigabytes, and the macOS shell saves it
					// through its own download sheet.
					<a href={MIGRATE_API.exportFile} download={file.name} className={linkButton} data-testid="migrate-download">
						<Download size={14} /> {t("migrate.download")}
					</a>
				) : null}
				<Button data-testid="migrate-export-finish" onClick={onDone}>
					{t("migrate.done")}
				</Button>
			</div>
		</div>
	);
}

/** Files that could not be read, as a warning with the list under it. */
function SkippedList({ files }: { files: { path: string; error: string }[] }) {
	const t = useT();
	if (files.length === 0) return null;
	return (
		<details className="rounded-xl border border-warning/40" data-testid="migrate-skipped">
			<summary className="cursor-pointer list-none px-3 py-2 text-xs text-warning [&::-webkit-details-marker]:hidden">
				{t("migrate.skippedTitle", { count: files.length })}
			</summary>
			<ScrollBox label={t("migrate.skippedFiles")} className="max-h-40 border-t border-border px-3 py-2">
				<ul className="space-y-1">
					{files.map((f) => (
						<li key={f.path} className="text-xs">
							<Path>{f.path}</Path>
							<span className="block break-words text-muted">{f.error}</span>
						</li>
					))}
				</ul>
			</ScrollBox>
		</details>
	);
}

function Source({ preview }: { preview: ImportPreview }) {
	const t = useT();
	const lang = useLang((s) => s.lang);
	const { source } = preview;
	const made = new Date(source.createdAt);
	const when = Number.isNaN(made.getTime())
		? source.createdAt
		: new Intl.DateTimeFormat(lang, { dateStyle: "medium", timeStyle: "short" }).format(made);
	const rows: [string, ReactNode][] = [
		[t("migrate.sourceHost"), source.host],
		[t("migrate.sourceUser"), source.user],
		[t("migrate.sourceHome"), <Path key="home">{source.home}</Path>],
		[t("migrate.sourceOmp"), source.ompVersion],
		[t("migrate.sourceWebui"), source.serverVersion],
		[t("migrate.sourceCreated"), when],
	];
	return (
		<div data-testid="migrate-source">
			<h3 className="mb-1 text-sm font-medium">{t("migrate.sourceTitle")}</h3>
			<dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-0.5 text-sm">
				{rows.map(([name, value]) => (
					<div key={name} className="contents">
						<dt className="text-muted">{name}</dt>
						<dd className="min-w-0 break-words">{value}</dd>
					</div>
				))}
			</dl>
		</div>
	);
}

/** The archive, checked: what it holds against this Mac, and the choices that go with importing it. */
function ImportReady({
	preview,
	busy,
	problem,
	onApply,
	onDiscard,
}: {
	preview: ImportPreview;
	busy: boolean;
	problem: Problem | null;
	onApply: (req: ImportRequest) => void;
	onDiscard: () => void;
}) {
	const t = useT();
	const listOf = useCategoryList();
	const problemText = useProblemText();
	const [mode, setMode] = useState<ImportMode>("merge");
	const [restore, setRestore] = useState(true);
	const [password, setPassword] = useState("");
	const credentials = preview.credentials && restore;
	// Opened with the file's password already: its logins are in the same encryption and need no second one.
	const whole = preview.encryption === "whole";
	const ready = !credentials || whole || password.length > 0;
	const defaults: Record<ImportWarningCode, Vars> = {
		ompNewer: { version: preview.source.ompVersion },
		webuiNewer: { version: preview.source.serverVersion },
		homeDiffers: { from: preview.source.home, to: preview.home },
		skipped: { count: preview.skipped.length },
		diskLow: { need: 0, free: 0 },
	};
	const { conversations } = preview;
	return (
		<form
			className="mt-3 space-y-4"
			noValidate
			data-testid="migrate-preview"
			onSubmit={(e) => {
				e.preventDefault();
				if (ready && !busy) {
					onApply(
						credentials
							? whole
								? { mode, credentials }
								: { mode, credentials, password }
							: { mode, credentials: false },
					);
				}
			}}
		>
			<Source preview={preview} />
			{preview.warnings.length > 0 ? (
				<div className="space-y-1.5" data-testid="migrate-warnings">
					{preview.warnings.map((w) => (
						<Warning key={`${w.code}:${JSON.stringify(w.params)}`}>
							{codeText(
								WARNINGS,
								w.code,
								t,
								w.code === "diskLow"
									? { need: formatBytes(Number(w.params.need)), free: formatBytes(Number(w.params.free)) }
									: { ...defaults[w.code], ...w.params },
							)}
						</Warning>
					))}
				</div>
			) : null}
			<div>
				<h3 className="mb-1 text-sm font-medium">{t("migrate.previewTitle")}</h3>
				{MIGRATE_DATA_CATEGORIES.some((id) => !preview.held.includes(id)) ? (
					<p className="mb-2 text-xs text-muted" data-testid="migrate-held-note">
						{t("migrate.heldOnly", { names: listOf(preview.held) })}
					</p>
				) : null}
				<CategoryTable rows={preview.categories} compared />
				<p className="mt-2 text-sm" data-testid="migrate-conversations-line">
					{t("migrate.conversationsLine", {
						total: conversations.total,
						added: conversations.added,
						same: conversations.same,
						differs: conversations.differs,
					})}
				</p>
				<LeftOutList items={preview.leftOut} />
				<div className="mt-3">
					<SkippedList files={preview.skipped} />
				</div>
			</div>

			{preview.credentials ? (
				<div className="space-y-3">
					<label className="flex cursor-pointer items-center gap-3 text-sm">
						<input
							type="checkbox"
							className="accent-[var(--accent)]"
							data-testid="migrate-restore"
							checked={restore}
							onChange={(e) => setRestore(e.target.checked)}
						/>
						<span>{t("migrate.restoreLogins")}</span>
					</label>
					{whole ? (
						<p className="text-xs text-muted" data-testid="migrate-whole-note">
							{t("migrate.encWhole")}
						</p>
					) : restore ? (
						<PasswordField
							label={t("migrate.restorePassword")}
							value={password}
							onChange={setPassword}
							testid="migrate-import-password"
							autoComplete="off"
						/>
					) : null}
				</div>
			) : (
				<p className="text-xs text-muted">{t("migrate.noLogins")}</p>
			)}

			<fieldset className="space-y-2">
				<legend className="mb-1 text-sm font-medium">{t("migrate.modeTitle")}</legend>
				{(["merge", "replace"] as const).map((m) => (
					<label key={m} className="flex cursor-pointer items-start gap-3 text-sm">
						<input
							type="radio"
							name="migrate-mode"
							className="mt-1 accent-[var(--accent)]"
							value={m}
							checked={mode === m}
							data-testid={`migrate-mode-${m}`}
							onChange={() => setMode(m)}
						/>
						<span className="min-w-0">
							{t(m === "merge" ? "migrate.modeMerge" : "migrate.modeReplace")}
							<span className="block text-xs text-muted">
								{t(m === "merge" ? "migrate.modeMergeHint" : "migrate.modeReplaceHint")}
							</span>
						</span>
					</label>
				))}
			</fieldset>
			<p className="text-xs text-muted">{t("migrate.backupNote")}</p>
			{problem ? <Alert testid="migrate-import-error">{problemText(problem)}</Alert> : null}
			<div className="flex flex-wrap items-center gap-2">
				<Button type="submit" variant="primary" data-testid="migrate-import" disabled={!ready || busy}>
					{busy ? <Loader2 size={13} className="animate-spin" /> : null} {t("migrate.importButton")}
				</Button>
				<Button data-testid="migrate-discard" disabled={busy} onClick={onDiscard}>
					{t("migrate.chooseOther")}
				</Button>
			</div>
		</form>
	);
}

/** The file is encrypted as a whole: it is opened with its password before anything of it is shown. */
function ImportLocked({
	busy,
	problem,
	onUnlock,
	onDiscard,
}: {
	busy: boolean;
	problem: Problem | null;
	onUnlock: (password: string) => void;
	onDiscard: () => void;
}) {
	const t = useT();
	const problemText = useProblemText();
	const [password, setPassword] = useState("");
	return (
		<form
			className="mt-3 space-y-3"
			noValidate
			data-testid="migrate-locked"
			onSubmit={(e) => {
				e.preventDefault();
				if (password.length > 0 && !busy) onUnlock(password);
			}}
		>
			<div>
				<h3 className="text-sm font-medium">{t("migrate.unlockTitle")}</h3>
				<p className="text-xs text-muted">{t("migrate.unlockHint")}</p>
			</div>
			<PasswordField
				label={t("migrate.unlockPassword")}
				value={password}
				onChange={setPassword}
				testid="migrate-unlock-password"
				autoComplete="off"
			/>
			{problem ? <Alert testid="migrate-import-error">{problemText(problem)}</Alert> : null}
			<div className="flex flex-wrap items-center gap-2">
				<Button type="submit" variant="primary" data-testid="migrate-unlock" disabled={password.length === 0 || busy}>
					{busy ? <Loader2 size={13} className="animate-spin" /> : null}{" "}
					{busy ? t("migrate.unlocking") : t("migrate.unlockButton")}
				</Button>
				<Button data-testid="migrate-discard" disabled={busy} onClick={onDiscard}>
					{t("migrate.chooseOther")}
				</Button>
			</div>
		</form>
	);
}

/** A folder path with a button that copies it. */
function CopyPath({ path }: { path: string }) {
	const t = useT();
	const [done, setDone] = useState(false);
	return (
		<span className="inline-flex min-w-0 max-w-full items-center gap-1.5">
			<code className="select-all break-all font-mono text-xs" data-testid="migrate-backup">
				{path}
			</code>
			<Button
				size="sm"
				data-testid="migrate-backup-copy"
				onClick={() => {
					void navigator.clipboard?.writeText(path);
					setDone(true);
					setTimeout(() => setDone(false), 1200);
				}}
			>
				{done ? <Check size={12} /> : <Copy size={12} />} {done ? t("migrate.copied") : t("migrate.copy")}
			</Button>
		</span>
	);
}

/** What the import did: where the backup is, what happened to what, and what still needs the person. */
function SummaryView({ summary, onClose }: { summary: ImportSummary; onClose: () => void }) {
	const t = useT();
	const { conversations: c, files: f, credentials } = summary;
	const byFile = new Map<string, ImportSummary["oldMachine"]>();
	for (const v of summary.oldMachine) byFile.set(v.file, [...(byFile.get(v.file) ?? []), v]);
	const missingMore = summary.missingFolderCount - summary.missingFolders.length;
	const oldMore = summary.oldMachineCount - summary.oldMachine.length;
	const credentialsText = credentials.restored
		? t("migrate.credsRestored", { providers: credentials.providers, files: credentials.files })
		: credentials.reason
			? codeText(CREDENTIAL_REASONS, credentials.reason, t)
			: t("migrate.credsNotRestored");
	return (
		<div className="mt-3 space-y-3" data-testid="migrate-summary">
			<p className="flex items-center gap-1.5 text-sm font-medium" role="status">
				<Check size={14} className="shrink-0 text-success" />
				{t("migrate.summaryTitle")}
			</p>
			<div className="text-sm">
				<h3 className="mb-1 font-medium">{t("migrate.summaryBackup")}</h3>
				{summary.backup ? (
					<CopyPath path={summary.backup} />
				) : (
					<p className="text-xs text-muted">{t("migrate.summaryBackupNone")}</p>
				)}
			</div>
			<ul className="space-y-0.5 text-sm">
				<li data-testid="migrate-summary-conversations">
					{t("migrate.summaryConversations", {
						added: c.added,
						kept: c.kept,
						updated: c.updated,
						replaced: c.replaced,
					})}
				</li>
				<li data-testid="migrate-summary-files">
					{t("migrate.summaryFiles", {
						added: f.added,
						kept: f.kept,
						replaced: f.replaced,
						merged: f.merged,
						skipped: f.skipped,
					})}
				</li>
				{summary.rewrittenFolders > 0 ? (
					<li>{t("migrate.summaryRewritten", { count: summary.rewrittenFolders })}</li>
				) : null}
				<li data-testid="migrate-summary-credentials">{credentialsText}</li>
			</ul>
			{summary.missingFolders.length > 0 ? (
				<div data-testid="migrate-missing-folders">
					<p className="text-sm">{t("migrate.summaryMissing")}</p>
					<ScrollBox label={t("migrate.summaryMissing")} className="mt-1 max-h-40">
						<ul className="space-y-0.5">
							{summary.missingFolders.map((p) => (
								<li key={p}>
									<Path>{p}</Path>
								</li>
							))}
						</ul>
					</ScrollBox>
					{missingMore > 0 ? (
						<p className="text-xs text-muted">{t("migrate.summaryMore", { count: missingMore })}</p>
					) : null}
				</div>
			) : null}
			{summary.oldMachine.length > 0 ? (
				<div data-testid="migrate-old-machine">
					<p className="text-sm">{t("migrate.summaryOldMachine")}</p>
					<ScrollBox label={t("migrate.summaryOldMachine")} className="mt-1 max-h-56">
						<ul className="space-y-2">
							{[...byFile].map(([file, values]) => (
								<li key={file}>
									<Path>{file}</Path>
									<ul className="mt-0.5 space-y-0.5 pl-3">
										{values.map((v) => (
											<li key={`${v.key}:${v.value}`} className="text-xs">
												{v.key ? <Path>{v.key}: </Path> : null}
												<Path>{v.value}</Path>
												<span className="block text-muted">
													{v.why === "home" ? t("migrate.whyHome") : t("migrate.whyMissing")}
												</span>
											</li>
										))}
									</ul>
								</li>
							))}
						</ul>
					</ScrollBox>
					{oldMore > 0 ? <p className="text-xs text-muted">{t("migrate.summaryMore", { count: oldMore })}</p> : null}
				</div>
			) : null}
			{summary.notes.length > 0 ? (
				<div data-testid="migrate-notes">
					<h3 className="mb-1 text-sm font-medium">{t("migrate.notesTitle")}</h3>
					<ul className="space-y-1">
						{summary.notes.map((n) => (
							<li key={`${n.code}:${JSON.stringify(n.params)}`} className="text-sm">
								{codeText(NOTES, n.code, t, n.params)}
							</li>
						))}
					</ul>
				</div>
			) : null}
			<Button data-testid="migrate-close" onClick={onClose}>
				{t("migrate.close")}
			</Button>
		</div>
	);
}

/** The choice of a file to import; picking it starts the upload. */
function FilePicker({ disabled, onPick }: { disabled: boolean; onPick: (file: File) => void }) {
	const t = useT();
	return (
		<label
			className={cx(
				"inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-border px-3.5 text-sm font-medium text-fg transition-colors",
				"has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[color:var(--ring)]",
				disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-hover",
			)}
		>
			<Upload size={14} />
			{t("migrate.chooseFile")}
			<input
				type="file"
				accept=".ompw"
				className="sr-only"
				disabled={disabled}
				data-testid="migrate-file"
				onChange={(e) => {
					const file = e.target.files?.[0];
					// The same file chosen again must count as a choice.
					e.target.value = "";
					if (file) onPick(file);
				}}
			/>
		</label>
	);
}

/**
 * Settings › Move to another computer: put everything the user has made in omp and in this app into one `.ompw` file and
 * bring such a file into another Mac. The server owns the work (`server/migrate/`); the card shows what an export would
 * hold, follows an export or an import as it runs and says what an import did. Only the page on this Mac may do it (an
 * archive holds every conversation, and an import rewrites the user's own files), so a page that came in through the tunnel
 * is told so. No timer runs while nothing is under way.
 */
export function MigrationSettings() {
	const ready = useStringsReady();
	const t = useT();
	const problemText = useProblemText();
	const remotePage = useApp((s) => s.meta?.remote === true);
	const [plan, setPlan] = useState<MigratePlan | null>(null);
	const [planProblem, setPlanProblem] = useState<Problem | null>(null);
	const [planLoading, setPlanLoading] = useState(false);
	const [ex, setEx] = useState<ExportStatus | null>(null);
	const [im, setIm] = useState<ImportStatus | null>(null);
	const [starting, setStarting] = useState(false);
	const [applying, setApplying] = useState(false);
	const [exportProblem, setExportProblem] = useState<Problem | null>(null);
	const [importProblem, setImportProblem] = useState<Problem | null>(null);
	/** Bytes of the file this page has sent so far; null when this page is not uploading. */
	const [sent, setSent] = useState<number | null>(null);
	const upload = useRef<AbortController | null>(null);

	const loadPlan = useCallback(async () => {
		setPlanLoading(true);
		try {
			setPlan(await migrateApi.plan());
			setPlanProblem(null);
		} catch (e) {
			setPlanProblem(problemOf(e));
		} finally {
			setPlanLoading(false);
		}
	}, []);

	// The plan, and what is under way (a reload in the middle of an export or an import finds it again).
	useEffect(() => {
		if (remotePage) return;
		void loadPlan();
		void migrateApi.state().then(
			(s) => {
				setEx(s.export);
				setIm(s.import);
			},
			() => {},
		);
	}, [remotePage, loadPlan]);

	// Ask again only while the server is working: nothing runs otherwise.
	const working = ex?.state === "running" || im?.state === "verifying" || im?.state === "applying";
	useEffect(() => {
		if (!working || remotePage) return;
		let stopped = false;
		let timer = 0;
		const poll = async () => {
			try {
				const s = await migrateApi.state();
				if (stopped) return;
				setEx(s.export);
				setIm(s.import);
			} catch {
				// The next look may find the server again.
			}
			if (!stopped) timer = window.setTimeout(poll, POLL_MS);
		};
		timer = window.setTimeout(poll, POLL_MS);
		return () => {
			stopped = true;
			clearTimeout(timer);
		};
	}, [working, remotePage]);

	if (remotePage) {
		if (!ready) return null;
		return (
			<section
				className="rounded-2xl border border-border bg-surface p-4"
				data-testid="migrate-settings"
				data-index-title={t("migrate.indexTitle")}
			>
				<CardHeader icon={<ArrowRightLeft size={16} />} title={t("migrate.title")} />
				<p className="text-sm text-muted" data-testid="migrate-refused">
					{t("migrate.refused")}
				</p>
			</section>
		);
	}
	if (!ready) return null;

	const startExport = async (req: ExportRequest) => {
		setStarting(true);
		setExportProblem(null);
		try {
			setEx(await migrateApi.startExport(req));
		} catch (e) {
			setExportProblem(problemOf(e));
		} finally {
			setStarting(false);
		}
	};
	const cancelExport = async () => {
		try {
			await migrateApi.cancelExport();
			setEx((await migrateApi.state()).export);
		} catch (e) {
			setExportProblem(problemOf(e));
		}
	};
	const finishExport = async () => {
		try {
			await migrateApi.discardExport();
		} catch {
			// A finished export the server has already forgotten is as good as one it deleted.
		}
		setEx(null);
		setExportProblem(null);
		void loadPlan();
	};

	const forgetImport = async () => {
		upload.current?.abort();
		try {
			await migrateApi.discardImport();
		} catch {
			// Nothing left to drop.
		}
		setIm(null);
		setSent(null);
		setImportProblem(null);
	};
	const startImport = async (file: File) => {
		const controller = new AbortController();
		upload.current = controller;
		setImportProblem(null);
		setSent(0);
		try {
			setIm(await migrateApi.beginImport({ name: file.name, size: file.size }));
			await migrateApi.upload(file, setSent, setIm, controller.signal);
			setIm(await migrateApi.verifyImport());
		} catch (e) {
			if (e instanceof DOMException && e.name === "AbortError") return;
			setImportProblem(problemOf(e));
			// What was uploaded so far is of no use to a person who has to start again.
			await migrateApi.discardImport().catch(() => {});
			setIm(null);
		} finally {
			if (upload.current === controller) upload.current = null;
			setSent(null);
		}
	};
	const unlockImport = async (password: string) => {
		setApplying(true);
		setImportProblem(null);
		try {
			setIm(await migrateApi.unlockImport(password));
		} catch (e) {
			// A wrong password: the file stays locked, to be tried again.
			setImportProblem(problemOf(e));
		} finally {
			setApplying(false);
		}
	};
	const applyImport = async (req: ImportRequest) => {
		setApplying(true);
		setImportProblem(null);
		try {
			setIm(await migrateApi.applyImport(req));
		} catch (e) {
			// Refused (a wrong password, say): the preview stays, and so does what the person chose.
			setImportProblem(problemOf(e));
		} finally {
			setApplying(false);
		}
	};

	const restoreImport = async () => {
		setApplying(true);
		setImportProblem(null);
		try {
			setIm(await migrateApi.restoreImport());
		} catch (e) {
			setImportProblem(problemOf(e));
		} finally {
			setApplying(false);
		}
	};

	const exporting = ex?.state === "running";
	const importing = im !== null && im.state !== "done" && im.state !== "failed";

	return (
		<section
			className="rounded-2xl border border-border bg-surface p-4"
			data-testid="migrate-settings"
			data-index-title={t("migrate.indexTitle")}
		>
			<CardHeader icon={<ArrowRightLeft size={16} />} title={t("migrate.title")} hint={t("migrate.intro")} />
			<p className="mb-3 flex items-start gap-1.5 text-xs text-warning" data-testid="migrate-not-encrypted">
				<CircleAlert size={14} className="mt-px shrink-0" />
				<span>{t("migrate.notEncrypted")}</span>
			</p>

			<div data-testid="migrate-export-block">
				<div className="flex items-center gap-2">
					<h3 className="flex-1 text-sm font-medium">{t("migrate.exportTitle")}</h3>
					<Button
						size="sm"
						data-testid="migrate-refresh"
						disabled={planLoading || exporting}
						onClick={() => void loadPlan()}
					>
						<RefreshCw size={12} className={planLoading ? "animate-spin" : undefined} /> {t("migrate.refresh")}
					</Button>
				</div>
				<p className="mb-2 text-xs text-muted">{t("migrate.exportIntro")}</p>

				{ex === null ? (
					<>
						{planProblem ? (
							<Alert testid="migrate-plan-error">{t("migrate.planFailed", { error: problemText(planProblem) })}</Alert>
						) : null}
						{plan ? (
							<ExportPanel plan={plan} blocked={importing} starting={starting} onStart={(r) => void startExport(r)} />
						) : planProblem ? null : (
							<p className="flex items-center gap-2 text-sm text-muted" data-testid="migrate-plan-loading">
								<Spinner size={14} /> {t("migrate.planLoading")}
							</p>
						)}
					</>
				) : ex.state === "running" ? (
					<div className="space-y-2">
						<ServerProgress label={t("migrate.exportProgress")} progress={ex.progress} />
						<Button data-testid="migrate-cancel" onClick={() => void cancelExport()}>
							{t("migrate.cancel")}
						</Button>
					</div>
				) : ex.state === "done" ? (
					<ExportDone ex={ex} onDone={() => void finishExport()} />
				) : (
					<div className="space-y-2" data-testid="migrate-export-ended" data-state={ex.state}>
						{ex.state === "failed" ? (
							<Alert>{t("migrate.exportFailed", { error: ex.error ? problemText(ex.error) : "" })}</Alert>
						) : (
							<p className="text-sm text-muted">{t("migrate.exportCancelled")}</p>
						)}
						<SkippedList files={ex.skipped} />
						<Button data-testid="migrate-export-retry" onClick={() => void finishExport()}>
							{t("migrate.tryAgain")}
						</Button>
					</div>
				)}
				{exportProblem ? <Alert testid="migrate-export-error">{problemText(exportProblem)}</Alert> : null}
			</div>

			<div className="mt-5 border-t border-border pt-4" data-testid="migrate-import-block">
				<h3 className="text-sm font-medium">{t("migrate.importTitle")}</h3>
				<p className="mb-2 text-xs text-muted">{t("migrate.importIntro")}</p>
				{im === null ? (
					<>
						<FilePicker disabled={exporting || starting} onPick={(f) => void startImport(f)} />
						{importProblem ? <Alert testid="migrate-import-error">{problemText(importProblem)}</Alert> : null}
					</>
				) : im.state === "uploading" ? (
					sent !== null ? (
						<div className="space-y-2">
							<ProgressView
								label={t("migrate.importProgress")}
								phase={t("migrate.phaseUpload")}
								done={sent}
								total={im.size}
							/>
							<Button data-testid="migrate-cancel-upload" onClick={() => void forgetImport()}>
								{t("migrate.uploadCancel")}
							</Button>
						</div>
					) : (
						<div className="space-y-2" data-testid="migrate-interrupted">
							<Warning>{t("migrate.interrupted")}</Warning>
							<Button data-testid="migrate-start-again" onClick={() => void forgetImport()}>
								{t("migrate.startAgain")}
							</Button>
						</div>
					)
				) : im.state === "locked" ? (
					<ImportLocked
						busy={applying}
						problem={importProblem}
						onUnlock={(p) => void unlockImport(p)}
						onDiscard={() => void forgetImport()}
					/>
				) : im.state === "verifying" || im.state === "applying" ? (
					<ServerProgress label={t("migrate.importProgress")} progress={im.progress} />
				) : im.state === "ready" && im.preview ? (
					<ImportReady
						preview={im.preview}
						busy={applying}
						problem={importProblem}
						onApply={(r) => void applyImport(r)}
						onDiscard={() => void forgetImport()}
					/>
				) : im.state === "done" && im.summary ? (
					<SummaryView summary={im.summary} onClose={() => void forgetImport()} />
				) : (
					<div className="space-y-2" data-testid="migrate-import-failed">
						<Alert>{t("migrate.importFailed", { error: im.error ? problemText(im.error) : "" })}</Alert>
						{im.backup ? (
							<div className="space-y-1.5 text-sm" data-testid="migrate-failed-backup">
								{im.restored ? (
									<p data-testid="migrate-restored">{t("migrate.restored")}</p>
								) : (
									<>
										<p className="text-xs text-muted">{t("migrate.importFailedBackup")}</p>
										<p>
											<Path>{im.backup}</Path>
										</p>
										<Button
											data-testid="migrate-restore-backup"
											disabled={applying}
											onClick={() => void restoreImport()}
										>
											{applying ? t("migrate.restoring") : t("migrate.restore")}
										</Button>
									</>
								)}
							</div>
						) : null}
						<Button data-testid="migrate-import-retry" onClick={() => void forgetImport()}>
							{t("migrate.importFailedRetry")}
						</Button>
					</div>
				)}
			</div>
		</section>
	);
}
