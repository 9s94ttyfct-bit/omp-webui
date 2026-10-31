import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Fragment, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

// The page's modules read localStorage as they load: they are loaded after the stubs are in place.
installGlobals();
const { NATIVE_PICKER_QUERY, readChoices, Select } = await import("../../web/src/components/Select.tsx");

/**
 * The app's `Select`: its choices are read from `<option>`s and `<optgroup>`s as a `<select>` reads them, and it is the
 * system's `<select>` where `NATIVE_PICKER_QUERY` matches (a touch screen) and the app's own combobox anywhere else.
 * How the list behaves in a browser (keyboard, clicks, a dialog, a phone) is `tests/e2e/select-component.spec.ts`.
 */

const globals = globalThis as Record<string, unknown>;
const realMatchMedia = globals.matchMedia;
/** The media queries that match on the page being "rendered". */
let matching: string[] = [];

beforeAll(() => {
	installGlobals();
	globals.matchMedia = (query: string) => ({
		matches: matching.includes(query),
		addEventListener() {},
		removeEventListener() {},
	});
});
afterEach(() => {
	matching = [];
});
afterAll(() => {
	globals.matchMedia = realMatchMedia;
	restoreGlobals();
});

const fruits = (): ReactNode => [
	<option key="none" value="">
		None
	</option>,
	[
		<option key="apple" value="apple">
			Apple
		</option>,
		<option key="cherry" value="cherry" disabled>
			Cherry
		</option>,
	],
	<Fragment key="more">
		<option value="date">Date</option>
		{null}
		{false}
	</Fragment>,
	<optgroup key="citrus" label="Citrus">
		<option value="lemon">Lemon</option>
		<option value="lime">Lime</option>
	</optgroup>,
];

const render = (value: string, disabled = false) =>
	renderToString(
		<Select value={value} disabled={disabled} onValueChange={() => {}} aria-label="Fruit" data-testid="fruit">
			{fruits()}
		</Select>,
	);

test("the choices are the <option>s, through arrays, fragments and groups, with their disabled ones", () => {
	expect(readChoices(fruits())).toEqual([
		{ value: "", label: "None", text: "None", disabled: false },
		{ value: "apple", label: "Apple", text: "Apple", disabled: false },
		{ value: "cherry", label: "Cherry", text: "Cherry", disabled: true },
		{ value: "date", label: "Date", text: "Date", disabled: false },
		{
			group: "Citrus",
			disabled: false,
			choices: [
				{ value: "lemon", label: "Lemon", text: "Lemon", disabled: false },
				{ value: "lime", label: "Lime", text: "Lime", disabled: false },
			],
		},
	]);
});

test("an option without a value has its text for one, as a <select>'s does; text of several parts is joined", () => {
	const level = "high";
	const [choice] = readChoices(<option>Auto ({level})</option>);
	expect(choice).toEqual({
		value: "Auto (high)",
		label: ["Auto (", "high", ")"],
		text: "Auto (high)",
		disabled: false,
	});
});

test("on a computer it is the app's combobox, showing the chosen option's text, with no system <select>", () => {
	const html = render("apple");
	expect(html).toMatch(/<button[^>]*role="combobox"/);
	expect(html).toMatch(/<button[^>]*aria-label="Fruit"/);
	expect(html).toMatch(/<button[^>]*data-testid="fruit"/);
	expect(html).toMatch(/<button[^>]*data-value="apple"/);
	expect(html).toMatch(/aria-expanded="false"/);
	expect(html).toContain(">Apple<");
	expect(html).not.toMatch(/<select(?![^>]*aria-hidden)/);
});

test("a blank value is a value like any other: its option's text is shown", () => {
	const html = render("");
	expect(html).toMatch(/<button[^>]*data-value=""/);
	expect(html).toContain(">None<");
});

test("on a touch screen it is the system's <select>, with every option, the disabled one and the group", () => {
	matching = [NATIVE_PICKER_QUERY];
	const html = render("date");
	expect(html).not.toContain('role="combobox"');
	expect(html).toMatch(/<select[^>]*aria-label="Fruit"/);
	expect(html).toMatch(/<select[^>]*data-testid="fruit"/);
	expect(html).toMatch(/<select[^>]*data-value="date"/);
	expect(html).toMatch(/<option value="date" selected="">Date<\/option>/);
	expect(html).toMatch(/<option value="cherry" disabled="">Cherry<\/option>/);
	expect(html).toMatch(/<optgroup label="Citrus"><option value="lemon">Lemon<\/option>/);
});

test("a disabled select is disabled on either control", () => {
	expect(render("apple", true)).toMatch(/<button[^>]*disabled=""/);
	matching = [NATIVE_PICKER_QUERY];
	expect(render("apple", true)).toMatch(/<select[^>]*disabled=""/);
});
