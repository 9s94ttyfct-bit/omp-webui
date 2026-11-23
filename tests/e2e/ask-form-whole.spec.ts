import { ownSession, startLive } from "../support/live.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, test } from "./fixtures.ts";

/**
 * omp 19.1.0 and later send the `ask` tool's HTML form whole (`extension_ui_request` `form`) and wait for its data: the page
 * draws it, checks it on Submit by omp's rules, and answers `{ data }` keyed by the controls' names, or a cancel. The frames
 * are pushed: no model is called. (That omp takes this data is `tests/contract/dialogs.test.ts`'s.)
 */

const FORM = `<form>
<p>Sessions live in memory and are <strong>lost</strong> on restart.</p>
<pre>ompw restart --all</pre>
<fieldset><legend>Session store</legend>
<label><input type="radio" name="store" value="sqlite"> SQLite: one file</label>
<label><input type="radio" name="store" value="redis" checked> Redis: shared</label>
</fieldset>
<p>What to watch</p>
<label><input type="checkbox" name="watch" value="cpu" checked> CPU</label>
<label><input type="checkbox" name="watch" value="net"> Network</label>
<label>Lifetime (days) <input type="number" name="ttl" value="30" min="1"></label>
<label>Owner <input type="text" name="owner" required></label>
<label>Region <select name="region"><option value="us">US</option><option value="eu" selected>EU</option></select></label>
<input type="hidden" name="kind" value="store">
</form>`;

const sentResponses = (sent: unknown[]) =>
	sent.flatMap((m) =>
		typeof m === "object" && m !== null && (m as { t?: string }).t === "ui_response"
			? [(m as { response: Record<string, unknown> }).response]
			: [],
	);

test("a whole ask form is drawn, checked on Submit, and answered with its data", async ({ page }) => {
	ownSession(0x5f20, "Ask form whole");
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, "Ask form whole", "ask-form-whole-1");
	tap.push({
		t: "frame",
		liveId,
		frame: { type: "extension_ui_request", id: "f-1", method: "form", html: FORM, timeout: 60_000 },
	});
	const request = page.getByTestId("ui-request");
	await expect(request).toHaveAttribute("data-method", "form");
	await expect(request).toContainText("omp has a question");
	const form = request.getByTestId("ask-form");
	// What the form says around its fields, and its fields as it fills them in.
	await expect(form).toContainText("Sessions live in memory and are lost on restart.");
	await expect(form.locator("strong")).toHaveText("lost");
	await expect(form.locator("pre")).toHaveText("ompw restart --all");
	await expect(form.locator("legend")).toHaveText("Session store");
	await expect(form.getByRole("radio", { name: "Redis: shared" })).toBeChecked();
	await expect(form.getByRole("checkbox", { name: "CPU" })).toBeChecked();
	await expect(form.getByRole("spinbutton", { name: "Lifetime (days)" })).toHaveValue("30");
	await expect(form.getByRole("combobox", { name: "Region" })).toHaveValue("1");
	await expect(request.getByTestId("ui-request-countdown")).toContainText("omp submits the form as first filled in");

	// A required field left empty: nothing is sent, and the field says why.
	await form.getByRole("button", { name: "Submit answers" }).click();
	await expect(form.getByTestId("form-field-error")).toHaveText("Required");
	await expect(form.getByRole("textbox", { name: "Owner" })).toBeFocused();
	expect(sentResponses(tap.sent)).toEqual([]);

	await form.getByRole("textbox", { name: "Owner" }).fill("ops");
	await expect(form.getByTestId("form-field-error")).toHaveCount(0);
	await form.getByRole("radio", { name: "SQLite: one file" }).check();
	await form.getByRole("checkbox", { name: "Network" }).check();
	// The group's Other, named by the question before it: its words join the checked values.
	await expect(form.getByRole("group", { name: "Session store" }).getByRole("radio")).toHaveCount(2);
	await form.getByRole("textbox", { name: "Other answer for: What to watch" }).fill("Disk I/O");
	await form.getByRole("spinbutton", { name: "Lifetime (days)" }).fill("7");
	await form.getByRole("button", { name: "Submit answers" }).click();
	await expect(request).toHaveCount(0);
	expect(sentResponses(tap.sent)).toEqual([
		{
			id: "f-1",
			data: { store: "sqlite", watch: ["cpu", "net", "Disk I/O"], ttl: 7, owner: "ops", region: "eu" },
		},
	]);
});

test("Skip cancels a whole ask form", async ({ page }) => {
	ownSession(0x5f21, "Ask form skip");
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, "Ask form skip", "ask-form-whole-2");
	tap.push({
		t: "frame",
		liveId,
		frame: { type: "extension_ui_request", id: "f-2", method: "form", html: FORM },
	});
	const request = page.getByTestId("ui-request");
	await request.getByRole("button", { name: "Skip" }).click();
	await expect(request).toHaveCount(0);
	expect(sentResponses(tap.sent)).toEqual([{ id: "f-2", cancelled: true }]);
});

test("a control named __proto__ is sent as a key like any other", async ({ page }) => {
	ownSession(0x5f22, "Ask form proto");
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, "Ask form proto", "ask-form-whole-3");
	tap.push({
		t: "frame",
		liveId,
		frame: {
			type: "extension_ui_request",
			id: "f-3",
			method: "form",
			html: '<form><label>Odd name <input name="__proto__" value="kept"></label></form>',
		},
	});
	const request = page.getByTestId("ui-request");
	await request.getByRole("button", { name: "Submit answers" }).click();
	await expect(request).toHaveCount(0);
	const sent = tap.sent.map((m) => JSON.stringify(m)).filter((m) => m.includes('"ui_response"'));
	expect(sent).toHaveLength(1);
	expect(sent[0]).toContain('"data":{"__proto__":"kept"}');
});
