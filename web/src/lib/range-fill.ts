/**
 * Every `<input type="range">` draws its groove filled up to the value (index.css, "Range sliders"), and CSS cannot read
 * a value: this keeps the `--range-fill` custom property of each one (the filled share of the groove) in step with it.
 * Dragging and the keyboard fire `input`; a value set by the app (React controlled inputs write the `value` attribute
 * too) and a slider that appears later are caught by the observer.
 */

function fill(input: HTMLInputElement): void {
	const min = Number(input.min || 0);
	const max = Number(input.max || 100);
	const share = max > min ? ((Number(input.value) - min) / (max - min)) * 100 : 0;
	input.style.setProperty("--range-fill", `${Math.min(100, Math.max(0, share))}%`);
}

const isRange = (node: unknown): node is HTMLInputElement => node instanceof HTMLInputElement && node.type === "range";

function fillWithin(node: Node): void {
	if (isRange(node)) fill(node);
	if (node instanceof Element)
		for (const input of node.querySelectorAll<HTMLInputElement>('input[type="range"]')) fill(input);
}

/** Start keeping every range input's fill current. Once, at startup. */
export function keepRangeFill(): void {
	document.addEventListener("input", (e) => isRange(e.target) && fill(e.target), true);
	new MutationObserver((records) => {
		for (const record of records) {
			if (record.type === "attributes") {
				if (isRange(record.target)) fill(record.target);
				continue;
			}
			for (const added of record.addedNodes) fillWithin(added);
		}
	}).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["value", "min", "max"] });
	fillWithin(document.documentElement);
}
