import { useId } from "react";
import { useShallow } from "zustand/react/shallow";
import "../i18n/later.ts";
import { type MessageKey, useT } from "../i18n/index.ts";
import { applyPalette, PALETTES, type Palette } from "../lib/theme.ts";
import { useApp } from "../store/app.ts";
import { cx } from "./ui.tsx";

const NAMES = {
	claude: ["pages.settingsPaletteClaude", "pages.settingsPaletteClaudeDesc"],
	chatgpt: ["pages.settingsPaletteChatgpt", "pages.settingsPaletteChatgptDesc"],
	terminal: ["pages.settingsPaletteTerminal", "pages.settingsPaletteTerminalDesc"],
	omp: ["pages.settingsPaletteOmp", "pages.settingsPaletteOmpDesc"],
	hermes: ["pages.settingsPaletteHermes", "pages.settingsPaletteHermesDesc"],
} as const satisfies Record<Palette, readonly [MessageKey, MessageKey]>;

/**
 * A miniature of the app in one palette and one mode. The tile carries the palette itself (`data-palette`, and `dark`
 * for the dark mode), so its colours, corners and type are the palette's own whatever the page around it is showing.
 */
function Tile({ palette, dark }: { palette: Palette; dark: boolean }) {
	return (
		<span
			data-palette={palette}
			data-mode={dark ? "dark" : "light"}
			className={cx("flex h-14 min-w-0 flex-1 overflow-hidden rounded-lg border border-border bg-bg", dark && "dark")}
			aria-hidden="true"
		>
			<span className="w-4 shrink-0 border-r border-border bg-bg-soft" />
			<span className="flex min-w-0 flex-1 flex-col gap-1 p-1.5">
				<span className="ml-auto h-2.5 w-8 rounded-md bg-bubble" />
				<span className="h-1.5 w-10 rounded-full bg-fg" />
				<span className="h-1.5 w-7 rounded-full bg-muted" />
				<span className="mt-auto flex items-center justify-between gap-1">
					<span className="h-2.5 flex-1 rounded-md border border-border bg-surface" />
					<span className="h-2.5 w-2.5 shrink-0 rounded-full bg-accent" />
				</span>
			</span>
		</span>
	);
}

/** Settings › Appearance › Palette: which brand's look the app wears, apart from light / dark / system. */
export function PalettePicker() {
	const t = useT();
	const heading = useId();
	const { colorPalette, set } = useApp(useShallow((s) => ({ colorPalette: s.colorPalette, set: s.set })));
	return (
		<div className="mt-5">
			<h3 id={heading} className="text-sm font-medium">
				{t("pages.settingsPalette")}
			</h3>
			<p className="mb-3 mt-0.5 text-xs text-muted">{t("pages.settingsPaletteHint")}</p>
			<fieldset
				aria-labelledby={heading}
				className="grid grid-cols-2 gap-2 sm:grid-cols-3"
				data-testid="palette-picker"
			>
				{PALETTES.map((id) => {
					const [name, description] = NAMES[id];
					return (
						<label
							key={id}
							data-testid={`palette-${id}`}
							className={cx(
								"flex cursor-pointer flex-col gap-2 rounded-xl border p-2 text-sm has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent",
								colorPalette === id ? "border-accent bg-accent-soft" : "border-border hover:bg-hover",
							)}
						>
							<input
								type="radio"
								name="palette"
								value={id}
								className="sr-only"
								checked={colorPalette === id}
								onChange={() => {
									applyPalette(id);
									set({ colorPalette: id });
								}}
							/>
							<span className="flex gap-1">
								<Tile palette={id} dark={false} />
								<Tile palette={id} dark />
							</span>
							<span className="px-0.5">
								<span className="block font-medium">{t(name)}</span>
								<span className="block text-xs text-muted">{t(description)}</span>
							</span>
						</label>
					);
				})}
			</fieldset>
		</div>
	);
}
