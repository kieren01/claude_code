# Ad Swipe

A faster, friendlier front end for the Facebook Ad Library. It runs on your own computer.

It fixes three problems with the Ad Library:

| Problem | What this does |
| --- | --- |
| You can't rewind the video | A real player: drag the bar, press **J / L** for ±10 s, **← / →** for ±5 s, **, / .** to step one frame, **[ / ]** to change speed, loop, fullscreen. |
| You can't save ads | A **swipe file** with folders, tags, notes and timestamped marks ("hook lands at 0:03"). Videos are downloaded to your computer, so they never expire. |
| It lags | Nothing plays until you open it, previews load a few at a time as you scroll, saved videos play from your own disk with instant seeking, and long lists render in pages. |

## Run it

You need [Node.js](https://nodejs.org) 18 or newer. There is nothing to install.

```bash
cd adswipe
node server.js
```

Open <http://localhost:4300>. Everything you save lives in `adswipe/data/` (a plain JSON file plus the videos and thumbnails), so you can back it up by copying that folder.

## Getting ads in

1. **Paste a link.** Click **+ Add ad** and paste an Ad Library link ending in `?id=…`, an ad ID, or a direct video URL.
2. **Drop a file.** Drag any `.mp4` / `.mov` / `.webm` onto the page. This is the fallback when Facebook hides a video from the app.
3. **Search** (optional). Add a Meta access token in Settings (⚙). Meta's official API only returns political and social-issue ads everywhere, plus every ad shown in EU countries. It does not return normal commercial ads in the US, so for those use a link.

## Shortcuts in the player

`Space` play/pause · `J`/`L` ∓10 s · `←`/`→` ∓5 s · `,`/`.` previous/next frame · `[`/`]` slower/faster · `0`–`9` jump to 0–90 % · `N` mark this moment · `S` save · `R` loop · `M` mute · `F` fullscreen

## Notes and limits

- Pulling the video out of a Facebook ad page is best effort. Facebook changes that page without notice and sometimes withholds the video from anything that is not a logged-in browser. When that happens the app says so and you can drop the file in instead.
- The server only listens on `127.0.0.1`, only fetches from Facebook/Instagram hosts, and rejects requests from other websites.
- Check for yourself that saving and using ads fits Meta's terms and the ads' copyright. This tool is for research and inspiration.

## Develop

```bash
npm test          # unit tests for link parsing and video extraction
PORT=4400 ADSWIPE_DATA=/tmp/adswipe node server.js
```
