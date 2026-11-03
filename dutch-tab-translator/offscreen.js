// Offscreen document: captures the tab's audio, streams it to gpt-realtime-translate
// over WebRTC, plays the translated audio, and relays transcript deltas.
// Follows the OpenAI cookbook "Build Live Translation Apps" browser-tab pattern.

const CALLS_URL = 'https://api.openai.com/v1/realtime/translations/calls';
const DISCONNECT_GRACE_MS = 8000;

let pc = null;
let dc = null;
let captureStream = null;
let audioCtx = null;
let originalGain = null;
let translatedEl = null;
let disconnectTimer = null;

const report = (phase, message) =>
  chrome.runtime.sendMessage({ target: 'background', type: 'offscreen-status', phase, message }).catch(() => {});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  if (msg.type === 'start') {
    start(msg).then(
      () => sendResponse({ ok: true }),
      (e) => { cleanup(); sendResponse({ ok: false, error: e.message }); });
    return true; // async response
  }
  if (msg.type === 'stop') { cleanup(); sendResponse({ ok: true }); }
  if (msg.type === 'settings') applySettings(msg.settings);
});

function applySettings(s = {}) {
  if (originalGain && typeof s.originalVolume === 'number') originalGain.gain.value = s.originalVolume;
  if (translatedEl && typeof s.translatedVolume === 'number') translatedEl.volume = s.translatedVolume;
}

async function start({ streamId, secret, settings }) {
  cleanup();

  // 1. Tab audio. Chrome mutes the tab once captured, so we play it back ourselves.
  captureStream = await navigator.mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaStreamId: streamId } },
    video: false,
  });
  const tracks = captureStream.getAudioTracks();
  if (!tracks.length) throw new Error('This tab has no capturable audio.');
  tracks[0].onended = () => { cleanup(); report('ended', 'Tab audio ended'); };

  // 2. Original audio, ducked so the translation stays intelligible. Keeping it audible
  //    also covers passages the model skips (e.g. speech already in English).
  audioCtx = new AudioContext();
  originalGain = audioCtx.createGain();
  audioCtx.createMediaStreamSource(captureStream).connect(originalGain).connect(audioCtx.destination);
  await audioCtx.resume();

  // 3. Translated audio element.
  translatedEl = new Audio();
  translatedEl.autoplay = true;

  applySettings(settings);

  // 4. WebRTC session.
  pc = new RTCPeerConnection();
  dc = pc.createDataChannel('oai-events');
  dc.onmessage = onRealtimeEvent;
  for (const t of tracks) pc.addTrack(t, captureStream);
  pc.ontrack = (e) => {
    translatedEl.srcObject = e.streams[0];
    translatedEl.play().catch((err) => report('warn', `Audio playback blocked: ${err.message}`));
  };
  pc.onconnectionstatechange = onConnectionState;

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  const res = await fetch(CALLS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/sdp' },
    body: offer.sdp,
  });
  const answer = await res.text();
  if (!res.ok) throw new Error(`OpenAI call setup failed (${res.status}): ${answer.slice(0, 200)}`);
  await pc.setRemoteDescription({ type: 'answer', sdp: answer });
}

function onConnectionState() {
  if (!pc) return;
  const state = pc.connectionState;
  clearTimeout(disconnectTimer);
  if (state === 'connected') report('live', 'Translating Dutch → English');
  else if (state === 'disconnected') {
    report('connecting', 'Connection interrupted, retrying…');
    disconnectTimer = setTimeout(() => { cleanup(); report('error', 'Lost connection to OpenAI.'); }, DISCONNECT_GRACE_MS);
  } else if (state === 'failed') { cleanup(); report('error', 'Connection to OpenAI failed.'); }
}

function onRealtimeEvent(message) {
  let event;
  try { event = JSON.parse(message.data); } catch { return; }
  switch (event.type) {
    case 'session.output_transcript.delta':
      if (typeof event.delta === 'string') relay('output', event.delta);
      break;
    case 'session.input_transcript.delta':
      if (typeof event.delta === 'string') relay('input', event.delta);
      break;
    case 'error':
      report('warn', `OpenAI: ${event.error?.message ?? JSON.stringify(event.error ?? event)}`);
      break;
  }
}

function relay(kind, delta) {
  chrome.runtime.sendMessage({ target: 'background', type: 'caption', kind, delta }).catch(() => {});
}

function cleanup() {
  clearTimeout(disconnectTimer);
  if (dc) { dc.onmessage = null; try { dc.close(); } catch {} }
  if (pc) {
    pc.onconnectionstatechange = null;
    pc.ontrack = null;
    try { pc.close(); } catch {}
  }
  if (captureStream) captureStream.getTracks().forEach((t) => { t.onended = null; t.stop(); });
  if (audioCtx && audioCtx.state !== 'closed') audioCtx.close().catch(() => {});
  if (translatedEl) { translatedEl.pause(); translatedEl.srcObject = null; }
  pc = dc = captureStream = audioCtx = originalGain = translatedEl = null;
}
