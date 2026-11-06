# Built-in browser downloads — design

## Intent

In the Mac app, a download started in the built-in browser's page (the person clicking a link in the Browser tab, or a
page saving a file while no agent waits for one) does nothing: no file, no message. The person wants downloads to work,
to see them (progress, a list), to cancel one, and to get a downloaded file onto the device they are using (a phone
through the tunnel).

## Goals

- A download the page starts is saved, whoever clicked.
- The Browser tab says a download started, finished or failed, and lists the conversation's downloads with their
  progress; one in progress can be cancelled.
- On this Mac a finished download can be shown in Finder; on a page that is not on this Mac it can be fetched to that
  device.
- An agent waiting for a download (`waitForDownload`, `Browser.setDownloadBehavior`) gets it where it asked, as now.

## Non-goals

- Chrome for Testing (Windows, Linux, the server alone): not changed here; its downloads are not looked at.
- A list that outlives the app: the list is of this run.
- Pausing, resuming or retrying a download.

## Anti-goals

- A save dialog that waits on this Mac while the person is on their phone.
- A file that overwrites another in Downloads.
- A page that is not on this Mac getting files the File transfer setting does not allow.

## Cause (from the code and CEF 156's headers; to be confirmed on a real click first)

Every page is a windowed `CefBrowser` made with `SetAsChild(parent)` (`macos/cef/CEFHost.mm`), which sets `parent_view`;
on macOS that forces CEF's Alloy style (`cef_types_mac.h`). The `Client` has no `CefDownloadHandler`, and with Alloy
style a download nobody handles is cancelled (`cef_download_handler.h`, `OnBeforeDownload`). Agents' downloads work
because they set a download behaviour over CDP.

## Approaches

- **A — the app's CEF handles downloads (picked by the person).** `CEFHost.mm` gets a download handler: it decides
  where the file goes, reports progress and cancels. The app tells the server over its `/browser-engine` connection; the
  server keeps the list per conversation and tells the Browser tabs. Fixes the cancel where it happens; needs an app
  build; the Mac app only.
- **B — the server takes every download over CDP** (`Browser.setDownloadBehavior` with events, as agents do). One
  implementation for both engines, but CEF's default cancel stays underneath: a download before the server set the
  behaviour, or after a restart, is still lost, and agents' and the server's settings override each other. Not picked.

## Design

- **Native (`CEFHost.mm`, `CEFHost.h`).** `Client` is also a `CefDownloadHandler`. `OnBeforeDownload` picks
  `~/Downloads/<name>` (the suggested name, made safe; `name (1).ext`, `name (2).ext`… when a file or a download in
  progress already has it) and continues there without a dialog. `OnDownloadUpdated` tells an observer what the download
  is: its id, the page (target id), name, state (`progress`, `done`, `cancelled`, `failed`), bytes received and total, and
  why it failed; progress at most a few times a second. The item's callback is kept while it runs, for `cancelDownload`.
  A download an agent set a behaviour for is reported too (its own folder), never moved. A finished file carries the
  quarantine mark (checked on the built app; set by the app if CEF does not).
- **App ↔ server (`macos/browserlink.swift`, `server/browser/cef.ts`).** `{t:"download", download}` from the app;
  `{t:"download_cancel", id}` to it.
- **Server (`server/browser/downloads.ts`).** The list: each download belongs to the conversation that owns its page when
  it is first heard of (`registry.ownerOfTarget`), and stays its after the page closes; at most 50 kept per conversation,
  the oldest finished ones go first. The Browser tabs watching a conversation are sent its list on watch and on each
  change (`{t:"downloads", owner, downloads}` on `/ws/browser`); a tab may cancel one of its conversation's downloads
  (`download_cancel`) and, on this Mac only, show it in Finder (`download_reveal`). Pages are told the name, never the
  path.
- **Fetching a file to a device.** `GET /api/browser/downloads/<id>/file`: a finished download's bytes as an attachment,
  with `Range` / `If-Range`, through the File transfer rules a page that is not on this Mac already has (`requireDownload`:
  off refuses), the same secret check as the Files tab, and the file as it is now (one that was moved or deleted says so).
- **Browser tab (`web/src/components/BrowserTab.tsx`).** A Downloads button in the toolbar once the conversation has a
  download, with the number in progress; it opens the list: name, a progress bar and bytes, Cancel while running; Show in
  Finder (this Mac) or Download to this device (elsewhere) once done; why it failed. A toast when one starts, finishes
  or fails. English and Chinese.
- **Docs.** `docs/agents/browser.md` (downloads), `docs/TECHNICAL.md` and its Chinese version, release notes.

## Checks

- The cause first: the app built with the handler logging, a download clicked in the Browser tab.
- Contract: a fake app on `/browser-engine` reports downloads; a Browser socket of the conversation gets the list, one of
  another conversation does not; cancel reaches the app only for the conversation's own download; the file route's
  Range, and its refusal with File transfer off for a page that is not this Mac's.
- Unit: the list (owner, cap, states).
- The built app: a real download in the Browser tab, its file in Downloads with a unique name, the list, cancel, the
  quarantine mark.

## Left to the builder

Names of the strings and test ids; how progress is throttled; the toolbar button's icon.
