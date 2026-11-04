import type { McpAdded, McpInstallOption, McpProblem, McpServerHit } from "@shared/mcp-registry.ts";
import { WEB_CATALOGS } from "@shared/plugins-catalogs.ts";
import { ExternalLink, Plug, Plus, Search } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { type MessageKey, useT } from "../../i18n/index.ts";
import { pluginsApi } from "../../lib/plugins-api.ts";
import { Select } from "../Select.tsx";
import { Badge, Button, Modal, Spinner, WithCode } from "../ui.tsx";
import { FIELD, Section, WebLinks } from "./parts.tsx";

/**
 * The MCP tab of the Plugins page: the official MCP Registry, searched by the server (the page never asks the registry
 * itself), with each server's ways of running it (its npm, PyPI or Docker packages, its remote endpoints). **Add** writes one
 * of them into omp's MCP configuration for the user (`mcp.json` in omp's agent directory), after a dialog asks for the
 * values it needs (secret ones in password fields). A way the server cannot write says why instead.
 */

const KIND_LABEL: Record<string, string> = { npm: "npm", pypi: "PyPI", oci: "Docker", remote: "Remote" };

const PROBLEM_KEY: Record<McpProblem["code"], MessageKey> = {
	registry: "plugins.mcpProblemRegistry",
	"private-registry": "plugins.mcpProblemPrivate",
	"local-http": "plugins.mcpProblemLocalHttp",
	transport: "plugins.mcpProblemTransport",
	invalid: "plugins.mcpProblemInvalid",
};

const KIND_KEY: Record<McpInstallOption["inputs"][number]["kind"], MessageKey> = {
	env: "plugins.mcpInputEnv",
	header: "plugins.mcpInputHeader",
	arg: "plugins.mcpInputArg",
	var: "plugins.mcpInputVar",
};

export default function McpTab({
	cwd,
	busy,
	onAdded,
}: {
	cwd: string | null;
	busy: boolean;
	onAdded: (added: McpAdded) => void;
}) {
	const t = useT();
	const [q, setQ] = useState("");
	const [servers, setServers] = useState<McpServerHit[] | null>(null);
	const [taken, setTaken] = useState<string[]>([]);
	const [next, setNext] = useState<{ query: string; cursor: string } | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [searching, setSearching] = useState(false);
	const [adding, setAdding] = useState<{ server: McpServerHit; option: McpInstallOption } | null>(null);

	const search = (query: string, cursor: string | null) => {
		setSearching(true);
		setError(null);
		pluginsApi
			.searchMcp(query, cursor, cwd)
			.then((r) => {
				setServers((before) => (cursor && before ? [...before, ...r.servers] : r.servers));
				setTaken(r.taken);
				setNext(r.nextCursor ? { query, cursor: r.nextCursor } : null);
			})
			.catch((e: Error) => setError(e.message))
			.finally(() => setSearching(false));
	};

	return (
		<Section
			id="mcp"
			title={t("plugins.mcpTitle")}
			icon={<Plug size={16} className="text-accent" />}
			hint={<WithCode text={t("plugins.mcpHint")} />}
		>
			<form
				className="flex flex-wrap gap-2"
				onSubmit={(e) => {
					e.preventDefault();
					search(q.trim(), null);
				}}
			>
				<input
					type="search"
					value={q}
					onChange={(e) => setQ(e.target.value)}
					aria-label={t("plugins.mcpSearchLabel")}
					placeholder={t("plugins.mcpSearchPlaceholder")}
					className={`${FIELD} flex-1 basis-60`}
					data-testid="mcp-search"
				/>
				<Button type="submit" disabled={searching} data-testid="mcp-search-run">
					{searching ? <Spinner size={13} /> : <Search size={13} />} {t("plugins.search")}
				</Button>
			</form>
			{error ? (
				<p role="alert" className="mt-2 whitespace-pre-wrap text-sm text-danger" data-testid="mcp-search-error">
					{error}
				</p>
			) : null}
			{servers && servers.length === 0 ? (
				<p className="mt-3 text-sm text-muted" data-testid="mcp-search-empty">
					{t("plugins.mcpNone")}
				</p>
			) : null}
			{servers && servers.length > 0 ? (
				<ul className="mt-2 divide-y divide-border" data-testid="mcp-servers">
					{servers.map((s) => (
						<li
							key={`${s.name}@${s.version}`}
							className="py-3"
							data-testid="mcp-server"
							data-server={s.name}
							data-added={s.added !== null}
						>
							<div className="flex flex-wrap items-center gap-1.5">
								<span className="break-all text-sm font-medium">{s.title ?? s.name}</span>
								{s.version ? <Badge>{s.version}</Badge> : null}
								{s.added ? (
									<Badge tone="success">
										<span data-testid="mcp-added">{t("plugins.mcpAdded", { name: s.added })}</span>
									</Badge>
								) : null}
							</div>
							{s.title ? <div className="break-all font-mono text-xs text-faint">{s.name}</div> : null}
							{s.description ? <p className="mt-1 text-xs text-muted">{s.description}</p> : null}
							{s.repository || s.website ? (
								<p className="mt-1 flex flex-wrap gap-x-3 text-xs">
									{[s.repository, s.website]
										.filter((u): u is string => u !== null)
										.map((u) => (
											<a
												key={u}
												href={u}
												target="_blank"
												rel="noopener noreferrer"
												className="inline-flex items-center gap-1 break-all text-accent hover:underline"
											>
												{u.replace(/^https:\/\//, "")} <ExternalLink size={11} aria-hidden />
											</a>
										))}
								</p>
							) : null}
							{s.options.length === 0 ? (
								<p className="mt-1 text-xs text-warning">{t("plugins.mcpNoOptions")}</p>
							) : (
								<ul className="mt-2 flex flex-col gap-1.5">
									{s.options.map((o) => (
										<li
											key={o.id}
											className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-2.5 py-1.5"
											data-testid="mcp-option"
											data-option={o.id}
										>
											<Badge>{KIND_LABEL[o.kind] ?? o.kind}</Badge>
											<code className="min-w-0 flex-1 basis-48 break-all font-mono text-xs">{o.summary}</code>
											{o.problem ? (
												<span className="basis-full text-xs text-warning" data-testid="mcp-option-problem">
													{t(PROBLEM_KEY[o.problem.code], { detail: o.problem.detail })}
												</span>
											) : (
												<Button
													size="sm"
													variant="primary"
													disabled={busy || s.added !== null}
													onClick={() => setAdding({ server: s, option: o })}
													data-testid="mcp-option-add"
												>
													<Plus size={13} /> {t("plugins.mcpAdd")}
												</Button>
											)}
										</li>
									))}
								</ul>
							)}
						</li>
					))}
				</ul>
			) : null}
			{next ? (
				<div className="mt-2 flex justify-center">
					<Button size="sm" disabled={searching} onClick={() => search(next.query, next.cursor)} data-testid="mcp-more">
						{t("plugins.mcpMore")}
					</Button>
				</div>
			) : null}
			<div className="mt-3">
				<WebLinks label={t("plugins.webMcp")} catalogs={WEB_CATALOGS.mcp} testId="mcp-web-catalogs" />
			</div>
			{adding ? (
				<AddDialog
					server={adding.server}
					option={adding.option}
					taken={taken}
					cwd={cwd}
					onClose={() => setAdding(null)}
					onAdded={(added) => {
						setAdding(null);
						setTaken((names) => [...names, added.name]);
						setServers(
							(list) => list?.map((s) => (s.name === adding.server.name ? { ...s, added: added.name } : s)) ?? null,
						);
						onAdded(added);
					}}
				/>
			) : null}
		</Section>
	);
}

/** The values one way of running a server needs, its name in omp's config, and Add. */
function AddDialog({
	server,
	option,
	taken,
	cwd,
	onClose,
	onAdded,
}: {
	server: McpServerHit;
	option: McpInstallOption;
	taken: string[];
	cwd: string | null;
	onClose: () => void;
	onAdded: (added: McpAdded) => void;
}) {
	const t = useT();
	const [name, setName] = useState(server.configName);
	const [values, setValues] = useState<Record<string, string>>({});
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const ids = useId();
	const nameTaken = taken.includes(name.trim());
	const missing = option.inputs.filter((i) => i.required && !i.default && !values[i.key]);
	const submit = (e: FormEvent) => {
		e.preventDefault();
		setSaving(true);
		setError(null);
		pluginsApi
			.addMcp({ server: server.name, version: server.version, option: option.id, name: name.trim(), values }, cwd)
			.then(onAdded)
			.catch((err: Error) => setError(err.message))
			.finally(() => setSaving(false));
	};
	return (
		<Modal
			open
			onOpenChange={(o) => !o && onClose()}
			title={t("plugins.mcpAddTitle", { name: server.title ?? server.name })}
			description={<WithCode text={t("plugins.mcpAddHint")} />}
			wide
		>
			<form onSubmit={submit} className="flex flex-col gap-3" data-testid="mcp-add-dialog">
				<p className="flex flex-wrap items-center gap-2 text-xs text-muted">
					<Badge>{KIND_LABEL[option.kind] ?? option.kind}</Badge>
					<code className="break-all font-mono">{option.summary}</code>
				</p>
				<label className="flex flex-col gap-1 text-sm">
					<span className="font-medium">{t("plugins.mcpName")}</span>
					<input
						value={name}
						onChange={(e) => setName(e.target.value)}
						autoCapitalize="off"
						autoCorrect="off"
						spellCheck={false}
						className={`${FIELD} font-mono`}
						data-testid="mcp-add-name"
					/>
					{nameTaken ? <span className="text-xs text-danger">{t("plugins.mcpNameTaken")}</span> : null}
				</label>
				{option.inputs.length === 0 ? <p className="text-sm text-muted">{t("plugins.mcpNoInputs")}</p> : null}
				{option.inputs.map((input, at) => {
					const field = `${ids}-input-${at}`;
					return (
						<div key={input.key} className="flex flex-col gap-1 text-sm" data-input={input.key}>
							<label htmlFor={field} className="flex flex-wrap items-center gap-1.5">
								<span className="break-all font-mono text-xs font-medium">{input.label}</span>
								<Badge>{t(KIND_KEY[input.kind])}</Badge>
								{input.required ? <Badge tone="accent">{t("plugins.mcpRequired")}</Badge> : null}
								{input.secret ? <Badge tone="warning">{t("plugins.mcpSecret")}</Badge> : null}
							</label>
							{input.description ? (
								<span id={`${field}-hint`} className="text-xs text-muted">
									{input.description}
								</span>
							) : null}
							{input.choices && input.choices.length > 0 ? (
								<Select
									id={field}
									tone="compact"
									aria-describedby={input.description ? `${field}-hint` : undefined}
									value={values[input.key] ?? ""}
									onValueChange={(v) => setValues((all) => ({ ...all, [input.key]: v }))}
									data-testid="mcp-add-input"
								>
									<option value="">{input.default ?? "—"}</option>
									{input.choices.map((c) => (
										<option key={c} value={c}>
											{c}
										</option>
									))}
								</Select>
							) : (
								<input
									id={field}
									aria-describedby={input.description ? `${field}-hint` : undefined}
									type={input.secret ? "password" : "text"}
									value={values[input.key] ?? ""}
									onChange={(e) => setValues((all) => ({ ...all, [input.key]: e.target.value }))}
									placeholder={input.default ?? input.placeholder ?? ""}
									autoComplete={input.secret ? "new-password" : "off"}
									autoCapitalize="off"
									autoCorrect="off"
									spellCheck={false}
									className={`${FIELD} font-mono`}
									data-testid="mcp-add-input"
								/>
							)}
						</div>
					);
				})}
				{error ? (
					<p role="alert" className="whitespace-pre-wrap text-sm text-danger" data-testid="mcp-add-error">
						{error}
					</p>
				) : null}
				<div className="flex flex-wrap justify-end gap-2">
					<Button onClick={onClose}>{t("common.cancel")}</Button>
					<Button
						type="submit"
						variant="primary"
						disabled={saving || !name.trim() || nameTaken || missing.length > 0}
						data-testid="mcp-add-save"
					>
						{saving ? <Spinner size={13} /> : <Plus size={13} />} {t("plugins.mcpAdd")}
					</Button>
				</div>
			</form>
		</Modal>
	);
}
