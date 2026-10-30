import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { i18nReady } from "./i18n/index.ts";
import "./index.css";
import { startDraftPersistence } from "./lib/drafts.ts";
import { guardDrops } from "./lib/drop-guard.ts";
import { startPrefsSync } from "./lib/prefs.ts";
import { startLivePrefs } from "./lib/prefs-live.ts";
import { keepRangeFill } from "./lib/range-fill.ts";
import { reloadOnPreloadError } from "./lib/reload.ts";
import { followSystemTheme, paintTheme } from "./lib/theme.ts";
import { startApp, useApp } from "./store/app.ts";

// A tab left open across an upgrade asks for chunks the new build no longer has: fetch the new build, once.
window.addEventListener("vite:preloadError", () => reloadOnPreloadError());
// Theme "System" follows the OS appearance while the app is open (index.html only reads it before first paint).
followSystemTheme(() => useApp.getState().theme);
// index.html painted the page itself; the colour of the browser's own chrome (a phone's status bar) is set here, once the
// stylesheet is loaded, to the page background of the palette and mode chosen.
paintTheme(useApp.getState().theme);
// A file dropped outside the composer must not navigate the window to it.
guardDrops();
// Range sliders draw their groove filled up to the value.
keepRangeFill();
// Unsent messages survive a reload (⌘R, the one after an upgrade, a web view the system killed).
startDraftPersistence();

// The preferences are kept on the server too, so that another port of it (the macOS app moves when its own is taken) has them.
void startPrefsSync();
startLivePrefs();
void startApp();
// A page opened on a conversation shows it first: the code that does is fetched while the app finds out what it is to show
// (its first-run check takes two requests), not once it has.
if (/^#\/(s|live)\//.test(location.hash)) void import("./components/ChatView.tsx");

const root = document.getElementById("root");
if (!root) throw new Error("#root missing");
void i18nReady.then(() =>
	createRoot(root).render(
		<StrictMode>
			<ErrorBoundary>
				<App />
			</ErrorBoundary>
		</StrictMode>,
	),
);
