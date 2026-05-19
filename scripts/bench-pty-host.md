# PTY Host Phase 1 — bench log

## Method
- 6 panes, 3 running `for ($i=0;$i-lt200000;$i++){echo $i}` (pwsh).
- Measure: keystroke→echo latency in a quiet 4th pane during spew (eyeball /
  screen capture frame count), and main-process CPU% (Task Manager).

## Baseline (pre-Phase-1, commit cd85268)
- Echo latency under spew: <fill>
- main CPU under spew: <fill>

## Phase 1 (post-Task-8)
- Echo latency under spew: <fill>
- main CPU under spew: <fill>  (expect: dropped — work moved to host proc)
- pty-host CPU under spew: <fill>

## Success criterion
main-process CPU under spew drops substantially (analysis moved off it) and
echo latency in the quiet pane no longer degrades under spew. Renderer-side
latency wins are Phases 2–3 — not expected here.
