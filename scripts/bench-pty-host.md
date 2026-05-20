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

---

# PTY Host Phase 2 — zero-copy MessagePort transport

## What shipped (commits a88783e..ce07165)
- `concatU8` hoisted to `@shared/utils` (3 dup'd copies → one).
- `PaneDataBuffer` operates on `Uint8Array` end-to-end (no UTF-16↔UTF-8 transcode at flush).
- node-pty in Buffer mode (`encoding:null`) — raw bytes from native to buffer.
- Wire protocol: `HostControl{kind:'attachDataPort'}` + binary `pane-data-frame` (single contiguous ArrayBuffer per flush).
- Supervisor: `sendWithPorts`, `onReady`, `onRespawn` hooks; ports forwarded to host.
- Host entry: `dataPort.postMessage(frame, [frame])` — true zero-copy on the hot path (single-window fast path; fan-out re-encodes per port).
- Per-window `MessageChannelMain` wiring (main↔renderer); rebuild-all on host respawn.
- Preload owns the renderer port behind unchanged `window.cmux.panes.onData` surface.
- Main hop dropped: `ipc.ts` no longer forwards `paneData`; bytes never touch main.
- Per-pane streaming `TextDecoder({stream:true})` for detectors (fixes latent UTF-8 split-codepoint bug).

## Smoke checklist (manual, packaged build)
1. `npm run build && npx electron .` (kill any installed vMux first).
2. Open 6 panes, 3 running pwsh spew loop.
3. Type in a 4th quiet pane during spew — echo should feel snappier than Phase 1 baseline (no 16 ms IPC structured-clone hop on every flush).
4. Open detached window for one session (sidebar context menu) — its terminal should receive bytes (its own channel).
5. Kill `vmux-pty-host` PID in Task Manager → supervisor respawns; channels rebuilt; bytes resume in both main + detached windows within ~1 s.
6. Quit via Ctrl+Q — no orphan `vmux-pty-host` or conhost processes.

## Phase 2 measurements (record after manual smoke)
- main CPU under 6-pane spew vs. Phase 1:  <fill>  (expected: further drop — no IPC paneData fanout cost)
- pty-host CPU under spew:                 <fill>
- Echo latency (quiet pane during spew):   <fill>  (expected: ~halved — one structured-clone hop removed)
- Respawn recovery time (host kill→bytes): <fill>  (expected: <1 s)
