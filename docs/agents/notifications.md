---
title: Notifications
summary: Being told when a conversation needs an answer or finished its reply: the tab title, page or macOS notifications (Settings › Notifications), and Web Push to a phone or computer whose page is closed.
settings: notifications, push
---

# Notifications

## What it does

A conversation **needs you** when its omp waits for an answer (a tool approval, a question, a guard's "Ask me"), and has **finished** when its run ends (a turn, or a goal's whole run; an error or a usage limit also ends a turn). omp-webui tells the person in three ways, and never about a conversation they are looking at (the window or tab is in use and shows that conversation).

- **Tab title**: `(2) …` for two conversations waiting for an answer, `✓ …` once a turn finished while the tab was hidden. Always on.
- **Notifications** (Settings › Conversations & files › *Notifications*): in a browser, the system shows a notification for either event while a page of omp-webui is open. In the macOS app the page does not notify; the app shows its own notifications from what the server streams to it, so they also arrive while the app runs in the background with no window, and clicking one opens the conversation. The switch can be turned on only where the browser (or macOS) allows notifications; when blocked, the hint says where to allow them (in the app: System Settings › Notifications › omp-webui).
- **Notifications when this page is closed** (Web Push): a phone or computer is told by the server when a conversation finishes or needs you, even with every page of it closed. Turning it on for a device asks the browser for a push subscription and registers it with the server. The message is encrypted for that one device (the push service of Apple, Google, Mozilla or Microsoft carries it and cannot read it) and holds the conversation's saved title (or just "a conversation"), two words of why, and what a click opens. Nothing of what was said goes out unless **Show a line of the message** is on for that device: then it also carries the question that waits, or the start of the last reply. A device that has a page of omp-webui on screen is not pushed to.

Web Push needs the master switch on: the server sends nothing while `ompw.notify` is off (turning a device on turns it on). It is for a browser or a Home Screen app, not for the macOS app (which has its own). On iPhone or iPad the page must first be added to the Home Screen (Share › Add to Home Screen) and opened from there; Safari tabs cannot receive pushes. A closed page can be notified only over a secure address (https): use the remote address (Settings › Remote access). A device that subscribed through the tunnel is notified only while remote access is on.

The device list shows every registered device (*This device*, *Last sent …* / *Nothing sent yet*), with **Show a line of the message**, **Send a test**, **Revoke**, and **Revoke all devices**.

## Where it is

- **Settings › Conversations & files › Conversations** card › *Notifications* checkbox (`#/settings/chats`).
- **Settings › Conversations & files › Notifications when this page is closed** (index name *Notifications*): *This device* (*Notify this device* / *Stop notifying this device*) and *Devices that are notified*. In the macOS app the card says "The macOS app shows its own notifications; this is for a browser or a Home Screen app."

## Settings

| Key | Values | Default | Effect |
|---|---|---|---|
| `ompw.notify` | `on`, `off` | unset: off | Synced preference. Notifications wanted: page / macOS notifications, and the master switch of Web Push (the server pushes nothing while it is not `on`). What the browser allows is per origin and is asked again where not granted. |
| `ompw.pushDevice` | JSON `{ device, id }` | unset | Per-device localStorage key (never synced): this browser's own Web Push identity, so the page knows which device in the list is this one and tells the server whether it is on screen. |

Other stored data:

| Stored in | Content | Limits |
|---|---|---|
| `~/.omp-webui/push-devices.json` | Registered devices: push endpoint and keys, label, language, preview on/off, whether it subscribed through the tunnel, last sent | At most 16 devices; label up to 60 characters |
| `~/.omp-webui/push-vapid.json` | The server's own push signing key (VAPID) | Created on first use |

Environment: `OMP_WEBUI_PUSH_HOSTS` (comma-separated extra push-service origins the server may send to, beyond the browsers' own services) and `OMP_WEBUI_PUSH_SUBJECT` (the contact address given to push services).

## API routes

| Route | Methods | Access | Purpose |
|---|---|---|---|
| `/api/push` | GET | token | The server's public push key and the registered devices: `{ publicKey, devices }`. |
| `/api/push/subscribe` | POST | token | Register this browser: `{ subscription: { endpoint, keys: { p256dh, auth } }, device, label?, lang?, preview? }`. The endpoint must be one of the browsers' push services (or `OMP_WEBUI_PUSH_HOSTS`); `device` is 16–64 of `A-Z a-z 0-9 _ -`. Answers `{ id }`. Not local-only: phones come in through the tunnel. |
| `/api/push/unsubscribe` | POST | token | `{ device }`: a page takes its own device off. Answers `{ removed }`. |
| `/api/push/revoke` | POST | token | `{ id }`: remove one device. |
| `/api/push/revoke-all` | POST | token | Remove every device. |
| `/api/push/preview` | POST | token | `{ id, preview }`: turn the message line on or off for a device. 404 for an unknown device. |
| `/api/push/test` | POST | token | `{ id }`: send a test notification; answers `{ ok, status }` (the push service's HTTP status). 429 when a test was sent to that device in the last 5 seconds. |

Bodies are limited to 8 KB. Page and macOS notifications use no route of their own: the page learns of the conversations over its WebSocket, and the macOS app over `/api/shell/events` (see `macos-app`).

## Limits and caveats

- A push is not retried: a push service that refuses it is noted once in the server log; a device the service says is gone (404/410) is removed.
- A push lives 6 hours at the push service; the server waits up to 1.5 s for a conversation's title before sending.
- Page notifications in a browser need a page of omp-webui open somewhere; Web Push does not.
- A device is considered "looking" only while one of its pages reported itself on screen recently (heartbeat about every 25 s).

## Security notes

- Push messages are end-to-end encrypted for each device; by default they hold only the saved title and the reason. Turning the preview on puts a line of the conversation into what the push service carries (still encrypted).
- `/api/push*` routes need the access token and are open to remote pages by design (a phone subscribes through the tunnel); revoking a device is open to any page holding the token.
- The server sends only to known push-service hosts unless the person adds origins with `OMP_WEBUI_PUSH_HOSTS`.
