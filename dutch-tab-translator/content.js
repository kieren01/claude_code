// Injected into the captured tab: shows rolling English (and optional Dutch) captions.
(() => {
  if (globalThis.__nlEnTranslator) return; // already injected
  const { createCaptionLine } = globalThis.NlEnCaptions;

  const output = createCaptionLine();
  const input = createCaptionLine();
  let showCaptions = true;
  let showSource = false;

  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;left:0;right:0;bottom:6%;z-index:2147483647;pointer-events:none;display:flex;justify-content:center;';
  const root = host.attachShadow({ mode: 'closed' });
  root.innerHTML = `
    <style>
      .box{max-width:min(80vw,900px);padding:10px 16px;border-radius:10px;background:rgba(0,0,0,.72);
        color:#fff;font:600 22px/1.35 system-ui,-apple-system,Segoe UI,sans-serif;text-align:center;
        text-shadow:0 1px 2px #000;display:none}
      .src{font-weight:400;font-size:15px;color:#cbd5e1;margin-top:4px}
      .src:empty{display:none}
    </style>
    <div class="box"><div class="en"></div><div class="src"></div></div>`;
  const box = root.querySelector('.box');
  const enEl = root.querySelector('.en');
  const srcEl = root.querySelector('.src');

  function mount() {
    const parent = document.fullscreenElement || document.documentElement;
    if (host.parentNode !== parent) parent.appendChild(host);
  }

  function render() {
    enEl.textContent = showCaptions ? output.text : '';
    srcEl.textContent = showSource ? input.text : '';
    box.style.display = (enEl.textContent || srcEl.textContent) ? 'block' : 'none';
  }

  const timer = setInterval(() => {
    let changed = false;
    if (output.expired()) { output.clear(); changed = true; }
    if (input.expired()) { input.clear(); changed = true; }
    if (changed) render();
  }, 1000);

  function onMessage(msg) {
    if (msg?.target !== 'content') return;
    if (msg.type === 'caption') {
      (msg.kind === 'input' ? input : output).append(msg.delta);
      render();
    } else if (msg.type === 'teardown') {
      teardown();
    }
  }

  function onStorage(changes, area) {
    if (area !== 'local') return;
    if (changes.showCaptions) showCaptions = changes.showCaptions.newValue !== false;
    if (changes.showSource) showSource = !!changes.showSource.newValue;
    render();
  }

  function teardown() {
    clearInterval(timer);
    chrome.runtime.onMessage.removeListener(onMessage);
    chrome.storage.onChanged.removeListener(onStorage);
    document.removeEventListener('fullscreenchange', mount);
    host.remove();
    delete globalThis.__nlEnTranslator;
  }

  globalThis.__nlEnTranslator = { teardown };
  chrome.runtime.onMessage.addListener(onMessage);
  chrome.storage.onChanged.addListener(onStorage);
  document.addEventListener('fullscreenchange', mount);
  chrome.storage.local.get({ showCaptions: true, showSource: false }).then((s) => {
    showCaptions = s.showCaptions;
    showSource = s.showSource;
    render();
  });
  mount();
})();
