import { MIGRATE_MIN_PASSWORD } from "@shared/migrate.ts";
import { Check, CircleAlert, Copy, Sparkles } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { type MessageKey, useT } from "../i18n/index.ts";
import type * as GenerateApi from "../lib/password-generate.ts";
import type * as StrengthApi from "../lib/password-strength.ts";
import { Button, cx } from "./ui.tsx";

/**
 * The password of a migration archive, wherever it is typed (Settings › Move to another computer): to encrypt an export,
 * to open an encrypted file, to restore its logins. One field, so that all of them look and read alike. Where the
 * password is being chosen, `strength` adds a live hint: how strong it is, what makes it weak, and a passphrase to use
 * instead. The estimator and the random source are code of their own, fetched the first time something is typed.
 */
export const field =
	"h-9 w-full rounded-xl border border-border bg-bg-soft px-3 text-sm outline-none focus:border-faint";

interface Tools {
	strength: typeof StrengthApi;
	generate: typeof GenerateApi;
}

let loaded: Tools | null = null;
let loading: Promise<Tools> | null = null;

/** The estimator and the generator, loaded once for the page (neither is code the first paint needs). */
export function loadPasswordTools(): Promise<Tools> {
	loading ??= Promise.all([import("../lib/password-strength.ts"), import("../lib/password-generate.ts")]).then(
		([strength, generate]) => {
			loaded = { strength, generate };
			return loaded;
		},
	);
	return loading;
}

/** The tools once they are loaded; `wanted` starts the load. */
function usePasswordTools(wanted: boolean): Tools | null {
	const [tools, setTools] = useState<Tools | null>(loaded);
	useEffect(() => {
		if (!wanted || tools) return;
		let live = true;
		void loadPasswordTools().then(
			(t) => live && setTools(t),
			// A chunk that does not arrive leaves the field as it is: no hint is better than a blocked form.
			() => {},
		);
		return () => {
			live = false;
		};
	}, [wanted, tools]);
	return tools;
}

const LEVELS: MessageKey[] = [
	"migrate.strength0",
	"migrate.strength1",
	"migrate.strength2",
	"migrate.strength3",
	"migrate.strength4",
];

const REASONS: Record<StrengthApi.StrengthReason, MessageKey> = {
	short: "migrate.reasonShort",
	common: "migrate.reasonCommon",
	word: "migrate.reasonWord",
	sequence: "migrate.reasonSequence",
	keyboard: "migrate.reasonKeyboard",
	repeat: "migrate.reasonRepeat",
	date: "migrate.reasonDate",
	singleKind: "migrate.reasonSingleKind",
};

/** How long typing must pause before a screen reader is told the new strength: every key would be a stream of chatter. */
const ANNOUNCE_MS = 700;

/** The strength of `password`: a meter with a word for it (never colour alone), what makes it weak, and a passphrase to use. */
function StrengthHint({ id, password, onUse }: { id: string; password: string; onUse: (passphrase: string) => void }) {
	const t = useT();
	const tools = usePasswordTools(password.length > 0);
	const result = useMemo(
		() => (tools && password ? tools.strength.estimateStrength(password) : null),
		[tools, password],
	);
	// A suggestion stays while the person types, so that it can be read; it is made once the tools are there.
	const [suggestion, setSuggestion] = useState<string | null>(null);
	useEffect(() => {
		if (tools && suggestion === null) {
			setSuggestion(tools.strength.suggestPassphrase((n) => tools.generate.randomInt(n)));
		}
	}, [tools, suggestion]);

	const level = result ? t(LEVELS[result.score]) : "";
	const reasons = result ? result.reasons.map((r) => t(REASONS[r])) : [];
	const spoken = result ? [t("migrate.strengthLabel", { level }), ...reasons].join(" ") : "";
	const [announced, setAnnounced] = useState("");
	useEffect(() => {
		const timer = setTimeout(() => setAnnounced(spoken), spoken ? ANNOUNCE_MS : 0);
		return () => clearTimeout(timer);
	}, [spoken]);

	if (!result) return <div id={id} />;
	const weak = result.score < 3;
	const tone = result.score <= 1 ? "bg-danger" : result.score === 2 ? "bg-warning" : "bg-success";
	return (
		<div id={id} className="mt-1.5 space-y-1" data-testid="migrate-strength" data-score={result.score}>
			<div className="flex gap-1" aria-hidden="true">
				{[0, 1, 2, 3, 4].map((i) => (
					<span key={i} className={cx("h-1.5 flex-1 rounded-full", i <= result.score ? tone : "bg-hover")} />
				))}
			</div>
			<p
				className={cx(
					"flex items-center gap-1 text-xs font-medium",
					result.score <= 1 ? "text-danger" : result.score === 2 ? "text-warning" : "text-success",
				)}
				data-testid="migrate-strength-label"
			>
				{weak ? <CircleAlert size={12} className="shrink-0" /> : <Check size={12} className="shrink-0" />}
				{t("migrate.strengthLabel", { level })}
			</p>
			{reasons.length > 0 ? (
				<ul className="list-disc space-y-0.5 pl-4 text-xs text-muted" data-testid="migrate-strength-reasons">
					{reasons.map((r) => (
						<li key={r}>{r}</li>
					))}
				</ul>
			) : null}
			{weak && suggestion ? (
				<p
					className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted"
					data-testid="migrate-strength-suggest"
				>
					<span>{t("migrate.suggestIntro")}</span>
					<code className="break-all font-mono text-fg">{suggestion}</code>
					<Button size="sm" data-testid="migrate-strength-use" onClick={() => onUse(suggestion)}>
						{t("migrate.suggestUse")}
					</Button>
				</p>
			) : null}
			<p className="sr-only" role="status" aria-live="polite" data-testid="migrate-strength-spoken">
				{announced}
			</p>
		</div>
	);
}

export function PasswordField({
	label,
	value,
	onChange,
	problem,
	testid,
	autoComplete,
	reveal,
	strength,
}: {
	label: string;
	value: string;
	onChange: (v: string) => void;
	problem?: string | null;
	testid: string;
	autoComplete: string;
	/** Shown in clear (a password that was made here, so that it can be saved). */
	reveal?: boolean;
	/** The password is being chosen: show its strength; `onUse` is told a passphrase the person picked. */
	strength?: { onUse: (passphrase: string) => void };
}) {
	const id = useId();
	const problemId = `${id}-problem`;
	const hintId = `${id}-hint`;
	const described = [problem ? problemId : null, strength && value ? hintId : null].filter(Boolean).join(" ");
	return (
		<div>
			<label htmlFor={id} className="mb-1 block text-sm">
				{label}
			</label>
			<input
				id={id}
				type={reveal ? "text" : "password"}
				className={cx(field, reveal && "font-mono")}
				value={value}
				autoComplete={autoComplete}
				autoCapitalize="off"
				spellCheck={false}
				minLength={MIGRATE_MIN_PASSWORD}
				aria-invalid={problem ? true : undefined}
				aria-describedby={described || undefined}
				data-testid={testid}
				onChange={(e) => onChange(e.target.value)}
			/>
			{problem ? (
				<p id={problemId} className="mt-1 text-xs text-danger" data-testid={`${testid}-problem`}>
					{problem}
				</p>
			) : null}
			{strength ? <StrengthHint id={hintId} password={value} onUse={strength.onUse} /> : null}
		</div>
	);
}

/**
 * What the person is told when a password was made for them: it is shown in the field in clear, they must keep it, and
 * nothing here keeps it for them. The Copy button is for the clipboard of this Mac.
 */
export function MadePassword({ password }: { password: string }) {
	const t = useT();
	const [copy, setCopy] = useState<"idle" | "done" | "failed">("idle");
	// A different password is a new copy to make.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the button's state resets when the password changes.
	useEffect(() => setCopy("idle"), [password]);
	useEffect(() => {
		if (copy !== "done") return;
		const timer = setTimeout(() => setCopy("idle"), 1500);
		return () => clearTimeout(timer);
	}, [copy]);
	return (
		<div className="space-y-1.5" data-testid="migrate-password-made">
			<p className="flex items-start gap-1.5 text-xs text-warning" role="status">
				<CircleAlert size={14} className="mt-px shrink-0" />
				<span className="min-w-0 break-words">{t("migrate.madeNote")}</span>
			</p>
			<div className="flex flex-wrap items-center gap-2">
				<Button
					size="sm"
					data-testid="migrate-password-copy"
					onClick={() => {
						navigator.clipboard.writeText(password).then(
							() => setCopy("done"),
							() => setCopy("failed"),
						);
					}}
				>
					{copy === "done" ? <Check size={12} /> : <Copy size={12} />}{" "}
					{copy === "done" ? t("migrate.copied") : t("migrate.copyPassword")}
				</Button>
				{copy === "failed" ? <span className="text-xs text-danger">{t("migrate.copyFailed")}</span> : null}
			</div>
		</div>
	);
}

/** The button that makes a random password (see `lib/password-generate.ts`) and hands it to `onMade`. */
export function GenerateButton({ onMade }: { onMade: (password: string) => void }) {
	const t = useT();
	return (
		<Button
			size="sm"
			data-testid="migrate-generate"
			onClick={() => {
				void loadPasswordTools().then(({ generate }) => onMade(generate.generatePassword()));
			}}
		>
			<Sparkles size={12} /> {t("migrate.generate")}
		</Button>
	);
}
