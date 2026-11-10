import { ownSession, startLive } from "../support/live.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, test } from "./fixtures.ts";

/**
 * omp's `ask` tool puts its question as one HTML form. Over RPC omp has no form to show it in, so it asks the form's
 * fields one at a time (an `editor` for a textarea, a `select` for a radio group), each titled with the field's label:
 * what the form says around them (why, the steps, the command to run) was in none of those dialogs, and the person saw
 * a lone empty box. The page reads it from the running `ask` call and shows it, as text, with each of the fields. The
 * frames are pushed: no model is called.
 */

const FORM = `<form>
<p>I need this Mac's own readings. Run <b>one command</b> there.</p>
<ol><li>Open Terminal.</li><li>Paste the line below and press Return.</li></ol>
<pre>sw_vers; sysctl hw.pagesize</pre>
<script>window.__ran = true</script>
<img src="x" onerror="window.__ran = true">
<label>The output <textarea name="output" rows="4"></textarea></label>
</form>`;

test("a field of an ask form is shown with what the form says around it, as text, and nothing of it runs", async ({
	page,
}) => {
	ownSession(0x5f00, "Ask form context");
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, "Ask form context", "ask-form-context-1");
	tap.push({
		t: "frame",
		liveId,
		frame: { type: "tool_execution_start", toolCallId: "ask-1", toolName: "ask", args: { html: FORM } },
	});
	tap.push({
		t: "frame",
		liveId,
		frame: { type: "extension_ui_request", id: "field-1", method: "editor", title: "The output" },
	});

	const request = page.getByTestId("ui-request");
	await expect(request).toContainText("The output");
	const context = request.getByTestId("ask-form-context");
	await expect(context.locator("p")).toHaveText([
		"I need this Mac's own readings. Run one command there.",
		"• Open Terminal.",
		"• Paste the line below and press Return.",
	]);
	await expect(context.locator("pre")).toHaveText("sw_vers; sysctl hw.pagesize");
	// The label is the dialog's title, not said twice; markup and scripts are not carried over.
	await expect(context).not.toContainText("The output");
	await expect(context.locator("img, script, b")).toHaveCount(0);
	expect(await page.evaluate(() => (window as unknown as { __ran?: boolean }).__ran)).toBeUndefined();

	// Once the ask call is over, a dialog of something else has no such words.
	tap.push({
		t: "frame",
		liveId,
		frame: { type: "extension_ui_request", id: "field-1-cancel", method: "cancel", targetId: "field-1" },
	});
	tap.push({
		t: "frame",
		liveId,
		frame: {
			type: "tool_execution_end",
			toolCallId: "ask-1",
			toolName: "ask",
			result: { content: [] },
			isError: false,
		},
	});
	tap.push({
		t: "frame",
		liveId,
		frame: { type: "extension_ui_request", id: "other-1", method: "input", title: "Something else" },
	});
	await expect(request).toContainText("Something else");
	await expect(request.getByTestId("ask-form-context")).toHaveCount(0);
});
