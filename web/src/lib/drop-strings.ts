import { en } from "../i18n/drop.ts";
import { registerStrings } from "../i18n/index.ts";

// Imported only by the lazy chunks that use the strings of dropped files (the choice, the settings card): the English
// ones go in with the first of them (see `registerStrings`); the first page carries none of it.
registerStrings("drop", en);
