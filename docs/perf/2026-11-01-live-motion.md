# Live animations on a long reply (v0.17.0)

**Question.** The person sees the live animations stutter at times. The hypothesis was that the shimmer band, a layer as
tall as the reply, is painted again as the reply grows. Measured before replacing it with a caret, and after.

**How.** `bun scripts/long-run.ts --scenario motion --lines 3000 --stream-s 40 --animations on|off --intensity normal|lively
[--dist <build>]`: an isolated server and fake omp; a small conversation; one prompt runs a subagent step (a task with three
subagents), then streams an answer of about 3000 lines (240 000 characters, prose with code blocks and lists; 122 000 px
tall when done) over 40 s, then the turn ends (the burst). A Chrome trace covers the whole turn plus 2.5 s; per 3 s window
it counts animation frames (an in-page `requestAnimationFrame` loop; a gap of more than one frame at 60 Hz counts the frames
it skipped as dropped), `Paint` and `Layout` events of the page's main thread, `RasterTask` time in its renderer, and its
main thread's `RunTask` time. Headless Chromium, 1440 × 900, Apple M4 Pro; another agent's e2e suite was running on the
machine at the same time, so main-thread time varies by ±1.5 s between runs of the same build. Before and after runs
alternated, twice each. "Before" is the v0.16 build (shimmer); "after" is the caret and the glowing running time.

**Results** (whole turn, ~70 s; mean of 2 runs):

| Build | Animations | Frames | Dropped | Paints | Layouts | Main thread (s) |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| before | off | 4226 | 0 | 5386 | 2092 | 12.2 |
| before | on, Normal | 4225 | 0 | 7080 | 2097 | 12.9 |
| before | on, Lively | 4226 | 0 | 7044 | 2094 | 12.9 |
| after | off | 4223 | 0 | 5416 | 2095 | 11.9 |
| after | on, Normal | 4224 | 1.5 | 5476 | 2094 | 13.5 |
| after | on, Lively | 4223 | 0.5 | 5461 | 2096 | 12.8 |

Renderer raster time was 140–176 ms in every run (raster done in the GPU process is not counted).

**What it shows.**
- The shimmer cost about **1 700 paints more per turn (+31 %)** than no animations: its layer covered the whole reply and was
  painted again as the reply grew. The caret and the glow cost about **60–90 more (+1–2 %)**.
- **No dropped frames could be attributed to the animations**, before or after: 0–2 frames of 4 226 in every configuration,
  animations off included. The main thread's time is within the noise of the machine.
- So the stutter the person sees was not reproduced here. What differs from this trace: a headed window on a real display
  (and its refresh rate), the person's own conversations (longer histories, the agent graph open beside them), and a machine
  doing other work. If it comes back, `--headed` and the person's session (`--session <file>`, the goal scenario) are the
  next things to trace.

**Changed.** The shimmer band is gone (v0.17.0): a caret breathes at the end of the text being written (a pseudo-element of
2 × 16 px, opacity only), and the running time glows (an accent copy of the label over it, opacity only).
