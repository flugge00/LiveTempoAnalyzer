# Plan

## Architecture decisions

| Decision | Choice | Why |
|---|---|---|
| Hosting | Static site on GitLab Pages | All analysis is cheap enough for a phone. No server means no cost, no uploads and no privacy questions. |
| Tech | Plain ES modules, no framework, no build | Nothing to install or break. Loads fast on phones. CI just copies files. |
| Tempo method | Classic DSP (onset flux + comb autocorrelation + HMM) | Runs in real time on a phone and is precise to under 1 BPM. The task (drift over minutes) doesn't need ML. |
| Offline analysis | Web Worker, same DSP code as live | Live and offline numbers agree, and the UI stays responsive. |
| Sections | In-browser self-similarity segmentation | Works on GitLab Pages. An ML model can be added later as an optional backend (see Phase 3). |
| Storage | IndexedDB, per device | Simple and private. Export/import JSON for sharing. |

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

## Phase 2: next up

- [ ] Import sessions from a file, with audio included in the export (sharing = sending a file)
- [ ] Tune section detection on more real rehearsal recordings (names are shaky; boundaries mostly OK)
- [ ] PWA: installable on phones/tablets, works offline (service worker + manifest)
- [ ] Compare sessions: overlay the same song across rehearsals ("are we getting steadier?")
- [ ] Manual section editing: drag boundaries, split/merge
- [ ] Downbeat detection so bars start on the "1" automatically (today: choose the bar offset)
- [ ] Optional click/visual pulse at the start tempo for count-ins

## Phase 3: optional heavier analysis

Better section labels (verse/chorus/bridge) from a trained model such as *All-In-One* (Kim & Nam, 2023), which also gives beats and downbeats. It needs PyTorch and roughly 10–60 s per song on a CPU, so it cannot run on GitLab Pages. Options:

1. **Small self-hosted API** (FastAPI + model in Docker). The web app sends the recording only when the user presses "AI sections". It could run on a home server or a cheap VPS.
2. **ONNX export in the browser** (onnxruntime-web). Worth a spike: it's heavy (tens of MB) but would keep everything serverless.

The rest of the app stays static either way.
