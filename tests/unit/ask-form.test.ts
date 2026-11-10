import { expect, test } from "bun:test";
import { formQuestions } from "../../server/ask-form.ts";

/** An `ask` form read as the questions an unattended conversation files for the person (#646). */

test("each named field is one question, with its legend or label, its options and the checked one recommended", () => {
	const html = `<form>
  <p>Sessions live in memory and are lost on restart.</p>
  <fieldset>
    <legend>Session store</legend>
    <label><input type="radio" name="store" value="sqlite"> SQLite: one file</label>
    <label><input type="radio" name="store" value="redis" checked> Redis: shared</label>
  </fieldset>
  <label>Session lifetime (days) <input type="number" name="ttl" value="30"></label>
  <label for="n">Notes</label><textarea id="n" name="notes"></textarea>
  <select name="db" multiple><option>Postgres</option><option selected>SQLite</option></select>
  <input type="hidden" name="token" value="x">
  <ul><li>Step <b>one</b></li></ul>
</form>`;
	const context = "Sessions live in memory and are lost on restart.\nStep one";
	expect(formQuestions(html)).toEqual([
		{
			question: "Session store",
			header: context,
			options: [{ label: "SQLite: one file" }, { label: "Redis: shared" }],
			recommended: 1,
		},
		{ question: "Session lifetime (days)", header: context, options: [] },
		{ question: "Notes", header: context, options: [] },
		{ question: "db", header: context, options: [{ label: "Postgres" }, { label: "SQLite" }], multi: true },
	]);
});

test("a field with no words is asked by its placeholder, then its name; an option with no label by its value", () => {
	const html = `<form><input name="city" placeholder="Which city?"><input name="zip">
<input type="checkbox" name="ok" value="yes"></form>`;
	expect(formQuestions(html)).toEqual([
		{ question: "Which city?", header: "", options: [] },
		{ question: "zip", header: "", options: [] },
		{ question: "ok", header: "", options: [{ label: "yes" }], multi: true },
	]);
});

test("a form's text inside a label or legend is the field's, and markup that runs is not read", () => {
	const html = `<form><script>alert(1)</script><fieldset><legend><p>Pick</p></legend>
<label><input type="radio" name="a" value="1"> <span>One</span></label></fieldset></form>`;
	expect(formQuestions(html)).toEqual([{ question: "Pick", header: "", options: [{ label: "One" }] }]);
});
