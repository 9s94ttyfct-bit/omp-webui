import type { CliHelp, CliInventory } from "@shared/protocol.ts";
import { ChevronDown, ChevronRight, Play, SquareTerminal } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { api } from "../lib/api.ts";
import { socket } from "../lib/ws.ts";
import { useApp } from "../store/app.ts";
import { LoadError } from "./LoadError.tsx";
import { Terminal } from "./Terminal.tsx";
import { Button, cx, Spinner } from "./ui.tsx";

/** Split a command line like a POSIX shell would for simple quoting. */
export function splitArgs(line: string): string[] {
	const out: string[] = [];
	let cur = "";
	let quote: string | null = null;
	let has = false;
	for (const ch of line) {
		if (quote) {
			if (ch === quote) quote = null;
			else cur += ch;
		} else if (ch === '"' || ch === "'") {
			quote = ch;
			has = true;
		} else if (/\s/.test(ch)) {
			if (cur || has) out.push(cur);
			cur = "";
			has = false;
		} else {
			cur += ch;
		}
	}
	if (cur || has) out.push(cur);
	return out;
}

/** Quote an argument for display on the command line. */
function quoteArg(a: string): string {
	return /[\s"']/.test(a) ? `'${a.replaceAll("'", "'\\''")}'` : a;
}

export function CliPage({ command, run: initialRun }: { command?: string; run?: string[] }) {
	const t = useT();
	const { setView, meta } = useApp(useShallow((s) => ({ setView: s.setView, meta: s.meta })));
	const [inv, setInv] = useState<CliInventory | null>(null);
	const [help, setHelp] = useState<CliHelp | null>(null);
	const [q, setQ] = useState("");
	const [line, setLine] = useState(() =>
		initialRun ? initialRun.map(quoteArg).join(" ") : command ? `${command} ` : "",
	);
	// `attach`: a terminal the macOS app's Run in Background held for this window (see `PtyManager.held`).
	const [run, setRun] = useState<{ args: string[]; key: number; attach?: string } | null>(() =>
		initialRun ? { args: initialRun, key: Date.now() } : null,
	);
	const [invError, setInvError] = useState<string | null>(null);
	const [helpError, setHelpError] = useState<string | null>(null);

	// Each load can run again (Retry): it clears its own error first, so the spinner is back while it does.
	const loadInventory = useCallback(() => {
		setInvError(null);
		api
			.cli()
			.then(setInv)
			.catch((e) => setInvError(e.message));
	}, []);
	const loadHelp = useCallback(() => {
		if (!command) return;
		setHelpError(null);
		api
			.cliHelp(command)
			.then(setHelp)
			.catch((e) => setHelpError(e.message));
	}, [command]);
	// The page is keyed by command/run, so each runs once per mount.
	useEffect(loadInventory, [loadInventory]);
	useEffect(loadHelp, [loadHelp]);
	// A window that opens again after Run in Background finds the terminal it had: the page asks once, and only when it was
	// not opened to run something else.
	useEffect(() => {
		if (initialRun) return;
		let gone = false;
		socket
			.request<{ terminals: { ptyId: string; args: string[]; shell?: true }[] }>({ t: "pty_held" })
			.then(({ terminals }) => {
				// The panel's shells are the panel's to take back (`lib/shell-terminals.ts`).
				const held = terminals.find((x) => !x.shell);
				if (gone || !held) return;
				setLine(held.args.map(quoteArg).join(" "));
				setRun((now) => now ?? { args: held.args, key: Date.now(), attach: held.ptyId });
			})
			.catch(() => {});
		return () => {
			gone = true;
		};
	}, [initialRun]);

	// On a phone the list is folded away behind the row that names the page, so that the help, the command line and the
	// output keep the screen; choosing a command opens the page again (keyed by it), with the list folded.
	const [listOpen, setListOpen] = useState(false);
	const output = useRef<HTMLDivElement>(null);
	const runKey = run?.key;
	// The output is below the form that ran it, which on a phone is more than a screen away: bring it into view.
	useEffect(() => {
		if (runKey !== undefined) output.current?.scrollIntoView({ block: "nearest" });
	}, [runKey]);

	const list = useMemo(
		() =>
			(inv?.commands ?? []).filter(
				(c) => !q || c.name.includes(q) || c.description.toLowerCase().includes(q.toLowerCase()),
			),
		[inv, q],
	);

	return (
		// Stacked on a narrow screen (the list above the rest, the page scrolling as one); side by side from `md` up, each part
		// scrolling on its own.
		<div className="flex h-full min-w-0 flex-1 flex-col max-md:overflow-y-auto md:flex-row" data-testid="cli-page">
			<div className="flex shrink-0 flex-col border-b border-border md:w-64 md:border-r md:border-b-0">
				<button
					type="button"
					className="flex w-full items-center gap-2 p-3 text-left text-sm md:hidden"
					aria-expanded={listOpen}
					aria-controls="cli-commands"
					data-testid="cli-commands-toggle"
					onClick={() => setListOpen((o) => !o)}
				>
					<SquareTerminal size={16} className="shrink-0 text-accent" />
					<span className="font-semibold">{t("pages.cliCommands")}</span>
					<span className="min-w-0 flex-1 truncate font-mono text-muted">{command ?? "…"}</span>
					<ChevronDown size={16} className={cx("shrink-0 text-faint transition-transform", listOpen && "rotate-180")} />
				</button>
				<div id="cli-commands" className={cx("min-h-0 flex-1 flex-col md:flex", listOpen ? "flex" : "hidden")}>
					<div className="px-3 pb-2 md:p-3">
						<div className="mb-2 hidden items-center gap-2 text-sm font-semibold md:flex">
							<SquareTerminal size={16} className="text-accent" /> {t("pages.cliCommands")}
						</div>
						<input
							aria-label={t("pages.cliFilterAria")}
							placeholder={t("pages.cliFilter")}
							value={q}
							onChange={(e) => setQ(e.target.value)}
							className="w-full rounded-lg border border-border bg-surface px-2.5 py-1.5 text-sm outline-none focus:border-faint"
						/>
					</div>
					<nav className="px-2 pb-2 md:min-h-0 md:flex-1 md:overflow-y-auto" aria-label={t("pages.cliNavAria")}>
						<button
							type="button"
							aria-current={!command ? "page" : undefined}
							className={cx(
								"w-full rounded-lg px-2.5 py-1.5 text-left text-sm",
								!command ? "bg-hover" : "hover:bg-hover",
							)}
							onClick={() => setView({ kind: "cli" })}
						>
							<div className="font-mono">omp …</div>
							<div className="truncate text-xs text-muted">{t("pages.cliRunAny")}</div>
						</button>
						{!inv && !invError ? <Spinner className="m-4" /> : null}
						{invError ? (
							<div className="p-1">
								<LoadError title={t("pages.cliListErrorTitle")} error={invError} onRetry={loadInventory} />
							</div>
						) : null}
						{list.map((c) => (
							<button
								type="button"
								key={c.name}
								data-testid="cli-command"
								data-command={c.name}
								aria-current={command === c.name ? "page" : undefined}
								className={cx(
									"w-full rounded-lg px-2.5 py-1.5 text-left text-sm",
									command === c.name ? "bg-hover" : "hover:bg-hover",
								)}
								onClick={() => setView({ kind: "cli", command: c.name })}
							>
								<div className="font-mono">{c.name}</div>
								<div className="truncate text-xs text-muted">{c.description}</div>
							</button>
						))}
					</nav>
				</div>
			</div>
			<div className="flex min-w-0 flex-1 flex-col gap-4 p-4 md:overflow-y-auto md:p-5">
				{helpError ? <LoadError title={t("pages.cliHelpErrorTitle")} error={helpError} onRetry={loadHelp} /> : null}
				{command && !help && !helpError ? <Spinner /> : null}
				{help ? (
					<div className="space-y-3">
						<h1 className="font-mono text-lg font-semibold">omp {help.command}</h1>
						<p className="text-sm text-muted">{help.description}</p>
						{help.usage ? <pre className="rounded-lg bg-code p-2 font-mono text-xs">{help.usage}</pre> : null}
						{help.subcommands.length ? (
							<div className="flex flex-wrap gap-1.5">
								{help.subcommands.map((s) => (
									<button
										type="button"
										key={s.name}
										title={s.description}
										className="rounded-md border border-border px-2 py-0.5 font-mono text-xs hover:bg-hover"
										onClick={() => setLine(`${help.command} ${s.name} `)}
									>
										{s.name}
									</button>
								))}
							</div>
						) : null}
						{help.flags.length || help.args.length ? (
							<details className="group rounded-xl border border-border bg-surface" open={help.flags.length <= 12}>
								<summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm font-medium [&::-webkit-details-marker]:hidden">
									<ChevronRight size={14} className="shrink-0 text-faint transition-transform group-open:rotate-90" />
									{t("pages.cliArgsFlags")}
								</summary>
								<div className="divide-y divide-border text-xs">
									{help.args.map((a) => (
										<div key={a.name} className="flex gap-3 px-3 py-1.5">
											<code className="w-40 shrink-0 text-accent">{a.name}</code>
											<span className="text-muted">{a.description}</span>
										</div>
									))}
									{help.flags.map((f) => (
										<button
											type="button"
											key={f.name}
											className="flex w-full gap-3 px-3 py-1.5 text-left hover:bg-hover"
											onClick={() => setLine((l) => `${l.trimEnd()} ${f.name}${f.value ? "=" : " "}`)}
										>
											<code className="w-40 shrink-0">
												{f.short ? `${f.short}, ` : ""}
												{f.name}
												{f.value ? <span className="text-faint">={f.value}</span> : null}
											</code>
											<span className="text-muted">{f.description}</span>
										</button>
									))}
								</div>
							</details>
						) : null}
					</div>
				) : !command ? (
					<div>
						<h1 className="text-lg font-semibold">{t("pages.cliRunTitle")}</h1>
						<p className="text-sm text-muted">
							{t("pages.cliIntroBefore")} <code>omp --help</code>
							{t("pages.cliIntroAfter")}
						</p>
					</div>
				) : null}
				<form
					className="flex flex-col gap-2 sm:flex-row"
					onSubmit={(e) => {
						e.preventDefault();
						setRun({ args: splitArgs(line), key: Date.now() });
					}}
				>
					<div className="flex min-w-0 flex-1 items-center rounded-lg border border-border bg-surface px-2.5 font-mono text-sm focus-within:border-faint">
						<span className="text-faint">$ omp&nbsp;</span>
						<input
							aria-label={t("pages.cliLineAria")}
							data-testid="cli-line"
							value={line}
							onChange={(e) => setLine(e.target.value)}
							className="min-w-0 flex-1 bg-transparent py-1.5 outline-none"
							placeholder="stats --summary"
						/>
					</div>
					<Button variant="primary" type="submit" data-testid="cli-run">
						<Play size={14} /> {t("pages.cliRun")}
					</Button>
				</form>
				<div ref={output} className="min-h-80 flex-1" data-testid="cli-output">
					{run ? <Terminal key={run.key} args={run.args} cwd={meta?.home} attach={run.attach} /> : null}
				</div>
			</div>
		</div>
	);
}
