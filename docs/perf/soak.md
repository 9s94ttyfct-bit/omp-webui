# Soak harness

`scripts/soak.ts` runs hours of simulated use against the **real** omp (18.12.3) and **Claude Haiku 5.5 only**, in an
isolated HOME / agent directory (`tests/support/server.ts`, every model role on `anthropic/claude-haiku-5-5`), with the
built web UI open in headless Chromium. It never touches `~/.omp` or a running omp-webui.

```sh
# the 3-hour run (the 10-minute validation cost about 0.03 USD of Haiku; `--max-cost` stops a run that spends more)
caffeinate -dimsu bun scripts/soak.ts --minutes 180 --interval 60 --label soak-3h

# a 10-minute check of the harness itself
caffeinate -dimsu bun scripts/soak.ts --minutes 10 --interval 20 --label validation-10min
```

Needs an Anthropic login (`omp token anthropic`). Outputs go to `.tmp/soak/<label>/` (`--out` to change): `report.md`,
`series.csv`, `series.json`, `server.stderr.log`, `final.png` (and `stuck-conversation-*.png` for a hang). The three
report files are rewritten after every sample, so a run that is stopped still has its report.

## What the simulated user does

- keeps `--conversations` (default 3) conversations active, each given a short prompt every `--think` seconds (±50 %)
  that makes the model run a cheap tool (bash, read, write) or, every `--subagent-every`-th prompt, hand a task to a
  subagent (omp's `task` tool);
- switches between conversations from the sidebar, scrolls a transcript, opens the right panel and a subagent's detail,
  the settings, usage, the ⌘K search and the sidebar filter;
- every `--rotate` minutes closes the oldest conversation from the Settings page and opens a new one (or resumes an
  earlier one from its session file);
- every `--goal-every` minutes sets a goal in one conversation, pauses it, resumes it, and lets omp complete it (or
  drops it after four minutes);
- answers a tool approval or a question when a turn waits on one.

## What is measured

Every `--interval` seconds: server RSS and CPU, the server's open file descriptors (`lsof`; sockets, pipes, files,
ESTABLISHED connections), omp conversation processes, relay processes, other descendants, zombies, strays (processes of
the run outside the server's tree), RSS and CPU of everything below the server, the server's answer time, the page's JS
heap, DOM elements, DOM nodes kept alive while detached and event listeners, a `page.evaluate` round trip, how long a real
mouse click takes to show in the DOM, long tasks, WebSocket requests unanswered for more than 10 s, WebSocket reconnects,
page errors, console errors, server stderr lines that tell of an error, failed harness UI steps, the WebSocket data the page
received (what the page's heap should be compared with) and the host's load average.

The page figures that can show a leak (heap, DOM, detached nodes, listeners) are taken **in the same view every time**: the
harness leaves the conversation for the Settings page (closing the right panel), waits for React to unmount it, collects
garbage until the node and listener counts stop moving and reads the counters. What the user happened to be looking at does not move them; what the page keeps for
the conversations it has opened still does (so growth that follows the conversations opened is content, not a leak, while
detached nodes and listeners are not content). The DOM as the user left it is recorded too, but not graded. A view that
was just left stays referenced until the next one is left (the 10-minute run showed +80 to +150 nodes at one sample in
three, however long it waited), so a sample can read high but never low: the node counts and the listeners are fitted
to the smallest of every three consecutive samples.

Per action, the latencies (new chat until omp is ready, switch, send until the prompt shows, until omp is seen working,
the right panel, and a turn until omp is idle, one row per kind of prompt: a subagent turn takes about three times as
long as a tool turn, for a reason that is not a drift) with their medians over the first and the last third of the run.
Turns are timed by looking at omp every 300 ms while one is in flight; the look starts as soon as a prompt is sent, so
that a turn which begins and ends between two looks is still seen. A conversation is busy while a prompt of the harness
is in flight and while omp is working on it — a turn omp started on its own (a background job or a subagent that
finished) makes the conversation busy too, so the harness sends it no prompt and no goal while it runs. omp takes about
a second after Send to start (up
to 2.5 s under load: "A prompt: Send until omp is seen working"), so a prompt is not taken for finished before 6 s have
passed unless omp was seen working; a turn that is over before it was seen working is counted in the Activity table, and
its time is then 6 s or more, whatever it took. A turn that omp was seen working on is always recorded with the time it
took: nothing the harness does may clear the marker of a turn in flight, or the turn would be reported as one that
never started (and its 6 s grace would be read as the turn's time). A prompt that was never sent (a failed send) is
not a turn at all and is not counted. Working that no prompt of the harness started (omp
acting on a background job or a subagent that finished) is counted apart ("Turns omp started on its own", with its
working time in the latency table), not as the turn of a prompt, and omp finishing a goal that has just ended is not
counted at all. A goal that omp
has not completed four minutes after it is set is dropped with a warning that says what the web bar, the server, omp itself
(`goal get`, `get_state`) and its session file showed, and for how long omp had been idle with the goal still active.

## The verdict

For each graded metric the report gives start, end and maximum, and the least-squares slope per hour over the last hour
(the last third of a run shorter than three hours) with twice its standard error. The tolerance is the larger of an
absolute amount and a share of the window's mean, per hour:

- **no sustained growth**: slope within tolerance;
- **GROWTH**: slope above tolerance and the excess more than twice its standard error;
- **growth? (noisy)**: above tolerance, but not clearly (the run is inconclusive for that metric).

A crash (the server, the page) or a hang (a turn working for longer than `--stuck-min`, the server or page not answering)
is reported with the time it happened and fails the run. A run shorter than an hour gives **no verdict on growth**: its
slope window is minutes, so the slopes are extrapolations to an hour (the verdict line only lists what rose beyond
tolerance in the window; the per-metric rows still show their status; a count that rose by less than two whole units across
such a window counts as flat; growth does not fail such a run). The 10-minute run validates the harness, it cannot clear
the product.

## Sleep

The harness holds the machine awake with `caffeinate -dimsu` for as long as it lives and, at the end, asks
`pmset -g log` for Sleep, Wake and DarkWake events between its start and its end. A run that spans one is reported
**INVALID** (exit code 3): its timings and slopes mean nothing. The report's *Power* section lists the events; a sample
that comes far later than the interval is noted as a warning as well.

## Exit codes and cleanup

0 no crash or hang and no sustained growth, 1 crash / hang / harness error / (a run of an hour or more) growth, 2 no
Anthropic login, 3 invalid (slept), 130 interrupted.
On Ctrl-C, SIGTERM or SIGHUP the harness stops, takes a last sample, writes the report and cleans up (a second signal
after 1.5 s cleans up at once). Cleanup closes the browser, stops the server, kills what of the run is still running (below
the server, below the harness, or with the run's paths on its command line) and removes the temp dir and the relay
directory; the report's *Cleanup* section says what it found.
