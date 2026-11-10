# Atria Mobile

A script that runs **on top of Atria** and reshapes its UI for a phone — the same
idea Ben described in the Atria Pod chat ("just a script that runs over Atria and
changes the UI"). No server, no app: it runs in your browser.

## What it does (on screens < 820px wide or touch devices)

| Feature | How |
| --- | --- |
| **Sidebar → drawer** | Finds the tall, left-pinned nav by geometry, slides it off-screen, adds a ☰ button. Frees the content column. |
| **Single-column ad feed** | Finds containers of 6+ big, similar, media-heavy cards (grid or masonry) and stacks them. 1 or 2 columns in settings. |
| **Full-width panels** | Fixed-position detail panels/modals wider than the screen are pinned to the screen. |
| **Battery saver** | Pauses off-screen videos, lazy-loads images, turns off `backdrop-filter` (the usual phone-overheating culprits). |
| **Settings + debug report** | ⚙ button. "Debug report" copies a JSON snapshot of what it found — paste it back to tune selectors. |

Desktop is untouched: everything is scoped under `html.am-on`.

> **Heads-up:** Atria is behind a login, so this was built and tested against mock
> pages that imitate a typical sidebar + ad-grid layout, *not* the live app. If
> something on the real site is off, tap ⚙ → **Debug report** and send it over.

## Install on your phone (Android)

Chrome and Samsung Internet can't run userscripts. **Firefox for Android** can,
and it takes ~2 minutes:

1. Install **Firefox** from the Play Store.
2. In Firefox: menu (⋮) → **Add-ons** → search **Violentmonkey** → **Add to Firefox**.
3. In Firefox open Violentmonkey (menu → Add-ons → Violentmonkey → settings) →
   **＋ New** → delete the template → paste the whole contents of
   [`atria-mobile.user.js`](./atria-mobile.user.js) → **Save**.
   (If this repo is public you can instead open the *Raw* link of the file in
   Firefox and Violentmonkey offers to install it.)
4. Open Atria in Firefox, log in, and make sure **menu → Desktop site is OFF**.
5. You should see ☰ and ⚙ buttons at the bottom-left.

### No-install fallback: bookmarklet

Works in Chrome / Samsung Internet, a bit clunkier:

1. Copy the one-line contents of [`dist/bookmarklet.txt`](./dist/bookmarklet.txt).
2. Bookmark any page, then edit the bookmark: name it `atria`, paste the text as the URL.
3. On Atria, tap the address bar, type `atria`, and tap the **bookmark** suggestion
   (not a search suggestion). Do this once per page load.

## Develop

```bash
node build.js        # regenerates dist/ (bookmarklet + minified script)
```

Tune the heuristics in `atria-mobile.user.js`: `findSidebar`, `evalGrid`, `fixWide`.
Default breakpoint is `BP = 820`.
