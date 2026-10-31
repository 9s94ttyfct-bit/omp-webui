---
title: Feedback
summary: The Send feedback dialog, which opens a prefilled, cleaned GitHub issue (nothing is sent by the app), and the sidebar's one-time request for a GitHub star after sustained use.
settings: send-feedback, feedback
---

# Feedback

## What it does

**Send feedback** opens a dialog that drafts a GitHub issue for omp-webui. The person picks **Something is broken** or **I'd like a feature**, writes a short summary (required) and the fields of that kind (what happened, steps to reproduce, what was expected and what happened instead; or the problem and the wished-for solution), and may tick **Attach diagnostics** (versions of the web UI and omp, the operating system, the Full / Light mode and the browser; no conversations, paths or credentials). **Preview** shows the title, label and description; **Open on GitHub** opens GitHub's new-issue page with all of it filled in, and **Copy text** copies it. Nothing is sent by the app: the issue exists only once the person submits it on GitHub (a GitHub account is needed).

Before anything is shown, tokens, keys (private keys included), passwords, cookies, webhook links, the sign-in part of links and commands, e-mail addresses, the user name and the home folder are removed from what was written. When the link would be too long (about 7,000 characters), the diagnostics are cut first; if the text itself is too long, **Open on GitHub** first copies the full text to the clipboard to paste into the issue.

**Star prompt.** After messages have been sent on 5 different days, a small card in the sidebar ("Enjoying omp web UI?") may ask once for a GitHub star, only while the project's repository is public. Answers: **Star on GitHub** (opens the repository; never asks again), **Not now** (asks again after 30 days), **Don't ask again**. Whether the repository is public is looked up by the server only once the prompt is otherwise due; a lookup that could not tell counts as private and is tried again a day later. Turning the prompt off in Settings is the same as Don't ask again, and also stops the lookup.

## Where it is

- **Settings › App & system › Feedback** (`#/settings/app`): **Send feedback** button, and the checkbox **Offer to ask for a GitHub star** ("After several days of use the sidebar may ask once for a star, only while the repository is public. Turn this off and the app neither asks nor looks up the repository on GitHub.").
- The command palette's feedback entry, and the keyboard shortcuts card ("Something broken or missing?" › Send feedback) also open the dialog.
- The star card appears near the bottom of the sidebar.

## Settings

| Key | Values | Default | Effect |
|---|---|---|---|
| `ompw.star` | JSON object: `{ "never": true }` or `{ "until": <ms timestamp> }` | unset (may ask once due) | Synced preference. The answer to the star prompt: `never` (Don't ask again, the star link, or Settings off) or not before `until` (Not now: 30 days; Settings on writes `until: 0`). |
| `ompw.usageDays` | JSON list of local calendar days `YYYY-MM-DD` on which a message was sent; the last 60 kept | unset | Synced preference. The measure of sustained use: the star prompt may show after 5 distinct days. |

## API routes

| Route | Methods | Access | Purpose |
|---|---|---|---|
| `/api/repo` | GET | token | `{ public }`: whether the project's GitHub repository is public, as GitHub tells an anonymous visitor (`true`, `false`, or `null` when it could not tell). Asked by the page to decide whether to show the star prompt. The server's answer is kept 24 hours (an answer that could not tell, one hour). |

The dialog's diagnostics come from `/api/diagnostics` (see the server-and-security topic).

## Limits and caveats

- Sending needs a GitHub account and a browser that can open github.com; the app itself files nothing.
- The cleaning of secrets is pattern-based; the person should still read the preview before submitting.
- A very long report is cut in the link; the full text is put on the clipboard instead.
- The star prompt never shows while the repository is private or its visibility is unknown.

## Security notes

- The repository lookup is an anonymous request to api.github.com with no credentials, so nothing the machine is signed in to affects it; it is not made while the star prompt is off or not yet due.
- No feedback leaves the computer except through the GitHub page the person opens and submits themselves.
- Agents may open the Feedback dialog for the user or help draft a report, but should not submit issues on the user's behalf unless asked.
