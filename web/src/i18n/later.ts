/**
 * The English strings the first page does not ask for (`<namespace>-later.ts`), registered for `t()`.
 *
 * Every module outside the first page load that uses one of them imports this module (`import "../i18n/later.ts"`):
 * the import runs this before the module does, whichever chunk loads it first, so there is no moment at which a string
 * is asked for and not known. A module of the first page load never imports it (that would put the strings back in
 * the first load); it can use only the strings in `<namespace>.ts`. `tests/unit/i18n-first-load.test.ts` holds the
 * modules to both.
 */
import { en as chat } from "./chat-later.ts";
import { en as feedback } from "./feedback-later.ts";
import { registerLater } from "./index.ts";
import { en as loaded } from "./loaded-later.ts";
import { en as mode } from "./mode-later.ts";
import { en as omp } from "./omp-later.ts";
import { en as pages } from "./pages-later.ts";
import { en as panel } from "./panel-later.ts";
import { en as presets } from "./presets-later.ts";
import { en as remote } from "./remote-later.ts";

registerLater({ chat, panel, pages, presets, mode, loaded, feedback, omp, remote });
