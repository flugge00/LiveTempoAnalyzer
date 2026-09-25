# Plan

## Architecture decisions

| Decision | Choice | Why |
|---|---|---|
| Hosting | Static site on GitHub Pages | All analysis is cheap enough for a phone. No server means no cost, no uploads and no privacy questions. |
| Tech | Plain ES modules, no framework, no build | Nothing to install or break. Loads fast on phones. CI just copies files. |
| Tempo method | Classic DSP (onset flux + comb autocorrelation + HMM) | Runs in real time on a phone and is precise to under 1 BPM. The task (drift over minutes) doesn't need ML. |
| Offline analysis | Web Worker, same DSP code as live | Live and offline numbers agree, and the UI stays responsive. |
| Sections | In-browser self-similarity segmentation, hand-editable | Works on static hosting. An ML model can be added later as an optional backend (see Phase 3). |
| Storage | IndexedDB, per device | Simple and private. Sharing = a .zip with the session and its audio. |
| Offline / install | Service worker + web manifest | Works in a rehearsal room without Wi-Fi. Each deploy stamps a new cache version, and the app asks before it reloads. |

## Phase 1: MVP (done)

- [x] Live microphone tempo with moving graph, start/stop, drift/trend/steadiness tiles
- [x] Target tempo + tolerance band, ×2/÷2 octave fix, markers, noise gate, input selection, wake lock
- [x] Audio recording during live sessions → detailed analysis afterwards
- [x] File upload analysis (mp3/wav/m4a/…): tempo curve, beats, per-bar tempo
- [x] Song-section detection with renamable names; per-section stats
- [x] Timing stats: jitter, attack spread, beat-position-in-bar profile
- [x] Inspection chart: zoom/pan/pinch, tooltip, playback synced to graph
- [x] Sessions list, CSV/JSON export, demo recording
- [x] Tests on synthetic signals; GitLab CI (test + Pages)
- [x] Octave consistency: no half/double-tempo jumps within a song (fixed on the "Memories" rehearsal; real-recording regression check in `tests/real-audio.mjs`)

## Decisions from the band (2026-09-24)

- Devices: phone or tablet in the rehearsal room; laptop for reviewing recordings and longer sessions.
- Sharing: exporting/importing a file is enough. No backend.
- Time signatures: mostly 4/4, occasionally others (the selector covers it).
- Recording audio by default: OK.

## Decisions from the band (2026-09-25)

- One recording usually holds one song.
- Compare: pick the takes by hand (no song field and no automatic matching).
- Count-in: click, flash or both, chosen in Settings.

## Phase 2 (done, except section tuning)

- [x] Export sessions as a .zip (session + audio). Import from Sessions → Import, by drag and drop, or on the Analyze tab. On import, the more recently edited copy wins.
- [x] PWA: installable on phones/tablets, works offline (`sw.js`, `manifest.webmanifest`, `icons/`). Asks before switching to a new version.
- [x] Compare sessions: tick takes on the Sessions tab → overlaid tempo curves (absolute or change from start), a take-by-take table, and plain-language trends
- [x] Manual section editing: drag boundaries on the chart strip (snaps to beats), split at the playhead, join with the next section, rename with suggestions, reset to automatic. Sections with the same name share a colour.
- [x] Downbeat detection (`js/dsp/downbeat.js`): harmony change + kick + snare backbeat parity → Viterbi over the position in the bar. "Bar starts on beat: Auto" is the default. A beat counter during playback lets you check it by ear. Older sessions are re-analyzed once when opened.
- [x] Count-in at the target tempo: 1–2 bars of click and/or full-screen flash, then silence. Starts recording if needed and drops a "Count-in" marker. The start tempo is measured after it.
- [ ] Tune section detection on more real rehearsal recordings (names are shaky; boundaries mostly OK). Band corrections made with the new editor, exported as .zip, can now serve as ground truth for tuning.

## Next ideas

- Check the automatic downbeat on more real songs (on the two test recordings the phase is stable, but only by ear can we confirm beat 1 vs 3 on "Memories")
- Meter detection (suggest 3/4 or 6/8 when it fits better than 4/4)
- Receive shared files straight from messaging apps (Web Share Target, Android)

## Phase 3: optional heavier analysis

Better section labels (verse/chorus/bridge) from a trained model such as *All-In-One* (Kim & Nam, 2023), which also gives beats and downbeats. It needs PyTorch and roughly 10–60 s per song on a CPU, so it cannot run on static hosting like GitHub Pages. Options:

1. **Small self-hosted API** (FastAPI + model in Docker). The web app sends the recording only when the user presses "AI sections". It could run on a home server or a cheap VPS.
2. **ONNX export in the browser** (onnxruntime-web). Worth a spike: it's heavy (tens of MB) but would keep everything serverless.

The rest of the app stays static either way.
