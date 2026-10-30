/**
 * The English strings of the namespaces whose `en` is in two modules (see `web/src/i18n/index.ts`), whole: the ones the
 * first page asks for and the ones `later.ts` registers. A test that looks up a string by key takes it from here, so that
 * it does not depend on which half the key is in.
 */
import { en as chat } from "../../web/src/i18n/chat.ts";
import { en as chatLater } from "../../web/src/i18n/chat-later.ts";
import { en as pages } from "../../web/src/i18n/pages.ts";
import { en as pagesLater } from "../../web/src/i18n/pages-later.ts";
import { en as panel } from "../../web/src/i18n/panel.ts";
import { en as panelLater } from "../../web/src/i18n/panel-later.ts";
import { en as presets } from "../../web/src/i18n/presets.ts";
import { en as presetsLater } from "../../web/src/i18n/presets-later.ts";
import { en as remote } from "../../web/src/i18n/remote.ts";
import { en as remoteLater } from "../../web/src/i18n/remote-later.ts";

export const chatEn = { ...chat, ...chatLater };
export const pagesEn = { ...pages, ...pagesLater };
export const panelEn = { ...panel, ...panelLater };
export const presetsEn = { ...presets, ...presetsLater };
export const remoteEn = { ...remote, ...remoteLater };
