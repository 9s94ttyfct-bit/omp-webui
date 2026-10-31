import * as Picker from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { Children, Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { useMediaQuery } from "../lib/media.ts";
import { cx } from "./ui.tsx";

/**
 * Where a select is the system's own picker: a touch screen (a phone, a tablet without a trackpad), where iOS shows its
 * wheel and Android its list. It is the query the rest of the page knows a touch screen by (`pointer-coarse:`, the 16px
 * fields and the chip's sizer of index.css), so the two never disagree. Anywhere else the list is the app's own.
 */
export const NATIVE_PICKER_QUERY = "(pointer: coarse)";

/**
 * How each kind of select looks. The chevron is the app's own (a lucide `ChevronDown`), the same over the app's own
 * control and over the system's `<select>`, which draws none: the browser's own chevron is bolder than the thin ones of
 * the buttons beside it and moves with the OS.
 */
const TONES = {
	/** A form field: the box of the text fields and of the model picker beside it. */
	field: {
		wrap: "relative block",
		control:
			"h-9 w-full rounded-xl border border-border bg-bg-soft pr-9 pl-3 text-sm outline-none enabled:hover:bg-hover focus:border-faint data-[state=open]:border-faint",
		chevron: "right-3 text-muted",
		size: 14,
		list: "text-sm",
	},
	/** A small filter above a list, with the text of the field over it. */
	compact: {
		wrap: "relative block",
		control:
			"w-full rounded-lg border border-border bg-surface py-1.5 pr-8 pl-2.5 text-xs text-muted outline-none enabled:hover:bg-hover focus-visible:border-faint data-[state=open]:border-faint",
		chevron: "right-2.5 text-muted",
		size: 12,
		list: "text-xs",
	},
	/**
	 * A control among the chips of the composer: no box, as wide as what it shows, the chevron right after it. The control
	 * is laid over the words that size it (`fit`) instead of sharing their cell: WebKit counts a select's longest option
	 * toward the width of a grid cell whatever its `w-0`, which left a gap of a few words after "Off".
	 */
	chip: {
		wrap: "relative inline-grid",
		control: "absolute inset-0 size-full cursor-pointer bg-transparent pr-4 outline-none",
		chevron: "right-0",
		size: 12,
		list: "text-xs",
	},
	/**
	 * No look of its own: an invisible control over the whole of what holds it (an icon button of the sidebar). The holder
	 * draws the icon and, with `has-[:focus-visible]`, the focus.
	 */
	overlay: {
		wrap: "absolute inset-0",
		control: "absolute inset-0 size-full cursor-pointer appearance-none rounded-[inherit] opacity-0 outline-none",
		chevron: null,
		size: 0,
		list: "text-sm",
	},
} as const;

export type SelectProps = {
	/** The value of the chosen `<option>`. */
	value: string;
	/** A choice was made: the value of the `<option>` chosen. */
	onValueChange: (value: string) => void;
	/** `<option>` elements (each with a `value`, a text and optionally `disabled`), optionally in `<optgroup label>`s. */
	children: ReactNode;
	disabled?: boolean;
	id?: string;
	title?: string;
	"aria-label"?: string;
	"aria-labelledby"?: string;
	"aria-describedby"?: string;
	"data-testid"?: string;
	/** Layout of the control as a whole (width, shrink, margin); how it looks comes from `tone`. */
	className?: string;
} & (
	| { tone?: "field" | "compact" | "overlay"; fit?: never }
	// A chip is as wide as the words it shows, which a `<select>` cannot be (it is as wide as its longest option): `fit`
	// is what it shows now, set invisibly in the same cell to give the control its width.
	| { tone: "chip"; fit: ReactNode }
);

/** One choice of a select, as its `<option>` says it. */
export type SelectChoice = { value: string; label: ReactNode; text: string; disabled: boolean };
/** A select's choices in their order: a choice, or a labelled group of them (`<optgroup>`). */
export type SelectEntry = SelectChoice | { group: string; choices: SelectChoice[]; disabled: boolean };

/** The words of a node, as an `<option>` reads its text (its value when it has none, and what type-ahead matches). */
function textOf(node: ReactNode): string {
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(textOf).join("");
	if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
	return "";
}

type OptionProps = { value?: string | number; disabled?: boolean; children?: ReactNode };
type GroupProps = { label?: string; disabled?: boolean; children?: ReactNode };

/** The `<option>`s of `children`, through arrays, fragments and `<optgroup>`s; anything else is not a choice. */
export function readChoices(children: ReactNode): SelectEntry[] {
	const entries: SelectEntry[] = [];
	for (const child of Children.toArray(children)) {
		if (!isValidElement(child)) continue;
		if (child.type === Fragment) {
			entries.push(...readChoices((child as ReactElement<{ children?: ReactNode }>).props.children));
		} else if (child.type === "option") {
			const { value, disabled, children: label } = (child as ReactElement<OptionProps>).props;
			const text = textOf(label);
			entries.push({ value: value === undefined ? text : String(value), label, text, disabled: !!disabled });
		} else if (child.type === "optgroup") {
			const { label = "", disabled, children: options } = (child as ReactElement<GroupProps>).props;
			const choices = readChoices(options).flatMap((e) => ("group" in e ? e.choices : [e]));
			entries.push({ group: label, choices, disabled: !!disabled });
		}
	}
	return entries;
}

// Radix keeps "" for "nothing chosen", which is a value an `<option>` may have (an "All" or "Not set" first choice):
// every value is carried with a prefix, so "" is one too.
const encode = (value: string) => `=${value}`;
const decode = (key: string) => key.slice(1);

/**
 * The app's select, the one every choice from a list in the page uses. On a computer the list is the app's own: a
 * listbox in the palette's colours under the control, with the keyboard of a select (arrows, Home/End, type-ahead,
 * Enter/Space, Esc), drawn over everything (it is portalled) so no dialog or scrolled card cuts it. On a touch screen
 * (`NATIVE_PICKER_QUERY`) it is the system's `<select>`, so iOS shows its wheel and Android its list.
 *
 * Its choices are written as a `<select>`'s are (`<option value>` and `<optgroup label>`), and `data-value` says the
 * value chosen on either control.
 */
export function Select({
	tone = "field",
	fit,
	className,
	children,
	value,
	onValueChange,
	disabled,
	...rest
}: SelectProps) {
	const look = TONES[tone];
	const native = useMediaQuery(NATIVE_PICKER_QUERY);
	return (
		<span className={cx(look.wrap, "has-[:disabled]:opacity-50", className)}>
			{fit === undefined ? null : (
				<span aria-hidden data-select-sizer className="invisible col-start-1 row-start-1 whitespace-nowrap pr-4">
					{fit}
				</span>
			)}
			{native ? (
				<select
					{...rest}
					data-value={value}
					value={value}
					disabled={disabled}
					onChange={(e) => onValueChange(e.target.value)}
					className={cx("appearance-none", look.control)}
				>
					{children}
				</select>
			) : (
				<AppPicker look={look} value={value} onValueChange={onValueChange} disabled={disabled} rest={rest}>
					{children}
				</AppPicker>
			)}
			{look.chevron === null ? null : (
				<ChevronDown
					size={look.size}
					aria-hidden
					className={cx("pointer-events-none absolute top-1/2 -translate-y-1/2", look.chevron)}
				/>
			)}
		</span>
	);
}

const ITEM =
	"relative flex min-h-8 cursor-default select-none items-center rounded-lg py-1.5 pr-3 pl-8 outline-none data-[disabled]:pointer-events-none data-[highlighted]:bg-hover data-[disabled]:opacity-50";

/** The list of a computer: Radix's select, its trigger in the place and look of the `<select>` it stands for. */
function AppPicker({
	look,
	value,
	onValueChange,
	disabled,
	rest,
	children,
}: {
	look: (typeof TONES)[keyof typeof TONES];
	value: string;
	onValueChange: (value: string) => void;
	disabled?: boolean;
	rest: Omit<SelectProps, "value" | "onValueChange" | "children" | "disabled" | "className" | "tone" | "fit">;
	children: ReactNode;
}) {
	const entries = readChoices(children);
	const choices = entries.flatMap((e) => ("group" in e ? e.choices : [e]));
	const shown = choices.find((c) => c.value === value);
	const item = (c: SelectChoice, groupDisabled = false) => (
		<Picker.Item
			key={c.value}
			value={encode(c.value)}
			disabled={c.disabled || groupDisabled}
			textValue={c.text}
			data-value={c.value}
			className={ITEM}
		>
			<Picker.ItemIndicator className="absolute left-2.5 inline-flex">
				<Check size={14} aria-hidden />
			</Picker.ItemIndicator>
			<Picker.ItemText>{c.label}</Picker.ItemText>
		</Picker.Item>
	);
	return (
		<Picker.Root value={encode(value)} onValueChange={(key) => onValueChange(decode(key))} disabled={disabled}>
			<Picker.Trigger
				{...rest}
				data-value={value}
				className={cx("block appearance-none truncate text-left disabled:cursor-default", look.control)}
			>
				<Picker.Value>{shown?.label}</Picker.Value>
			</Picker.Trigger>
			<Picker.Portal>
				<Picker.Content
					position="popper"
					sideOffset={4}
					collisionPadding={8}
					className={cx(
						"z-50 max-h-[min(var(--radix-select-content-available-height),22rem)] min-w-[max(var(--radix-select-trigger-width),8rem)] max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border border-border bg-surface text-fg shadow-2xl",
						look.list,
					)}
				>
					<Picker.ScrollUpButton className="flex h-6 cursor-default items-center justify-center text-muted">
						<ChevronUp size={14} aria-hidden />
					</Picker.ScrollUpButton>
					<Picker.Viewport className="p-1">
						{entries.map((e) =>
							"group" in e ? (
								<Picker.Group key={`group:${e.group}`}>
									<Picker.Label className="px-2.5 pt-2 pb-1 text-xs font-medium text-faint">{e.group}</Picker.Label>
									{e.choices.map((c) => item(c, e.disabled))}
								</Picker.Group>
							) : (
								item(e)
							),
						)}
					</Picker.Viewport>
					<Picker.ScrollDownButton className="flex h-6 cursor-default items-center justify-center text-muted">
						<ChevronDown size={14} aria-hidden />
					</Picker.ScrollDownButton>
				</Picker.Content>
			</Picker.Portal>
		</Picker.Root>
	);
}
