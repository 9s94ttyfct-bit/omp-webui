import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Select } from "../../../web/src/components/Select.tsx";
import { Modal } from "../../../web/src/components/ui.tsx";
import "./harness.css";

/**
 * The app's `Select` alone on a page (`tests/e2e/select-component.spec.ts` builds it with Vite): a list with a blank
 * value, a disabled option and a group; a disabled select; one in a box that clips what overflows it; one in a dialog.
 * Each select's value and every change it reported are written beside it, for the spec to read.
 */

// The choices are written in place, as at every call site: `Select` reads its `<option>`s from its children.
const FRUITS = (
	<>
		<option value="">None</option>
		<option value="apple">Apple</option>
		<option value="banana">Banana</option>
		<option value="cherry" disabled>
			Cherry
		</option>
		<option value="date">Date</option>
		<optgroup label="Citrus">
			<option value="lemon">Lemon</option>
			<option value="lime">Lime</option>
		</optgroup>
	</>
);

function Fruit({ id, initial = "banana", disabled }: { id: string; initial?: string; disabled?: boolean }) {
	const [value, setValue] = useState(initial);
	const [changes, setChanges] = useState<string[]>([]);
	return (
		<div className="space-y-1">
			<label className="block text-sm">
				<span className="mb-1 block text-muted">Fruit {id}</span>
				<Select
					data-testid={id}
					value={value}
					disabled={disabled}
					onValueChange={(next) => {
						setValue(next);
						setChanges((all) => [...all, next]);
					}}
				>
					{FRUITS}
				</Select>
			</label>
			<output data-testid={`${id}-changes`} className="block text-xs text-faint">
				{changes.map((c) => `[${c}]`).join("")}
			</output>
		</div>
	);
}

function Harness() {
	const [dialog, setDialog] = useState(false);
	return (
		<main className="mx-auto max-w-md space-y-6 p-6">
			<Fruit id="fruit" />
			<Fruit id="off" disabled />
			<div data-testid="clip" className="h-24 overflow-hidden rounded-xl border border-border p-3">
				<Fruit id="clipped" initial="apple" />
			</div>
			<button type="button" data-testid="open-dialog" onClick={() => setDialog(true)}>
				Open dialog
			</button>
			<Modal open={dialog} onOpenChange={setDialog} title="A dialog">
				<Fruit id="in-dialog" initial="date" />
			</Modal>
		</main>
	);
}

const root = document.getElementById("root");
if (root)
	createRoot(root).render(
		<StrictMode>
			<Harness />
		</StrictMode>,
	);
