# Dutch → English Tab Translator (Chrome extension)

Live-translates the audio of the current Chrome tab from **Dutch to spoken English**, with
on-page captions, using OpenAI's `gpt-realtime-translate`. Built following the OpenAI cookbook guide
[Build Live Translation Apps with gpt-realtime-translate](https://developers.openai.com/cookbook/examples/voice_solutions/realtime_translation_guide)
(browser-tab pattern).

## Install (unpacked)

1. `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this folder.
2. Click the extension icon, paste your OpenAI API key, **Save**.
3. Open a tab playing Dutch audio, click the icon → **Translate this tab**. Click again to stop.

Requires Chrome 116+.

## How it works

```
popup ──streamId──▶ background (service worker) ──client secret──▶ offscreen document
 (activeTab click)   · mints short-lived secret                     · getUserMedia(tab stream)
                     · relays captions to the tab                   · RTCPeerConnection → OpenAI
                                                                    · plays translated audio
                                                                    · re-plays original, ducked
```

- **Capture:** `chrome.tabCapture` (the extension equivalent of the guide's `getDisplayMedia`), consumed in an offscreen document.
- **Session:** the service worker `POST`s `/v1/realtime/translations/client_secrets` with `model: gpt-realtime-translate`,
  `output.language: "en"`, `gpt-realtime-whisper` input transcription. The **API key stays in the service worker**;
  only the short-lived secret reaches the WebRTC code. The offscreen doc then `POST`s its SDP offer to
  `/v1/realtime/translations/calls` and uses the `oai-events` data channel.
- **Captions:** `session.output_transcript.delta` (English) and optionally `session.input_transcript.delta` (Dutch)
  are shown in a shadow-DOM overlay injected into the tab (also works in fullscreen).
- **Original audio:** Chrome mutes a captured tab, so the original is played back at an adjustable low volume (default 15%).

## Notes and limitations

- The API key is stored in `chrome.storage.local` (this browser profile only, not synced). Fine for personal use; for
  anything shared, put a small backend in front that mints client secrets instead.
- Dutch is **auto-detected**; the API has no input-language setting. Speech already in English may be left untranslated
  (per the guide) — that is why the original audio stays audible rather than fully muted.
- The model has no voice, prompt or glossary options; names and domain terms can be mistranslated.
- If the page does a full navigation while translating, audio continues but the caption overlay is lost
  (the `activeTab` grant ends). Stop and restart to get captions back.
- Usage is billed to your OpenAI account per minute of audio. Stop the session when you're not using it.
- Chrome can't capture `chrome://` pages or the Web Store.

## Development

```bash
node --test test/captions.test.js   # caption buffer unit tests
python3 tools/make-icons.py         # regenerate icons
```
