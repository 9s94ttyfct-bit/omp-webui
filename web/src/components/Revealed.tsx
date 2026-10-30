import { useT } from "../i18n/index.ts";
import { codePoint, marker, pieces } from "../lib/invisible.ts";

/**
 * `text`, with each character that does not show (or that changes how text shows: a right-to-left override, a zero-width
 * space, an escape) written out as a marker, so that what is read is what is there. See `lib/invisible.ts`.
 */
export function Revealed({ text }: { text: string }) {
	const t = useT();
	return (
		<>
			{pieces(text).map((piece, i) =>
				typeof piece === "string" ? (
					piece
				) : (
					<span
						// biome-ignore lint/suspicious/noArrayIndexKey: the pieces of one text, never reordered
						key={i}
						data-testid="invisible-char"
						title={t("panel.reqInvisible", { code: codePoint(piece.code) })}
						className="mx-px rounded bg-warning/15 px-1 font-sans text-xs font-semibold whitespace-nowrap text-warning"
					>
						{marker(piece.code)}
					</span>
				),
			)}
		</>
	);
}
