---
title: Keyboard shortcuts
summary: Every key binding of the web UI, and how to change, remove or reset one (including keys for quick prompts).
settings: shortcuts
---

# Keyboard shortcuts

## What it does

Lists every key the web UI listens for, by the surface it acts on, and lets the user rebind them. `Mod` is ⌘ on macOS and iOS and Ctrl elsewhere (the matcher accepts either ⌘ or Ctrl for `Mod`). Key names are shown the platform's way (`⌘⇧O` or `Ctrl+Shift+O`).

### Default bindings

| Scope | Action | Default | Changeable |
|---|---|---|---|
| Global | Search conversations | Mod+K | yes |
| Global | New chat | Mod+Shift+O | yes |
| Global | Toggle sidebar | Mod+\ | yes |
| Global | Set a goal | Mod+Shift+G | yes |
| Global | Change the permission mode | Mod+Shift+A | yes |
| Global | Focus the notifications (Esc goes back) | Mod+Shift+Y | yes |
| Global | Show keyboard shortcuts (opens Settings at this card) | ? | yes |
| Composer | Send (queue a follow-up while omp is working) | Enter | yes |
| Composer | Steer: interrupt omp with this message now | Mod+Enter | yes |
| Composer | Accept the predicted word (adds a space) | Tab | yes |
| Composer | Accept the predicted word without a space | → | yes |
| Composer | New line | Shift+Enter | no (fixed) |
| Composer | Stop omp (press twice: the first Esc asks) | Esc | no (fixed) |
| Composer | Switch to the next model preset | Mod+Shift+M | yes |
| Subagent full screen | Leave the subagent's full screen | Esc | no (fixed) |
| Subagent full screen | Previous subagent | Alt+↑ (⌥↑) | yes |
| Subagent full screen | Next subagent | Alt+↓ (⌥↓) | yes |
| Subagent full screen | Open the list of subagents | Alt+L | yes |
| Command menu | Next / previous suggestion | ↓ / ↑ | no (fixed) |
| Command menu | Insert suggestion (Enter also inserts it) | Tab | no (fixed) |
| Command menu | Close suggestions | Esc | no (fixed) |
| Model picker | Add or remove the highlighted model from favorites | Mod+Shift+L | yes |

Quick prompts have no key by default; each can be given one in the same card (section *Quick prompts*). A quick prompt's key sends the prompt to the conversation on screen, as its ⚡ menu does.

### Changing a binding

Each row has *Change* (press the new keys; Esc cancels), *Remove* (no key at all), and *Reset* (back to the default). *Reset all shortcuts* restores every default and removes every quick prompt key. While recording:

- A modifier alone waits for the key; keys typed through an input method are refused until composition ends.
- Allowed keys: one character, or Enter, Tab, Escape, Backspace, Delete, Space, arrows, Home, End, PageUp, PageDown, F1–F12.
- A key that types text (a character with no Mod/Alt) is refused outside the Global scope: it would go into the message box. Even a Global printable key does not fire while typing in a text field.
- A key already used in an overlapping scope (the same scope, or either one Global or a quick prompt) is a conflict: the user can *Swap* (the other action gets this one's old key) when the other binding is not fixed, or choose other keys.
- Keys the browser, macOS or text fields use (e.g. Mod+W, Mod+Q, Mod+T, Mod+N, Mod+L, Mod+R, Mod+C, Mod+V, Mod+Z, Mod+A, Mod+Tab, Mod+Space, Mod+Shift+T) warn that they may never reach the page or are taken from their owner; *Use anyway* binds them.

## Where it is

Settings › Look & layout › Keyboard shortcuts. Press `?` (outside a text field) to open it.

## Settings

| Key | Values | Default | Effect |
|---|---|---|---|
| `ompw.shortcuts` | JSON object of action id (or `qp:<quick prompt id>`) → chord text such as `Mod+Shift+O`, or null for a removed binding | unset: every default | Per-device localStorage key, never sent to the server (another device has another keyboard). Holds only the bindings the user changed. |

## API routes

None.

## Limits and caveats

- Bindings are per browser/device and per origin: they do not follow the user to another browser, port or the other device.
- Fixed keys (New line, Stop, leaving full screen, command-menu keys) are listed but cannot be rebound.
- A binding may still be swallowed by the browser or OS for reserved chords.

## Security notes

None. Bindings are stored only in the browser's localStorage.
