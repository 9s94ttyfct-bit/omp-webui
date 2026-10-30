import { useT } from "../i18n/index.ts";

/**
 * The search field of the model list, on its own.
 *
 * The list is a chunk of its own and is fetched when the button is pressed, so the field is here, where it is drawn
 * at once: what is typed while the chunk is on its way is not lost, and the list is given the text when it comes.
 * `onComposition` tells when an input method begins and ends building a character in it: the list does not take
 * its place in the middle of one.
 */
export function ModelSearch({
	value,
	onChange,
	onComposition,
}: {
	value: string;
	onChange: (value: string) => void;
	onComposition: (composing: boolean) => void;
}) {
	const t = useT();
	return (
		<input
			data-testid="model-search"
			// The field takes the focus: the list's own field is not there yet, and the keys must go somewhere.
			// biome-ignore lint/a11y/noAutofocus: the field just opened by the user's own click
			autoFocus
			placeholder={t("panel.modelSearch")}
			className="mb-1 w-full rounded-lg border border-border bg-bg-soft px-3 py-2 text-sm outline-none focus:border-faint"
			value={value}
			onChange={(e) => onChange(e.target.value)}
			onCompositionStart={() => onComposition(true)}
			onCompositionEnd={() => onComposition(false)}
		/>
	);
}
