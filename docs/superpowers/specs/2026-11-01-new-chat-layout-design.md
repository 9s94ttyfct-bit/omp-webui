# New chat: one folder control, settings bar under the composer — design

Status: proposed, 2026-11-01. Small change; short design.

## Intent

New chat's page is crowded. The row above the composer holds the folder control, the project-name field, "Use an existing
folder" / "Make a new project instead", up to four recent folders and Options. Long paths and the recent folders push
each other onto a second line, and the project-name field gets squeezed. The composer's footer holds 10 controls
(attach, preset, model, thinking, guard, guidance, Full/Light, goal, auto-approve, unattended). At 1000–1400 px they
wrap onto two lines, and the second line has only two controls, out of line with the first.

The person changes almost all of these controls when starting a chat: model, preset, thinking, guard, guidance,
Full/Light, goal, auto-approve/unattended. **None of them may be hidden.** Only the recent folders are used rarely
enough to put away.

## Goals

- The row above the composer is one line at desktop widths: the folder control and the name field (new project), and
  Options at its right end.
- The composer holds only the text, Attach and Send.
- Every setting control stays visible in a bar of its own under the composer.

## Non-goals

- The conversation page's composer is not changed. Its footer is already one row (`footerOneRow`: icons only, less
  used behind "⋯").
- Options (the omp flag form) keeps what it does.
- No control is removed, merged or renamed.

## Anti-goals

- No control the person picked goes behind a menu: not at desktop widths, and not on a phone.
- The composer's field must not jump while the pickers' chunk loads. The skeleton keeps its job (see `PickersSkeleton`).

## Approaches (picked from mockups)

- **A** — one folder control, plus the footer in two aligned rows (model / rules) inside the composer. Fixes the
  alignment, but keeps the composer tall.
- **B** — one folder control only; the footer wraps as it does now. Leaves the misaligned second line.
- **C (picked)** — one folder control, plus the controls moved out of the composer into a settings bar under it.

## Decided with the person

- Layout C.
- The conversation page is not changed.
- Phones and narrow windows: the settings bar shows **icons only and wraps** onto as many lines as it needs. Nothing goes
  behind "⋯" on this page.
- The recent folders move into the folder control's menu.

## The design

### Folder row

- **New project** (`existing === null`): a button "📁 New project ▾", then the project-name field taking the rest of
  the line, then Options at the right end. Under them, as now: "Will be created in ~/omp · Change".
- **Existing folder**: the same button reads the folder's name (last path segment, as the recent-folder buttons do
  today), with the full path as its tooltip. There is no name field.
- **The button's menu**:
  - New project (in ~/omp, where it says Change)
  - Choose an existing folder… (opens the folder browser as `setBrowse(true)` / `setBrowseFor("existing")` do now)
  - Recent: up to four folders, the current one excluded, as today
- "Make a new project instead", "Use an existing folder" and the inline recent buttons leave the row; the menu has them.
- The quota meter stays beside Options.

### Composer and settings bar

- New chat's `Composer` gets no `footer` of controls. Its own row keeps Attach and Send.
- Under the composer, a settings bar holds the same components in the same order:
  - preset, model, thinking, Full/Light
  - a divider
  - guard, guidance, auto-approve, unattended, goal (+ "skip the questions" when the goal is on)
- At desktop widths the controls show their labels and wrap when the bar is too narrow.
- Under the narrow breakpoint they show only their icons, as the composer footer's controls do now. They still wrap,
  and `ComposerMore` is not used here.
- The warm-up states ("Pick a folder", "Starting omp…", the error with Retry) are shown in the settings bar's place.

## Left to the builder

- Whether the bar reuses `Composer`'s narrow detection (`NARROW_COMPOSER_PX` / `composer-narrow` variant) or a
  container query of its own. It must make the same icon-only switch.
- Moving the skeleton bars (`PickersSkeleton`, widths in `index.css` by `data-sk`) to the bar. They must reserve the
  same widths so the bar does not jump when the chunk lands.
- The menu's component: the app's existing menu/popover used by the pickers.
- The e2e specs that click the inline recent buttons, "Make a new project instead" or "Use an existing folder" are
  updated to go through the menu. Specs that assume the controls sit inside the composer's footer are moved to the
  bar.
- docs/TECHNICAL.md and its zh-CN copy, plus the agent docs that describe New chat's controls, are updated.
