/**
 * A file dropped where nothing takes it makes the browser open it, and in the macOS app that replaces the UI with the
 * file (the window has no Back button). The composer takes drops of its own, which it handles — and prevents — first;
 * anything still not handled by the time the event reaches the document is refused here. Text dragged into a text
 * field is the browser's own business, so only a drag that carries files is refused there.
 */
export function guardDrops(doc: Document = document): () => void {
	const refuse = (e: DragEvent) => {
		if (e.defaultPrevented) return;
		const files = e.dataTransfer?.types.includes("Files") ?? false;
		const field =
			e.target instanceof Element &&
			e.target.closest("input, textarea, [contenteditable]:not([contenteditable=false])");
		if (field && !files) return;
		e.preventDefault();
		if (e.type === "dragover" && e.dataTransfer) e.dataTransfer.dropEffect = "none";
	};
	doc.addEventListener("dragover", refuse);
	doc.addEventListener("drop", refuse);
	return () => {
		doc.removeEventListener("dragover", refuse);
		doc.removeEventListener("drop", refuse);
	};
}
