const test = require('node:test');
const assert = require('node:assert');
const { trimToTail, createCaptionLine } = require('../captions.js');

test('trimToTail keeps short text unchanged', () => {
  assert.strictEqual(trimToTail('hello world', 50), 'hello world');
});

test('trimToTail cuts at a word boundary and marks the cut', () => {
  const out = trimToTail('one two three four five six', 15);
  assert.ok(out.startsWith('… '));
  assert.ok(out.endsWith('six'));
  assert.strictEqual(out, '… four five six'); // no half-cut words
});

test('appends deltas into one line', () => {
  let t = 0;
  const line = createCaptionLine({ now: () => t });
  line.append('Hello');
  t += 100;
  assert.strictEqual(line.append(' there'), 'Hello there');
});

test('starts a fresh utterance after an idle gap', () => {
  let t = 0;
  const line = createCaptionLine({ idleMs: 1000, now: () => t });
  line.append('first sentence.');
  t += 1500;
  assert.ok(line.expired());
  assert.strictEqual(line.append('Second'), 'Second');
});

test('stays bounded when deltas stream continuously', () => {
  let t = 0;
  const line = createCaptionLine({ max: 40, now: () => t });
  for (let i = 0; i < 100; i++) { t += 50; line.append(`word${i} `); }
  assert.ok(line.text.length <= 45);
  assert.ok(line.text.includes('word99'));
});
