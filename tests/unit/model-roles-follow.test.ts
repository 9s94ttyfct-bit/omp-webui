import "./browser-globals.ts";
import { expect, test } from "bun:test";
import { followConfig, rowsOfRoles } from "../../web/src/components/ModelRolesEditor.tsx";

/**
 * Settings › Model roles keeps a draft while it has unsaved edits. When the config changes meanwhile (another window's
 * Save, the terminal) the roles the person did not touch take the new value, so their Save does not put the old values
 * back (#329); the roles they did touch keep their edit.
 */

const draft = (roles: Record<string, string>, thinking = "low") => ({ rows: rowsOfRoles(roles), thinking });

test("an untouched draft becomes the new config", () => {
	const base = draft({ default: "a", smol: "a" });
	const next = draft({ default: "a", smol: "a", commit: "b" }, "high");
	expect(followConfig(base, base, next)).toEqual(next);
});

test("the roles the person changed keep their edit; the others take what another window saved", () => {
	const base = draft({ default: "a", smol: "a", slow: "a", commit: "a" });
	// B edited smol and removed slow; A (elsewhere) changed commit, slow and added tiny.
	const mine = draft({ default: "a", smol: "m", commit: "a" });
	const next = draft({ default: "a", smol: "a", slow: "z", commit: "x", tiny: "t" });
	const followed = followConfig(mine, base, next);
	expect(Object.fromEntries(followed.rows.map((r) => [r.role, r.selector]))).toEqual({
		default: "a",
		smol: "m",
		commit: "x",
		tiny: "t",
	});
});

test("the default thinking level follows the config unless it was edited", () => {
	const base = draft({ default: "a" }, "low");
	const next = draft({ default: "a" }, "high");
	expect(followConfig(draft({ default: "a" }, "low"), base, next).thinking).toBe("high");
	expect(followConfig(draft({ default: "a" }, "medium"), base, next).thinking).toBe("medium");
});
