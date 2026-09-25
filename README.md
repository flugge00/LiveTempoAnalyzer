# Live Tempo Analyzer

See whether your band drifts. Record one song at a time: put a phone, tablet or laptop in the rehearsal room, type which song you're playing, press **Start** (or **Count in**), and press **Stop** when the song ends. Watch the tempo in a moving graph while you play. Afterwards, open the recording to see song sections, per-bar tempo, how tight the timing was, and which beat of the bar you rush. Record the same song again next rehearsal and compare the takes.

Everything runs in the browser. Audio never leaves the device, and there is no server, so it can be hosted on GitHub Pages.

https://flugge00.github.io/LiveTempoAnalyzer/

## Features

- **Live mode:** name the song (suggestions come from earlier recordings, and picking one fills in its target tempo), then microphone → tempo reading every 0.25 s, big BPM readout, drift vs. start (or vs. a target tempo), trend (BPM/min), steadiness, and a moving graph. Markers (press `M`). The target tempo sits next to the Start button. ×2 / ÷2 in Settings fix half/double-tempo readings. The screen stays awake while recording.
- **Count-in:** 1–5 bars of click and/or a full-screen flash at the target tempo, then silence, so the band plays free.
- **Session recording:** the audio is recorded alongside the live readings (optional), so every live session can be analyzed in detail afterwards.
- **File analysis:** drop an mp3/wav/m4a/ogg/webm and get:
  - a tempo curve (8 s window) and per-bar tempo, with click-to-play audio synced to the graph
  - automatically detected **song sections** (Intro / Verse / Chorus / Bridge / Outro), with average tempo, drift, steadiness, timing jitter and attack spread per section. Edit them by hand: drag boundaries on the chart, split at the playhead, join, rename.
  - **bars that start on the "1"**, found automatically (a beat counter during playback lets you check), or set by hand
  - **timing inside the bar:** average early/late offset per beat position (e.g. "beat 4 is 8 ms early")
  - plain-language insights ("Choruses ran 2.4 BPM faster than verses")
- **Compare takes:** tick sessions of the same song and overlay their tempo curves, with a take-by-take table ("are we getting steadier?").
- **Sharing:** export one or more sessions as a `.zip` (analysis + audio) and import it on another device. CSV export for spreadsheets.
- **Works offline and installs as an app** (Add to Home Screen / Install) thanks to a service worker.
- **Dark / light toggle** in the header. Follows the OS setting until you tap it once; after that your choice is remembered on this device.
- **Sessions** are stored locally in the browser (IndexedDB).
- A **demo recording** (Analyze tab, or `?demo` in the URL) shows what the analysis looks like.

## Run locally

Microphone access requires `https://` or `localhost`. Any static file server works:

```powershell
python -m http.server 8000
# open http://localhost:8000
```

There is no build step and there are no dependencies. The code is plain ES modules.

The service worker is not registered on `localhost`, so you always get fresh files while developing. Add `?sw` to the URL to test offline mode locally. When you add a file under `js/`, also add it to `FILES` in `sw.js`; the tests check this. The icon (favicon, home-screen icon, `apple-touch-icon`) is drawn by `python tools/make-icons.py`, which writes `icons/icon.svg` and the PNGs from the same coordinates.

## Deploy to GitHub Pages

1. Push this repo to GitHub, default branch `main`.
2. In the repo's **Settings → Pages**, set *Source* to **GitHub Actions** (one-time, manual step).
3. The included `.github/workflows/deploy.yml` runs the tests, copies the app (`index.html`, `sw.js`, `manifest.webmanifest`, `css/`, `js/`, `icons/`) into `_site/`, stamps the commit into `sw.js` so installed apps notice the update, and publishes to Pages on every push to `main`.
4. The site appears at `https://<user>.github.io/<repo>/` (linked from the Actions run and from *Settings → Pages*). Pages serves over HTTPS, so the microphone works on phones too.

## Tests

The DSP code is tested against synthetic drum tracks with known tempo, drift, jitter, a rushed beat, and verse/chorus structure:

```powershell
node tests/run.mjs        # any Node >= 18
.\tests\run.ps1           # Windows without Node: uses VS Code's bundled runtime
```

Real recordings: put them in `test_audio/` (git-ignored by default so rehearsals stay private), then:

```powershell
node tools/decode-audio.mjs   # decodes with headless Edge/Chrome into test_audio/.cache
node tests/real-audio.mjs     # checks there are no half/double-tempo jumps, offline and live
```

## How it works

| Stage | File | Method |
|---|---|---|
| Onset strength | `js/dsp/onset.js` | 36 log-spaced bands, log-compressed spectral flux, ~172 frames/s |
| Tempo | `js/dsp/tempo.js` | Autocorrelation of an 8 s window, harmonic comb scored on a 0.25%-step BPM grid (sub-BPM precision). HMM over the grid resolves half/double tempo: forward filter live, Viterbi offline. |
| Octave consistency | `js/dsp/tempo.js` (`OctaveResolver`) | A song's tempo never jumps ×2/×½/×3 mid-song, but a half-time verse *sounds* like half the tempo. Per take (continuous playing), readings at those ratios are folded onto one canonical tempo, chosen by majority vote weighted by a tempo prior. Offline applies the final decision to the whole take; live rescales what's already plotted if it changes its mind. Unrelated readings are dropped as glitches unless they persist 4 s (a real tempo change). |
| Beats | `js/dsp/beats.js` | Dynamic-programming beat tracker (Ellis 2007) guided by the time-varying tempo curve; per-beat tempo from a sliding linear fit; bar tempo; beat-position profile; attack spread |
| Downbeats | `js/dsp/downbeat.js` | Per beat: harmonic change, low-band (kick) attack, onset strength. The snare backbeat decides which beats can be "1" for the whole take; harmony and kick pick between the rest; a Viterbi pass over position-in-bar allows an odd bar only when several bars agree. |
| Sections | `js/dsp/segment.js`, `js/analysis/sections.js` | Beat-synchronous chroma + cepstral timbre → self-similarity matrix → Foote novelty boundaries → clustering of repeated parts → heuristic names. User edits are stored as times on the session and survive re-analysis. |
| Sharing | `js/store/share.js`, `js/store/zip.js` | Stored-only zip: `<session>/session.json` + `<session>/audio.webm` |
| Pipeline | `js/analysis/` | Runs in a Web Worker; audio decoded and resampled to 22.05 kHz |
| UI | `js/ui/` | Canvas chart (zoom/pan/pinch, tooltip, sections, playhead), views, IndexedDB storage |

**Measured on synthetic tracks:** tempo within ±0.35 BPM on a drifting, humanized track; 98.6% of beats found within 30 ms; a 25 ms rushed beat 4 measured as 24.9 ms.

### Known limits

- Which octave a whole song is read in can still be ambiguous (a 174 BPM track can reasonably read as 87), but it stays consistent within the song. Set a target tempo, or press ×2 / ÷2 once to fix the whole song.
- Section names are guesses from repetition and loudness. Boundaries are usually right, and both are easy to fix in the sections editor.
- The automatic "1" relies mostly on chord changes and a snare backbeat. In songs without either, check the beat counter and set the bar start by hand.
- *Attack spread* comes from a single mixed recording. Use it to compare sessions, not as an absolute measure of how tight individual players are.
- Stored sessions live in one browser on one device. Share them by exporting a .zip. There is no automatic sync.
