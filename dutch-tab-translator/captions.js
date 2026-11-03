// Pure caption-buffer helpers (no DOM / chrome.* use) so they can be unit-tested in Node.
(function (root) {
  const MAX_CHARS = 220;

  // Keep only the tail of `text`, cutting at a word boundary.
  function trimToTail(text, max = MAX_CHARS) {
    if (text.length <= max) return text;
    const cut = text.length - max;
    const space = text.indexOf(' ', cut);
    return '… ' + (space === -1 ? text.slice(cut) : text.slice(space + 1));
  }

  // Rolling caption line: append deltas, expire after `idleMs` without new text.
  function createCaptionLine({ max = MAX_CHARS, idleMs = 6000, now = () => Date.now() } = {}) {
    let text = '';
    let last = 0;
    return {
      append(delta) {
        if (now() - last > idleMs) text = ''; // new utterance after a pause
        last = now();
        text = trimToTail((text + delta).replace(/\s+/g, ' ').replace(/^\s+/, ''), max);
        return text;
      },
      expired() { return text !== '' && now() - last > idleMs; },
      clear() { text = ''; },
      get text() { return text; },
    };
  }

  const api = { trimToTail, createCaptionLine, MAX_CHARS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NlEnCaptions = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
