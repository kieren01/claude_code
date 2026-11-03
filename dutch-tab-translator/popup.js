const $ = (id) => document.getElementById(id);
const DEFAULTS = { originalVolume: 0.15, translatedVolume: 1, showCaptions: true, showSource: false };

function renderState(state = { phase: 'idle' }) {
  const { phase, message, tabTitle } = state;
  const pill = $('pill');
  pill.className = `pill ${phase}`;
  pill.textContent = { idle: 'Idle', connecting: 'Connecting', live: 'Live', error: 'Error' }[phase] ?? phase;
  const msg = $('message');
  msg.className = `message${phase === 'error' ? ' error' : ''}`;
  msg.textContent = phase === 'idle' && !message ? 'Translate the audio of the current tab live.'
    : phase === 'live' && tabTitle ? `${message} — ${tabTitle}` : message;
  const active = phase === 'connecting' || phase === 'live';
  const btn = $('toggle');
  btn.textContent = active ? 'Stop translating' : 'Translate this tab';
  btn.classList.toggle('stop', active);
  btn.dataset.active = active ? '1' : '';
}

function renderKey(apiKey) {
  $('keySummary').textContent = apiKey ? `OpenAI API key (saved …${apiKey.slice(-4)})` : 'OpenAI API key (required)';
  $('keyBox').open = !apiKey;
}

async function init() {
  const s = { ...DEFAULTS, ...(await chrome.storage.local.get(null)) };
  $('originalVolume').value = Math.round(s.originalVolume * 100);
  $('translatedVolume').value = Math.round(s.translatedVolume * 100);
  $('origOut').textContent = `${$('originalVolume').value}%`;
  $('transOut').textContent = `${$('translatedVolume').value}%`;
  $('showCaptions').checked = s.showCaptions;
  $('showSource').checked = s.showSource;
  renderKey(s.apiKey);
  renderState((await chrome.storage.session.get('state')).state);
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.state) renderState(changes.state.newValue);
});

for (const [id, key, out] of [['originalVolume', 'originalVolume', 'origOut'], ['translatedVolume', 'translatedVolume', 'transOut']]) {
  $(id).addEventListener('input', (e) => {
    $(out).textContent = `${e.target.value}%`;
    chrome.storage.local.set({ [key]: Number(e.target.value) / 100 });
  });
}
for (const id of ['showCaptions', 'showSource']) {
  $(id).addEventListener('change', (e) => chrome.storage.local.set({ [id]: e.target.checked }));
}

$('saveKey').addEventListener('click', async () => {
  const apiKey = $('apiKey').value.trim();
  if (!apiKey) return;
  await chrome.storage.local.set({ apiKey });
  $('apiKey').value = '';
  renderKey(apiKey);
});

$('toggle').addEventListener('click', async () => {
  if ($('toggle').dataset.active) {
    chrome.runtime.sendMessage({ target: 'background', type: 'stop' });
    return;
  }
  const fail = (m) => renderState({ phase: 'error', message: m });
  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (!apiKey) { $('keyBox').open = true; return fail('Add your OpenAI API key first.'); }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return fail('No active tab found.');
  try {
    // Must be requested from the popup: the click grants activeTab for this tab.
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    chrome.runtime.sendMessage({ target: 'background', type: 'start', tabId: tab.id, tabTitle: tab.title, streamId });
  } catch (e) {
    fail(`Can't capture this tab: ${e.message}`);
  }
});

init();
