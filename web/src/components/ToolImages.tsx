import { useState } from "react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import type { ResultImage } from "../lib/messages.ts";
import { Modal } from "./ui.tsx";

/** The images a tool returned, as thumbnails; one opens at full size. */
export function ToolImages({ images, tool }: { images: ResultImage[]; tool: string }) {
	const t = useT();
	const [viewing, setViewing] = useState<number | null>(null);
	const current = viewing === null ? undefined : images[viewing];
	return (
		<div className="flex flex-wrap gap-2" data-testid="tool-images">
			{images.map((img, i) => (
				<button
					// biome-ignore lint/suspicious/noArrayIndexKey: a result's images have no ids and never change order
					key={i}
					type="button"
					data-testid="tool-image"
					aria-label={t("chat.toolImageOpen", { n: i + 1 })}
					className="overflow-hidden rounded-lg border border-border bg-bg hover:border-accent"
					onClick={() => setViewing(i)}
				>
					<img
						src={img.src}
						alt={t("chat.toolImageAlt", { n: i + 1, tool })}
						className="block max-h-40 max-w-full object-contain"
					/>
				</button>
			))}
			<Modal open={current !== undefined} onOpenChange={(o) => !o && setViewing(null)} title={tool} wide>
				{current ? (
					<img
						src={current.src}
						alt={t("chat.toolImageAlt", { n: (viewing ?? 0) + 1, tool })}
						className="mx-auto block max-h-[60vh] max-w-full object-contain"
						data-testid="tool-image-full"
					/>
				) : null}
			</Modal>
		</div>
	);
}
