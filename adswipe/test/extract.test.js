'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseInput, extractFromHtml, isAllowedMediaUrl } = require('../lib/extract');

test('parseInput recognises ad library links, ids and video urls', () => {
  assert.deepStrictEqual(parseInput('1234567890123').adId, '1234567890123');
  const link = parseInput('https://www.facebook.com/ads/library/?active_status=all&id=998877665544');
  assert.strictEqual(link.kind, 'ad');
  assert.strictEqual(link.adId, '998877665544');
  assert.strictEqual(parseInput('https://www.facebook.com/ads/library/?q=shoes').kind, 'library-search');
  assert.strictEqual(parseInput('https://video.xx.fbcdn.net/v/t42/abc.mp4?x=1').kind, 'video');
  assert.strictEqual(parseInput('https://example.com/clip.mp4').kind, 'video');
  assert.strictEqual(parseInput('not a url').kind, 'invalid');
  assert.strictEqual(parseInput('   ').kind, 'empty');
});

test('extractFromHtml prefers HD and decodes escaped urls', () => {
  const html = `<script>{"snapshot":{"page_name":"Acme Co","body":{"text":"Line one\\nLine two \\u2014 now"},
    "videos":[{"video_hd_url":"https:\\/\\/video.xx.fbcdn.net\\/v\\/hd.mp4?a=1\\u0026b=2","video_sd_url":"https:\\/\\/video.xx.fbcdn.net\\/v\\/sd.mp4",
    "video_preview_image_url":"https:\\/\\/scontent.xx.fbcdn.net\\/p.jpg"}]}}</script>`;
  const r = extractFromHtml(html);
  assert.strictEqual(r.videoUrl, 'https://video.xx.fbcdn.net/v/hd.mp4?a=1&b=2');
  assert.strictEqual(r.videoSdUrl, 'https://video.xx.fbcdn.net/v/sd.mp4');
  assert.strictEqual(r.posterUrl, 'https://scontent.xx.fbcdn.net/p.jpg');
  assert.strictEqual(r.pageName, 'Acme Co');
  assert.strictEqual(r.text, 'Line one\nLine two — now');
});

test('extractFromHtml falls back to sd, <video>, and null', () => {
  assert.strictEqual(extractFromHtml('{"video_hd_url":null,"video_sd_url":"https:\\/\\/v.fbcdn.net\\/s.mp4"}').videoUrl, 'https://v.fbcdn.net/s.mp4');
  assert.strictEqual(extractFromHtml('<video controls src="https://v.fbcdn.net/t.mp4?a=1&amp;b=2"></video>').videoUrl, 'https://v.fbcdn.net/t.mp4?a=1&b=2');
  assert.strictEqual(extractFromHtml('<html>nothing here</html>').videoUrl, null);
});

test('isAllowedMediaUrl only admits Facebook hosts over https', () => {
  assert.ok(isAllowedMediaUrl('https://video.xx.fbcdn.net/a.mp4'));
  assert.ok(!isAllowedMediaUrl('http://video.xx.fbcdn.net/a.mp4'));
  assert.ok(!isAllowedMediaUrl('https://evilfbcdn.net/a.mp4'));
  assert.ok(!isAllowedMediaUrl('https://127.0.0.1/a.mp4'));
  assert.ok(!isAllowedMediaUrl('file:///etc/passwd'));
});
