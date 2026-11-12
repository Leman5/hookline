# Hookline

A small personal music player for the phone that plays **only the best part of each song**, then moves on by itself. It has two playlists: **Commute** (calm, slow) and **Gym** (high energy).

It's a static web app installed to the home screen (a PWA), with about 19 KB of gzipped JavaScript, no framework and no analytics.

## How songs play

| Situation | What you hear |
|---|---|
| Screen on, song has a YouTube video | The **full song** in the visible YouTube player, cut to a ~65–75 s hook |
| Another tab or window, and the browser keeps YouTube playing (desktop) | Still the **full song** |
| Phone locked and the browser pauses YouTube | The same song continues as Apple's free **30 s preview** on a plain `<audio>` element, with lock-screen controls |
| Screen back on | Back to the **full song**, picking up where the hook had got to |
| A music file you imported | The **full file**, with chorus/drop detection run on your phone; keeps playing when locked |

Hookline never forces YouTube to play in the background. It switches to the preview only when the browser has actually paused or stalled the video. While YouTube plays, the app keeps a silent audio track running, so it already owns a playing media element. When YouTube stops, that element takes over with the audio version of the current song, without a gap. YouTube's terms only allow background play with YouTube Premium, and Chrome on Android normally pauses embedded videos when the screen locks.

### Highlight detection (your own files)

This runs in a Web Worker at import, and the result is cached by file hash.

1. Decode the file to 11 kHz mono.
2. Per frame: loudness, spectral flux (onsets), low-band flux, centroid and chroma.
3. Tempo from the autocorrelation of the onset curve. Beats are phase-locked to the kick, and the downbeat is taken from low-band energy.
4. A beat-synchronous chroma self-similarity matrix shows which sections repeat (the chorus), and a novelty curve marks the boundaries.
5. Each bar-aligned window is scored on loudness, repetition, onset density, entrance jump, exit drop and fit to the target length, with a penalty for intro and outro.
6. Gym gets up to two distinct highlights (never the same chorus twice). Commute gets one longer one.

You can edit any highlight on the song's **Edit** screen, by dragging or with 5 s or 0.5 s nudges. Your edits are never overwritten.

## Install on Android (Chrome)

1. Open the seed link you were given once in Chrome on the phone. It loads your two playlists.
2. Chrome menu ⋮ → **Add to Home screen**, then open Hookline from the icon.
3. **Oppo / ColorOS:** Settings → Apps → Chrome → Battery usage → allow background activity (No restrictions). Without this, ColorOS may kill playback when locked.

### Phone checklist

- [ ] Play **Gym** with the screen on: full songs from YouTube, each moves on after its hook.
- [ ] Lock the phone: music keeps going (full song if Chrome allows it, otherwise the 30 s preview), and the next songs play automatically.
- [ ] Lock-screen controls work: pause, play, next, previous, artwork.
- [ ] Unlock: the current song switches back to the full YouTube version.
- [ ] **Commute** works the same way.
- [ ] Bluetooth headset buttons work.
- [ ] An incoming call pauses playback, and it doesn't restart on its own.
- [ ] Settings → Playback log shows no `gap` entries longer than a second while locked.

## Your song list stays private

The repo has no listening history in it. Seeds are built locally into `private/`, which is git-ignored, and arrive on the phone as a link fragment (`#seed=…`). The browser never sends a fragment to the server. The app stores everything in the browser on your phone.

```bash
# 1. Songs (from your Spotify history) as TSV: c|g <TAB> title <TAB> artist
#    private/seeds-input.tsv
# 2. Find each song in the free iTunes catalog (no key needed)
NODE_USE_ENV_PROXY=1 node scripts/resolve-seeds.mjs private/seeds-input.tsv private/seeds.json in
# 3. Optional: find full-song YouTube videos (free YouTube Data API key in private/youtube-key.txt;
#    about 100 songs per day on the free quota, and re-running continues)
node scripts/find-youtube.mjs private/seeds.json
# 4. Open the link in private/seeds-link.txt on the phone
```

## Development

```bash
npm ci
npm run fixtures   # synthetic test songs (needs ffmpeg)
npm test           # analysis, matching and seed tests
npm run dev
npm run build      # typecheck, build and gzip size budget (40 KB)
```

Pushing to `main` runs the tests and deploys `dist/` to GitHub Pages.

## Credits

- Song previews are provided courtesy of iTunes / Apple Music. Each song links to Apple Music and Spotify.
- Full songs play through the official YouTube embedded player.
- The idea comes from bajao.pages.dev. Hookline is an independent reimplementation and doesn't use bajao's code, catalog or assets.
