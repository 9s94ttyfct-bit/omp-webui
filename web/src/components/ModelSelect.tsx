import * as Popover from "@radix-ui/react-popover";
import { selectorProblem } from "@shared/model-config.ts";
import { Command } from "cmdk";
import { Check, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n/index.ts";
import { modelLabel } from "../lib/models.ts";
import type { ModelInfo } from "../store/live.ts";
import { cx } from "./ui.tsx";

const key = (m: ModelInfo) => `${m.provider}/${m.id}`;

/** The blank choice's row (cmdk `value`); no model is called this. */
const BLANK = "__blank__";

/**
 * A searchable chooser for the model of a role. `value` is a model selector (`provider/id`); anything omp
 * accepts that is not in the list — a web-search provider, an alias, a fallback list — can be typed and used.
 */
export function ModelSelect({
	value,
	models,
	onChange,
	label,
	testid,
	blank,
}: {
	value: string;
	/** What omp can use now; null until it has loaded. */
	models: ModelInfo[] | null;
	onChange: (selector: string) => void;
	/** The accessible name of the button. */
	label: string;
	testid?: string;
	/** When given, the list opens with this choice, which picks the blank selector (the caller's own default). */
	blank?: string;
}) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");
	/** The row the list points at (cmdk `value`): it opens on the current model, not the first row. */
	const [highlight, setHighlight] = useState("");
	const listRef = useRef<HTMLDivElement>(null);
	const current = models?.find((m) => key(m) === value);
	const shown = current ? modelLabel(current) : value || blank || t("presets.chooseModel");
	const typed = search.trim();
	const canUseTyped = typed !== "" && selectorProblem(typed) === null && !(models ?? []).some((m) => key(m) === typed);
	const groups = new Map<string, ModelInfo[]>();
	for (const m of models ?? []) groups.set(m.provider, [...(groups.get(m.provider) ?? []), m]);
	const pick = (selector: string) => {
		setOpen(false);
		setSearch("");
		if (selector !== value) onChange(selector);
	};
	// cmdk scrolls only when the highlight moves: bring the current model's row into view as the list opens.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `models` is what makes the rows exist; it is not read.
	useEffect(() => {
		if (!open) return;
		const frame = requestAnimationFrame(() => {
			const list = listRef.current;
			const row = list?.querySelector<HTMLElement>('[cmdk-item][aria-selected="true"]');
			if (list && row) {
				list.scrollTop +=
					row.getBoundingClientRect().top -
					list.getBoundingClientRect().top -
					(list.clientHeight - row.offsetHeight) / 2;
			}
		});
		return () => cancelAnimationFrame(frame);
	}, [open, models]);
	return (
		<Popover.Root
			open={open}
			onOpenChange={(o) => {
				setOpen(o);
				setSearch("");
				if (o) setHighlight(value === "" && blank ? BLANK : value);
			}}
		>
			<Popover.Trigger asChild>
				<button
					type="button"
					aria-label={`${label}: ${shown}`}
					data-testid={testid}
					className="inline-flex h-9 w-full min-w-0 items-center gap-2 rounded-xl border border-border bg-bg-soft px-3 text-left text-sm outline-none hover:bg-hover focus-visible:border-faint"
				>
					<span className="min-w-0 flex-1 truncate">{shown}</span>
					<ChevronDown size={14} className="shrink-0 text-muted" />
				</button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					align="start"
					sideOffset={6}
					className="z-50 w-[min(22rem,calc(100vw-2rem))] rounded-xl border border-border bg-surface p-1 shadow-2xl"
				>
					<Command
						label={t("presets.chooseModel")}
						className="flex max-h-80 flex-col"
						value={highlight}
						onValueChange={setHighlight}
					>
						<Command.Input
							value={search}
							onValueChange={setSearch}
							placeholder={t("presets.searchModels")}
							className="mb-1 w-full rounded-lg border border-border bg-bg-soft px-3 py-2 text-sm outline-none focus:border-faint"
						/>
						<Command.List ref={listRef} className="overflow-y-auto">
							{blank !== undefined ? (
								<Command.Item
									value={BLANK}
									keywords={[blank]}
									onSelect={() => pick("")}
									data-testid={testid ? `${testid}-blank` : undefined}
									className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm data-[selected=true]:bg-hover"
								>
									<Check size={14} className={cx("shrink-0", value === "" ? "opacity-100" : "opacity-0")} />
									<span className="min-w-0 flex-1">{blank}</span>
								</Command.Item>
							) : null}
							<Command.Empty className="p-3 text-sm text-muted">{t("presets.noModels")}</Command.Empty>
							{canUseTyped ? (
								<Command.Item
									forceMount
									value={`custom:${typed}`}
									onSelect={() => pick(typed)}
									className="cursor-pointer rounded-lg px-2 py-1.5 text-sm data-[selected=true]:bg-hover"
								>
									{t("presets.useCustom", { value: typed })}
								</Command.Item>
							) : null}
							{[...groups.entries()].map(([provider, list]) => (
								<Command.Group
									key={provider}
									heading={provider}
									className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:text-faint"
								>
									{list.map((m) => (
										<Command.Item
											key={key(m)}
											value={key(m)}
											keywords={m.name ? [m.name] : []}
											onSelect={() => pick(key(m))}
											className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm data-[selected=true]:bg-hover"
										>
											<Check size={14} className={cx("shrink-0", key(m) === value ? "opacity-100" : "opacity-0")} />
											<span className="min-w-0 flex-1 truncate">{modelLabel(m)}</span>
											<span className="max-w-32 truncate text-xs text-faint">{m.id}</span>
										</Command.Item>
									))}
								</Command.Group>
							))}
						</Command.List>
					</Command>
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
