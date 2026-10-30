# Baseline: omp-webui v0.11.7 (53c4126) — PROVISIONAL

`scripts/bench.ts` run on the unmodified v0.11.7 code, twice, back to back (raw data: `bench-v0.11.7.json` = run 1,
`bench-v0.11.7-run2.json` = run 2).

**Status: provisional.** The machine was shared with other agents' work while these ran: the 1-minute load average was
4.2–4.9 at the start of each run (the harness's limit for a baseline is 3; it was run with `--allow-load`, which marks
the report `"provisional": true`). The numbers are good for judging the harness's noise and as a rough picture of v0.11.7;
the official baseline for the final comparison has to be measured again in a quiet window (see "Rules for the final
comparison"). Do not compare a later run against these files; compare it against a baseline measured in the same
conditions, back to back.

## Run it

```sh
bun run build                                   # the server serves this checkout's dist/web
bun scripts/bench.ts --label <name> [--runs 5] [--warmup 1] [--out docs/perf] [--only server,switch] [--shards N] [--allow-load]
bun scripts/bench.ts --compare docs/perf/bench-a.json docs/perf/bench-b.json [--threshold 5]
```

- One run (1 warm-up round + 5 measured rounds, every scenario) takes **619 s (10 min 19 s)** in both runs here; a round
  is 102–106 s (server 13 s, load 15 s, list 0.7 s, switch 19 s, long 19 s, stream 35 s).
- It refuses to start when the 1-minute load average is above 3 (`--allow-load` overrides it and marks the report
  provisional). It holds `caffeinate -dimsu -w <pid>` for the whole run on macOS (the runs here were additionally
  started under `caffeinate -dimsu`), reads the power log (`pmset -g log`) afterwards, and records every Sleep / Wake /
  DarkWake inside the run window in `power.events`: a run with any is `"valid": false`, exits 3, and `--compare` refuses
  it. It also records power source, the load average at the start, the end and around every round, and fixed-work
  calibrations (see "Conditions of these runs"). It adds a `caveats` list and `provisional: true` when the load was above
  the limit, the Mac was on battery, or the calibration varied by more than 30% within the run.
- Exit codes: 0 ok; 1 `--compare` found a metric worse (or the run refused to start); 2 a scenario failed; 3 the run was
  invalid (the Mac slept) or `--compare` was given an invalid report; 130 interrupted.
- No model is called. The server is a fresh `startTestServer` (isolated HOME and agent dir, port 0) with a scripted fake
  omp (`tests/support/long-fake-omp.ts`); nothing touches `~/.omp` or the app on port 7878.
- `--shards N` splits the rounds over N copies of the benchmark started at once (each its own server, fake omp, world
  and browser on a free port) and merges their rounds into one report: the run uses N cores and takes about
  `(warm-up + runs/N)` rounds of wall time instead of `(warm-up + runs)`. Processes sharing the cores change the CPU-bound
  numbers, so `conditions.shards` is recorded and `--compare` refuses (exit 4) two reports taken with different `N`.
  The final A B A′ comparison uses `--runs 12 --shards 6` for all three runs.
- **Server memory is recorded twice (#601).** `server.idle.footprint_mb`, `server.list.footprint_mb`,
  `server.long.footprint_mb` and `server.stream.footprintPeak_mb` are the server's footprint: macOS `footprint -p <pid>
  --noCategories --format bytes` (about 0.3 s a call), Linux `/proc/<pid>/smaps_rollup` Pss; sampled where the `rss`
  metrics are (idle after its window, list after the full-list requests, long at the end of the scenario, stream every 2 s
  plus at both ends). They are the memory gate. `server.idle.rss_mb`, `server.list.rss_mb` and `server.stream.rssPeak_mb`
  stay in the report from `ps`, but `--compare` marks them informational and never counts them as worse: macOS keeps pages
  the process has already freed in `ps` RSS (`MADV_FREE_REUSABLE`) until the kernel wants them back, so RSS moves with memory
  pressure and with what ran before (observed on this machine in #601: `ps` RSS of the same code varied by 8 MB and more
  between rounds, the footprint by 1-3 MB). A report from before these metrics is still compared: the footprint rows read "missing"
  and `--compare` says the memory gate was not applied. If the footprint cannot be read the run is marked provisional.
- **`bun scripts/bench-gate.ts --a <baseline checkout> --b <checkout under test> [--out dir]`** is the A B A′ run: it
  copies A to a temporary directory and lays B's measuring harness over the copy (`scripts/bench.ts` and the `scripts/` and
  `tests/` files it imports, the fake omp; never app code), so both sides record the footprint even when A is a release from
  before it did (`gate-summary.md` lists the files and which of them differ from A's); builds both; then measures A, B, A′ in
  turn (default `--runs 12 --shards 6`),
  starting each only when the 1-minute load average is at most `--max-load` (2.5; the run's own load takes a few minutes to
  fall, so this is also the cool-down between runs) and waiting at most `--max-wait` minutes (30). If the machine does not
  get quiet it refuses (exit 2); `--on-timeout provisional` measures anyway with `--allow-load` and marks the run, the
  summary and the exit code (6) PROVISIONAL. It writes `cmp-AB.md`, `cmp-AA2.md`, `cmp-A2B.md` and `gate-summary.md`
  next to the reports. Exit: 0 pass; 1 B worse than A or A′; 2 refused or a build or run failed; 3 invalid or not
  comparable; 5 A differs from A′ (the baseline drifted); 6 nothing worse but provisional: a run on a busy machine, or a
  report without footprint metrics (memory not gated). A comparison that did not gate memory is never a pass.

## Method

**Pinned conditions.** Playwright Chromium 156.0.8078.4, headless, 1400×900 at DPR 1, UTC, dark scheme, a new browser
for every scenario (nothing cached or JIT-warmed across scenarios), the built `dist/web` (223 KB of JS in 5 files on
first load). Every conversation is generated from fixed seeds (`tests/support/bench-fixtures.ts`): the same bytes
every run. The library on disk: 1 long conversation (1 400 turns, **6 760 entries, 16.7 MB**, every 25th tool result a
log dump), 8 conversations of 186–216 entries to switch between, 1 conversation of **2 402 entries** to stream into, 500
small conversations in 12 projects spread over a year: **515 sessions**.

**Rounds, interleaving, medians.** One round runs every scenario once on a freshly restarted server (the first round is a
warm-up and is dropped). Rounds repeat, so a slow stretch of the machine lands on every metric alike; a metric's value
is the **median over the 5 measured rounds**; the report also keeps p90, min–max, interquartile range (IQR, % of the
median) and every round's value. Before and after each round the harness records the load average and times a fixed
piece of arithmetic in the benchmark process (28 ms when the machine is free, 26.8–32.8 ms in these runs) and in each
scenario's browser (155–166 ms), so a slow stretch shows up next to the numbers.

**Scenarios and metrics** (`.ms` = milliseconds of the page's `performance.now()`; frame times from `requestAnimationFrame`
gaps; "painted" = the DOM has it and the frame after was painted):

| group | what is measured |
| --- | --- |
| `load.cold` | A browser that has fetched nothing from the server navigates to the home page. `listReady_ms` = until ≥10 sidebar rows are in the DOM and painted; `fcp_ms`, `lcp_ms`; `jsTransfer_kb` / `jsFiles` = transferred JS; `longTask_*` = tasks >50 ms until 1 s after ready; `mainThread_ms` / `script_ms` = CDP `TaskDuration` / `ScriptDuration` after 1 s of settling. |
| `load.warm` | The same, in a second page of the same browser (HTTP cache full): what is left is the page's own work and the list. |
| `list.api` | `/api/sessions` with 515 sessions: `cold_ms` = the first request after a server restart (index build); `full_ms` = median of 300 sequential full requests; `incremental_ms` = median of 300 requests with the `x-sessions-since` cursor. |
| `list.page` | In the warm page: `transfer_kb` of the list response, `fetch_ms` (request start → response end), `render_ms` (response end → list painted). |
| `list.scroll` | The sidebar's list scrolled at 4 000 px/s: frame p50/p95, `dropped_pct`, long tasks. |
| `switch.cold` / `switch.warm` | Click a sidebar item → the conversation's last message painted (from the click event's timestamp). `cold` = first visit of each of the 8 conversations in this browser; `warm` = a second pass in another order. `median_ms` / `p90_ms` over the 8 visits; `work_ms` = main-thread task time for the click plus 1 s; per-round medians. (With 8 visits `cold.p90` interpolates toward the first visit, which took 363–403 ms in the diagnostic run below against ~40–72 ms for the other seven; [inference] the lazy chunks of the chat view.) |
| `long.open` | Click the 6 760-entry conversation: `total_ms` to its last message painted; `fetch_ms` slowest `/api/session`/`family` response; `transfer_kb`; `work_ms`; `domNodes` and `heap_mb` (after two forced GCs) afterwards. |
| `long.scroll` | The transcript on screen scrolled from its top at 4 000 px/s (up to 20 000 px): frame p50/p95, dropped %, long tasks. |
| `long.reveal` | "Show earlier messages" clicked from the top until it is gone (93 clicks): `total_ms`, `lastClick_ms` (median of the last 5), `clicks`, `domNodes` (211 824) afterwards. |
| `long.scrollAll` / `long.heap_mb` | The same scroll through everything revealed; heap after. |
| `stream` | The fake omp streams one turn into the 2 402-entry conversation for 30 s (18 steps of 1.6 s: thinking, text, a tool call, a 12 KB tool output in 6 parts; 864 deltas). From the first delta to `agent_end`: `busy_pct` = CDP `TaskDuration` / wall time; `script_pct`, `layoutStyle_pct`; frame p50/p95 and `dropped_pct` of rAF gaps; long tasks; `queue_p95_ms` = WebSocket frame arrival → handler start; `toPaint_p50/p95_ms` = delta frame arrival → the first paint after the page changed; heap, DOM nodes. |
| `idle.page`, `server.*` | Page main-thread busy % connected and idle (8 s); the server process's CPU % idle (8 s, after it is quiet), idle with a page connected, CPU per list request over 600 requests, RSS after that, CPU % and relay CPU % while streaming, RSS sampled every 2 s while streaming (peak); `ps` reads CPU time at 10 ms resolution. |

## Conditions of these runs

| | run 1 (`bench-v0.11.7.json`) | run 2 (`bench-v0.11.7-run2.json`) |
| --- | --- | --- |
| wall clock (local, UTC−5) | 2026-10-20 11:24:42 → 11:35:04 | 11:35:09 → 11:45:28 |
| runtime | 619 s | 619 s |
| 1-min load average at start / end | 4.85 / 4.21 | 4.19 / 4.68 |
| load average before/after the measured rounds | 3.6–5.7 | 2.9–5.3 |
| power | AC power at start and end; `powermode 0` (not low-power) | same |
| sleep / wake events in the run window | none (`pmset -g log`, checked by the harness and again by hand over 11:24:40–11:45:40; the parser finds the 11:03 DarkWake/Wake of an earlier sleep, so it works) | none |
| benchmark-process calibration (fixed work, ms) | 26.8–32.8 | 26.8–32.2 |
| browser calibration (same work in each scenario's browser, ms) | 154.9–164.8 | 156.0–166.0 |
| source dirty | no (`server web shared macos` clean at 53c4126) | no |

Machine: Apple M4 Pro (12 cores: 8 performance + 4 efficiency), 24 GB, macOS 27.0.1 (Darwin 27.0.0), Bun 1.4.3.

## Results (run 1; run 2 beside it for the noise)

Columns: median, p90, min–max and IQR over run 1's 5 rounds; then run 2's median and IQR and the change of run 2's median
from run 1's. Noise class: **stable** = IQR and run-to-run change all ≤3%; **small** = noisier than 3% in percent but the
noise is below the metric's absolute floor (the smallest change `--compare` counts), so it cannot cause a finding;
**noisy** = noisier than 3% and larger than the floor (see below).

| metric | unit | median | p90 | min–max | IQR | run 2 median | run 2 IQR | run 2 vs 1 | noise class |
| --- | --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | --- |
| **First load** | | | | | | | | | |
| `load.cold.listReady_ms` | ms | 104.0 | 107.4 | 100.1–109.4 | 1.2% | 107.0 | 9.3% | +2.9% | small |
| `load.cold.fcp_ms` | ms | 84.0 | 86.4 | 44.0–88.0 | 4.8% | 84.0 | 61.9% | 0.0% | **noisy** |
| `load.cold.lcp_ms` | ms | 84.0 | 88.0 | 80.0–88.0 | 4.8% | 88.0 | 4.5% | +4.8% | small |
| `load.cold.jsTransfer_kb` | KB | 223.0 | 223.0 | 223.0–223.0 | 0.0% | 223.0 | 0.0% | 0.0% | stable |
| `load.cold.jsFiles` | files | 5.00 | 5.00 | 5.00–5.00 | 0.0% | 5.00 | 0.0% | 0.0% | stable |
| `load.cold.longTask_ms` | ms | 0.00 | 0.00 | 0.00–0.00 | 0.0% | 0.00 | 0.0% | 0.0% | stable |
| `load.cold.longTaskCount` | tasks | 0.00 | 0.00 | 0.00–0.00 | 0.0% | 0.00 | 0.0% | 0.0% | stable |
| `load.cold.mainThread_ms` | ms | 111.0 | 114.6 | 106.1–115.0 | 4.9% | 113.7 | 6.1% | +2.4% | small |
| `load.cold.script_ms` | ms | 64.8 | 65.2 | 61.8–65.4 | 0.3% | 65.0 | 3.6% | +0.3% | small |
| `load.warm.listReady_ms` | ms | 106.5 | 108.5 | 96.2–109.3 | 6.7% | 95.2 | 0.2% | -10.6% | small |
| `load.warm.mainThread_ms` | ms | 116.1 | 117.9 | 106.3–118.3 | 6.7% | 114.4 | 5.8% | -1.5% | small |
| **Session list (515 sessions)** | | | | | | | | | |
| `list.api.cold_ms` | ms | 16.4 | 18.9 | 15.7–19.2 | 14.0% | 15.9 | 9.5% | -2.6% | small |
| `list.api.full_ms` | ms | 1.76 | 1.96 | 1.58–2.00 | 11.3% | 1.67 | 21.8% | -5.0% | small |
| `list.api.incremental_ms` | ms | 0.12 | 0.12 | 0.11–0.12 | 2.0% | 0.11 | 8.6% | -0.9% | small |
| `list.page.transfer_kb` | KB | 48.2 | 48.2 | 48.2–48.2 | 0.0% | 48.2 | 0.0% | -0.0% | stable |
| `list.page.fetch_ms` | ms | 3.20 | 4.92 | 2.70–6.00 | 3.1% | 3.00 | 6.7% | -6.3% | small |
| `list.page.render_ms` | ms | 30.4 | 32.4 | 26.3–33.2 | 7.9% | 26.6 | 2.6% | -12.5% | small |
| `list.scroll.frame_p50_ms` | ms | 16.7 | 16.7 | 16.7–16.7 | 0.0% | 16.7 | 0.0% | 0.0% | stable |
| `list.scroll.frame_p95_ms` | ms | 16.7 | 16.8 | 16.7–16.8 | 0.6% | 16.7 | 0.0% | 0.0% | stable |
| `list.scroll.dropped_pct` | % | 0.00 | 0.00 | 0.00–0.00 | 0.0% | 0.00 | 0.0% | 0.0% | stable |
| `list.scroll.longTask_ms` | ms | 0.00 | 0.00 | 0.00–0.00 | 0.0% | 0.00 | 0.0% | 0.0% | stable |
| **Switch conversation** | | | | | | | | | |
| `switch.cold.median_ms` | ms | 60.2 | 63.3 | 47.9–64.4 | 11.1% | 57.9 | 13.3% | -3.8% | **noisy** |
| `switch.cold.p90_ms` | ms | 165.1 | 169.2 | 154.1–170.2 | 7.3% | 167.8 | 3.0% | +1.6% | **noisy** |
| `switch.cold.work_ms` | ms | 82.1 | 85.4 | 70.6–85.9 | 10.3% | 83.3 | 9.2% | +1.4% | **noisy** |
| `switch.cold.longTask_ms` | ms | 0.00 | 0.00 | 0.00–0.00 | 0.0% | 0.00 | 0.0% | 0.0% | stable |
| `switch.warm.median_ms` | ms | 57.1 | 58.2 | 52.6–58.4 | 4.2% | 56.7 | 5.7% | -0.5% | small |
| `switch.warm.p90_ms` | ms | 63.6 | 65.2 | 59.5–65.8 | 1.1% | 61.6 | 5.0% | -3.1% | small |
| `switch.warm.work_ms` | ms | 78.6 | 83.9 | 73.6–86.4 | 6.4% | 83.7 | 2.9% | +6.4% | **noisy** |
| `switch.warm.longTask_ms` | ms | 0.00 | 0.00 | 0.00–0.00 | 0.0% | 0.00 | 0.0% | 0.0% | stable |
| **Long conversation (6 760 entries, 16.7 MB)** | | | | | | | | | |
| `long.open.total_ms` | ms | 519.0 | 526.3 | 516.5–530.7 | 0.3% | 527.8 | 2.3% | +1.7% | stable |
| `long.open.fetch_ms` | ms | 445.6 | 451.3 | 440.9–454.1 | 0.4% | 448.5 | 0.8% | +0.7% | stable |
| `long.open.transfer_kb` | KB | 6858 | 6858 | 6858–6858 | 0.0% | 6858 | 0.0% | 0.0% | stable |
| `long.open.work_ms` | ms | 191.4 | 199.8 | 160.6–201.0 | 8.3% | 200.8 | 6.1% | +4.9% | **noisy** |
| `long.open.longTask_ms` | ms | 0.00 | 0.00 | 0.00–0.00 | 0.0% | 0.00 | 0.0% | 0.0% | stable |
| `long.open.domNodes` | nodes | 2694 | 2694 | 2694–2694 | 0.0% | 2694 | 0.0% | 0.0% | stable |
| `long.open.heap_mb` | MB | 28.5 | 28.5 | 28.5–28.5 | 0.0% | 28.5 | 0.0% | -0.0% | stable |
| `long.scroll.frame_p50_ms` | ms | 16.7 | 16.7 | 16.7–16.7 | 0.0% | 16.7 | 0.0% | 0.0% | stable |
| `long.scroll.frame_p95_ms` | ms | 16.7 | 16.8 | 16.7–16.8 | 0.5% | 16.7 | 0.1% | -0.1% | stable |
| `long.scroll.dropped_pct` | % | 0.00 | 0.00 | 0.00–0.00 | 0.0% | 0.00 | 0.0% | 0.0% | stable |
| `long.scroll.longTaskCount` | tasks | 0.00 | 0.00 | 0.00–0.00 | 0.0% | 0.00 | 0.0% | 0.0% | stable |
| `long.scroll.longTask_ms` | ms | 0.00 | 0.00 | 0.00–0.00 | 0.0% | 0.00 | 0.0% | 0.0% | stable |
| `long.reveal.total_ms` | ms | 6200 | 6214 | 5894–6219 | 0.9% | 6159 | 1.6% | -0.7% | stable |
| `long.reveal.lastClick_ms` | ms | 104.7 | 107.8 | 101.9–109.8 | 2.9% | 105.0 | 2.5% | +0.3% | stable |
| `long.reveal.clicks` | clicks | 93.0 | 93.0 | 93.0–93.0 | 0.0% | 93.0 | 0.0% | 0.0% | stable |
| `long.reveal.domNodes` | nodes | 211824 | 212506 | 211824–212506 | 0.3% | 211824 | 0.0% | 0.0% | stable |
| `long.scrollAll.frame_p50_ms` | ms | 16.7 | 16.7 | 16.7–16.7 | 0.0% | 16.7 | 0.0% | 0.0% | stable |
| `long.scrollAll.frame_p95_ms` | ms | 16.8 | 16.8 | 16.7–16.8 | 0.6% | 16.7 | 0.6% | -0.6% | stable |
| `long.scrollAll.dropped_pct` | % | 0.00 | 0.20 | 0.00–0.33 | 0.0% | 0.00 | 0.0% | 0.0% | stable |
| `long.scrollAll.longTask_ms` | ms | 0.00 | 0.00 | 0.00–0.00 | 0.0% | 0.00 | 0.0% | 0.0% | stable |
| `long.heap_mb` | MB | 236.3 | 236.4 | 236.3–236.4 | 0.0% | 236.4 | 0.0% | +0.0% | stable |
| **Streaming (30 s)** | | | | | | | | | |
| `stream.busy_pct` | % | 25.6 | 27.5 | 24.8–28.8 | 3.0% | 26.0 | 3.2% | +1.6% | **noisy** (at the limit) |
| `stream.script_pct` | % | 11.7 | 12.6 | 11.0–13.1 | 1.6% | 12.0 | 3.7% | +2.8% | small |
| `stream.layoutStyle_pct` | % | 2.06 | 2.31 | 1.98–2.38 | 8.2% | 2.07 | 3.4% | +0.3% | small |
| `stream.frame_p50_ms` | ms | 16.7 | 16.7 | 16.7–16.7 | 0.0% | 16.7 | 0.0% | 0.0% | stable |
| `stream.frame_p95_ms` | ms | 16.7 | 16.8 | 16.7–16.8 | 0.6% | 16.7 | 0.3% | 0.0% | stable |
| `stream.dropped_pct` | % | 0.00 | 0.00 | 0.00–0.00 | 0.0% | 0.00 | 0.0% | 0.0% | stable |
| `stream.longTaskCount` | tasks | 0.00 | 0.00 | 0.00–0.00 | 0.0% | 0.00 | 0.0% | 0.0% | stable |
| `stream.longTask_ms` | ms | 0.00 | 0.00 | 0.00–0.00 | 0.0% | 0.00 | 0.0% | 0.0% | stable |
| `stream.queue_p95_ms` | ms | 0.10 | 0.10 | 0.10–0.10 | 0.0% | 0.10 | 0.0% | 0.0% | stable |
| `stream.toPaint_p50_ms` | ms | 27.0 | 27.3 | 26.7–27.4 | 0.7% | 26.7 | 0.6% | -1.3% | stable |
| `stream.toPaint_p95_ms` | ms | 43.7 | 44.8 | 43.1–45.5 | 1.6% | 41.8 | 5.1% | -4.3% | **noisy** (at the limit) |
| `stream.heap_mb` | MB | 20.0 | 20.1 | 20.0–20.1 | 0.1% | 20.0 | 0.2% | +0.0% | stable |
| `stream.domNodes` | nodes | 2833 | 2874 | 2833–2898 | 0.1% | 2833 | 0.0% | 0.0% | stable |
| **Idle page** | | | | | | | | | |
| `idle.page.busy_pct` | % | 0.02 | 0.03 | 0.01–0.04 | 45.8% | 0.03 | 14.7% | +100.4% | small |
| **Server process** | | | | | | | | | |
| `server.idle.cpu_pct` | % | 0.50 | 0.50 | 0.37–0.50 | 0.0% | 0.37 | 0.0% | -25.0% | small |
| `server.idle.rss_mb` | MB | 91.7 | 93.3 | 89.0–94.1 | 1.2% | 91.7 | 1.1% | +0.0% | stable |
| `server.idleConnected.cpu_pct` | % | 0.25 | 0.32 | 0.12–0.37 | 50.0% | 0.37 | 33.6% | +50.1% | small |
| `server.list.cpuPerReq_ms` | ms | 1.70 | 1.87 | 1.57–1.90 | 7.8% | 1.63 | 18.4% | -3.9% | small |
| `server.list.rss_mb` | MB | 107.3 | 114.3 | 75.6–116.4 | 26.4% | 108.4 | 4.5% | +1.1% | **noisy** |
| `server.stream.cpu_pct` | % | 2.22 | 2.49 | 2.05–2.65 | 1.5% | 2.25 | 2.9% | +1.4% | stable |
| `server.stream.relayCpu_pct` | % | 0.60 | 0.69 | 0.60–0.73 | 5.6% | 0.63 | 5.3% | +5.5% | small |
| `server.stream.rssPeak_mb` | MB | 164.1 | 200.9 | 106.5–213.8 | 45.4% | 120.9 | 42.0% | -26.3% | **noisy** |

72 metrics: 42 stable, 20 small, 10 noisy. What the numbers say about v0.11.7 (provisional): the home page is ready in
~0.1 s with 223 KB of JS and no long task; a conversation switch takes ~58 ms, but the 6 760-entry conversation takes
~520 ms (445 ms of it the 6.9 MB fetch) and ends at 2 694 DOM nodes; revealing all of it costs 93 clicks, 6.2 s, 211 824
DOM nodes and a 236 MB page heap; streaming keeps the page main thread ~26% busy (script ~12%) with a delta painted
~27 ms after it arrives and no frame dropped or long task. The frame metrics are flat (every frame 16.7 ms, 0 dropped,
0 long tasks) because headless Chromium locks `requestAnimationFrame` to 60 Hz and this app never blocks the main thread
for >50 ms in these scenarios: they only move if a change introduces jank; the sensitive metrics are the busy %,
work_ms, `toPaint`, `long.open.*`, `long.reveal.*`, DOM nodes and heap.

## Noise comparison (run 1 vs run 2, same code, back to back)

```
bun scripts/bench.ts --compare docs/perf/bench-v0.11.7.json docs/perf/bench-v0.11.7-run2.json
```

Result: **No metric is worse** (exit 0). Of 72 metrics, 70 are inside both the 5% threshold and their floor. Two moved
beyond 5% and their floor but sit inside their noise bar, and are listed as "noise", not counted:
`switch.warm.work_ms` (+6.4%, noise bar 10%) and `server.stream.rssPeak_mb` (−26.3%, noise bar 68%). Fixed-work speed
between the two runs: benchmark process 28.1 → 27.8 ms (−1.1%), browser 160.1 → 158.6 ms (−0.9%). With a bare "5% and
the floor" rule, `switch.warm.work_ms` would have been marked worse between two runs of identical code; the noise bar
below is what prevents that.

How the noise was handled, per class:

- **stable (42)**: IQR and run-to-run change ≤3%; the 5% threshold applies as it is. This includes the metrics that
  most often decide a performance change: `long.open.total_ms`, `long.open.fetch_ms`, `long.reveal.total_ms`,
  `long.open.heap_mb`, `long.heap_mb`, the DOM node counts, `stream.toPaint_p50_ms`, `server.stream.cpu_pct`,
  `server.idle.rss_mb`, and every byte count.
- **small (20)**: noisier than 3% in percent but the noise (IQR or run-to-run change, in the metric's unit) is below its
  floor: a few ms on a tens-of-ms metric, hundredths of a percent of a core for the server's idle CPU (`ps` reads CPU
  time at 10 ms resolution), tenths of a millisecond on a 1.7 ms API call. `--compare` ignores changes below the floor,
  so these cannot produce a finding, and they cannot confirm a small improvement either.
- **noisy (10)**: noisier than 3% and larger than the floor. Measured spread above; causes are [inference] unless
  stated: `load.cold.fcp_ms` is bimodal (observed: 36–44 ms in 3 of the 10 measured rounds of these two runs, 80–92 ms in
  the rest; the earlier 07:20 run had 48 and 80–100: use `lcp_ms`); `switch.cold.*` carry the server's first read of each
  conversation, and `switch.cold.p90_ms` is the first visit (observed above); `server.*rss*` depend on when the server's
  garbage collector last ran (observed: 99–214 MB peak over identical streams); the rest are main-thread time sums that
  include whatever else the machine did meanwhile.

**The rule `--compare` applies.** A change counts only if it is (1) above the threshold (default 5% of A's median) and (2)
above the metric's floor in its unit, and (3) above **1.5 × the larger IQR** of the metric's rounds in the two reports
(`SPREAD_MARGIN` in `tests/support/bench-stats.ts`: two medians of five rounds differ by about 0.6 IQR by chance, so 1.5
IQR is about 2.7 standard deviations). Metrics that fail only (3) are printed as "noise" with their bar and listed
separately. Consequently a noisy metric needs a large change to count: from these runs `switch.cold.median_ms` needs
≳20%, `long.open.work_ms` ≳12%, `server.stream.rssPeak_mb` ≳68%. Where the final comparison hinges on one of them, the
remedy is more rounds, not a looser rule — and a targeted run is much steadier than the full one: with `--only
server,switch --runs 5` (6 rounds, 3 min) the same scenario gave `switch.cold.median_ms` 61.2 ms with IQR 3.7% (rounds
60.2–64.5), `cold.work_ms` 85.5 ms IQR 2.2%, `warm.median_ms` 58.3 ms IQR 1.8%, `warm.work_ms` 83.1 ms IQR 2.4%
(a diagnostic run, valid but provisional (load 3.9 at its start), same conditions; not committed), against 11% / 10% / 4% / 6% in the full runs. So for a
noisy scenario family run both sides as `--only server,<scenario> --runs 9` back to back (switch: 31 s per round) and
compare those files. A subset run is only comparable with another subset run of the same `--only`.

## Rules for the final comparison

1. **Measure the baseline again in an exclusive quiet window** (load average <3 before it starts — the harness refuses
   otherwise — no other agent running builds, tests or browsers). These files are provisional: this machine was loaded.
2. **Compare only runs made back to back in the same session**, same command, same `--only`, same `--runs`. Absolute levels
   are *not* stable across sessions on this machine, even for identical code and with identical fixed-work calibrations:
   an earlier run of the same v0.11.7 code at 07:20 the same day (an earlier revision of this harness; same fixtures,
   same dist; not committed) gave `stream.busy_pct` 14.0% (now 25.6 / 26.0), `stream.script_pct` 6.7% (11.7 / 12.0),
   `switch.cold.median_ms` 46.7 (60.2 / 57.9), `switch.warm.median_ms` 43.5 (57.1 / 56.7), `long.open.work_ms` 160.9
   (191.4 / 200.8), `server.stream.cpu_pct` 1.49% (2.22 / 2.25), while the latency-bound `load.cold.listReady_ms` (107.7 →
   104.0 / 107.0) and `long.reveal.total_ms` (6 125 → 6 200 / 6 159) hardly moved. Stream-only diagnostic runs minutes before run 1 gave
   21.6–23.3%. The cause is unexplained (the calibrations did not move: 28 ms in the benchmark process then and now; the
   browser calibration was added later); CPU-bound metrics are what shifts, by 20–80%. A candidate measured hours after
   its baseline is not comparable.
3. **Order**: baseline, candidate, baseline again (A B A′): `bun scripts/bench-gate.ts` does it, on a quiet machine. The
   candidate counts as a change only if it differs from A by more than A differs from A′, in addition to the `--compare`
   rule above (the gate's exit 5 is "A differs from A′").
4. **A provisional or invalid report is not evidence**: `--compare` prints PROVISIONAL for any report whose load, power
   or calibration conditions were off, and refuses (exit 3) a report whose run spans a sleep.
5. **Do not read** the flat metrics (frame times, dropped %, long tasks, which are 0 in every scenario at v0.11.7) as proof
   that a change is smooth: they can only get worse. A real improvement shows in the busy %, work_ms, `toPaint`,
   `long.open.*`, `long.reveal.*`, DOM nodes and heap.

## Files

| file | what |
| --- | --- |
| `scripts/bench.ts` | the harness: rounds, scenarios, report, `--compare` |
| `scripts/bench-gate.ts`, `scripts/lib/bench-gate.ts` | the A B A′ gate: waits for a quiet machine, builds, interleaves, compares (the wait and the exit code are in the lib, tested in `tests/unit/bench-gate.test.ts`) |
| `tests/support/bench-fixtures.ts` | the seeded library and the scripted fake omp binary |
| `tests/support/bench-page.ts` | the in-page recorder (`window.__bench`: long tasks, LCP, scroll, reveal, WebSocket delta timing) |
| `tests/support/bench-stats.ts` | summaries and the comparison rule |
| `tests/unit/bench-footprint.test.ts` | the footprint parsers and the compare rules for the memory gate |
| `docs/perf/bench-v0.11.7.json` | run 1: per-metric values of every round, p90, IQR, the round log with loads and calibrations, power events |
| `docs/perf/bench-v0.11.7-run2.json` | run 2, same conditions, started 5 s after run 1 ended |
