import * as Primitive from "@radix-ui/react-switch";
import { cx, Spinner } from "./ui.tsx";

/**
 * An on/off switch for one thing (a skill, a plugin). `label` names what it switches, for a screen reader: the
 * visible row says the rest. While `busy` it shows a spinner instead of the thumb and does not take clicks. Off, the
 * track's edge is `--faint`, which every palette holds to 4.5:1 on its surfaces: the `--border` it had was 1.2–2:1 on the
 * card, under the 3:1 a control's outline needs (WCAG 1.4.11, #787), and an off switch read as nothing there.
 */
export function Switch({
	checked,
	onCheckedChange,
	label,
	disabled,
	busy,
	title,
	...rest
}: {
	checked: boolean;
	onCheckedChange: (on: boolean) => void;
	label: string;
	disabled?: boolean;
	busy?: boolean;
	title?: string;
	"data-testid"?: string;
}) {
	return (
		<Primitive.Root
			checked={checked}
			onCheckedChange={onCheckedChange}
			disabled={disabled || busy}
			aria-label={label}
			aria-busy={busy || undefined}
			title={title}
			className={cx(
				"relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-faint transition-colors",
				"bg-hover data-[state=checked]:border-transparent data-[state=checked]:bg-accent",
				"disabled:cursor-not-allowed disabled:opacity-50",
			)}
			{...rest}
		>
			<Primitive.Thumb
				className={cx(
					"flex h-4 w-4 items-center justify-center rounded-full bg-white shadow transition-transform",
					"translate-x-0.5 data-[state=checked]:translate-x-[18px]",
				)}
			>
				{busy ? <Spinner size={10} className="text-muted" /> : null}
			</Primitive.Thumb>
		</Primitive.Root>
	);
}
