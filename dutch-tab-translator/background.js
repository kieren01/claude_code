// Service worker: owns session state, mints the short-lived OpenAI client secret
// (so the API key never leaves this context), manages the offscreen document that
// does the audio/WebRTC work, and relays captions to the captured tab.

const SECRETS_URL = 'https://api.openai.com/v1/realtime/translations/client_secrets';
const MODEL = 'gpt-realtime-translate';
const TRANSCRIPTION_MODEL = 'gpt-realtime-whisper';
const TARGET_LANGUAGE = 'en'; // source language (Dutch) is auto-detected by the model

const DEFAULT_SETTINGS = {
  originalVolume: 0.15,
  translatedVolume: 1,
  showCaptions: true,
  showSource: false,
};

const IDLE = { phase: 'idle', tabId: null, tabTitle: null, message: '' };

async function getState() {
  const { state } = await chrome.storage.session.get('state');
  return state ?? IDLE;
}
async function setState(patch) {
  const next = { ...(await getState()), ...patch };
  await chrome.storage.session.set({ state: next });
  return next;
}
async function resetState(message = '', phase = 'idle') {
  await chrome.storage.session.set({ state: { ...IDLE, phase, message } });
}
async function getSettings() {
  const stored = await chrome.storage.local.get(null);
  return { ...DEFAULT_SETTINGS, ...stored };
}

async function createClientSecret(apiKey) {
  const res = await fetch(SECRETS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      session: {
        model: MODEL,
        audio: {
          input: {
            transcription: { model: TRANSCRIPTION_MODEL },
            noise_reduction: { type: 'near_field' },
          },
          output: { language: TARGET_LANGUAGE },
        },
      },
    }),
  });
  const text = await res.text();
  let body = {};
  try { body = JSON.parse(text); } catch { /* non-JSON error body */ }
  if (!res.ok) {
    const detail = body?.error?.message || text.slice(0, 200) || res.statusText;
    throw new Error(
      res.status === 401 ? 'OpenAI rejected the API key (401). Check it in the popup.'
        : `OpenAI error ${res.status}: ${detail}`);
  }
  if (typeof body.value !== 'string') throw new Error('Unexpected client-secret response from OpenAI.');
  return body.value;
}

async function hasOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return ctx.length > 0;
}
async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA', 'WEB_RTC', 'AUDIO_PLAYBACK'],
    justification: 'Capture tab audio, stream it to OpenAI for translation, and play the translated audio.',
  });
}
async function closeOffscreen() {
  if (await hasOffscreen()) await chrome.offscreen.closeDocument();
}

// The offscreen document may not have registered its listener yet; retry briefly.
async function sendToOffscreen(message) {
  let lastErr;
  for (let i = 0; i < 10; i++) {
    try {
      return await chrome.runtime.sendMessage({ target: 'offscreen', ...message });
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw lastErr;
}

async function injectOverlay(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['captions.js', 'content.js'] });
  } catch (e) {
    console.warn('Could not inject caption overlay:', e.message); // audio still works
  }
}

async function stop(message = '', phase = 'idle') {
  const { tabId } = await getState();
  try { await sendToOffscreen({ type: 'stop' }); } catch { /* already gone */ }
  try { await closeOffscreen(); } catch { /* ignore */ }
  if (tabId != null) {
    try { await chrome.tabs.sendMessage(tabId, { target: 'content', type: 'teardown' }); } catch { /* tab gone */ }
  }
  await resetState(message, phase);
}

async function start({ tabId, tabTitle, streamId }) {
  if ((await getState()).phase !== 'idle') await stop();
  await resetState('', 'idle');
  await setState({ phase: 'connecting', tabId, tabTitle, message: 'Connecting to OpenAI…' });
  try {
    const { apiKey, ...rest } = await getSettings();
    if (!apiKey) throw new Error('Add your OpenAI API key in the popup first.');
    // Run in parallel: the tab-capture stream ID expires after a few seconds.
    const [secret] = await Promise.all([createClientSecret(apiKey), ensureOffscreen()]);
    await injectOverlay(tabId);
    const res = await sendToOffscreen({ type: 'start', streamId, secret, settings: rest });
    if (!res?.ok) throw new Error(res?.error || 'Could not start audio capture.');
  } catch (e) {
    await stop(e.message, 'error');
  }
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.target !== 'background') return;
  switch (msg.type) {
    case 'start':
      start(msg);
      break;
    case 'stop':
      stop();
      break;
    case 'offscreen-status':
      handleOffscreenStatus(msg);
      break;
    case 'caption':
      getState().then(({ tabId }) => {
        if (tabId != null) {
          chrome.tabs.sendMessage(tabId, { target: 'content', type: 'caption', kind: msg.kind, delta: msg.delta })
            .catch(() => {});
        }
      });
      break;
  }
});

async function handleOffscreenStatus({ phase, message }) {
  const { phase: current } = await getState();
  if (current === 'idle') return; // late message after stop
  if (phase === 'live') await setState({ phase: 'live', message: message || 'Translating…' });
  else if (phase === 'connecting') await setState({ phase: 'connecting', message });
  else if (phase === 'warn') await setState({ message });
  else if (phase === 'error') await stop(message, 'error');
  else if (phase === 'ended') await stop(message, 'idle');
}

// Push live setting changes (volumes) to the running session.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local') return;
  const { phase } = await getState();
  if (phase === 'idle' || phase === 'error') return;
  const { apiKey, ...settings } = await getSettings();
  sendToOffscreen({ type: 'settings', settings }).catch(() => {});
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if ((await getState()).tabId === tabId) stop('Tab closed');
});
