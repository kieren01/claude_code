'use strict';
// Pure helpers: figure out what a user pasted, and pull video/poster/copy out of
// the HTML that Facebook serves for an ad. No network access in here, so it is
// easy to test.

const VIDEO_EXT = /\.(mp4|webm|mov|m4v)(\?|#|$)/i;
const ALLOWED_MEDIA_HOSTS = /(^|\.)(fbcdn\.net|facebook\.com|fbsbx\.com|cdninstagram\.com)$/i;

function parseInput(raw) {
  const input = String(raw || '').trim();
  if (!input) return { kind: 'empty' };
  if (/^\d{6,}$/.test(input)) return { kind: 'ad', adId: input };

  let url;
  try { url = new URL(input); } catch { return { kind: 'invalid' }; }
  if (!/^https?:$/.test(url.protocol)) return { kind: 'invalid' };

  const host = url.hostname.replace(/^www\./, '');
  if (/(^|\.)facebook\.com$/i.test(host) && url.pathname.startsWith('/ads/library')) {
    const id = url.searchParams.get('id');
    if (id && /^\d+$/.test(id)) return { kind: 'ad', adId: id, url: url.href };
    return { kind: 'library-search', url: url.href };
  }
  if (VIDEO_EXT.test(url.pathname + url.search) || ALLOWED_MEDIA_HOSTS.test(url.hostname)) {
    return { kind: 'video', url: url.href };
  }
  return { kind: 'page', url: url.href };
}

function decodeJsonString(s) {
  try { return JSON.parse('"' + s + '"'); } catch {
    return s.replace(/\\\//g, '/').replace(/\\u0025/g, '%').replace(/\\u0026/g, '&').replace(/&amp;/g, '&');
  }
}

function jsonStringValue(html, key) {
  const re = new RegExp('"' + key + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"');
  const m = re.exec(html);
  return m ? decodeJsonString(m[1]) : null;
}

function metaContent(html, prop) {
  const re = new RegExp('<meta[^>]+(?:property|name)=["\']' + prop + '["\'][^>]*content=["\']([^"\']*)["\']', 'i');
  const m = re.exec(html);
  return m ? m[1].replace(/&amp;/g, '&') : null;
}

function stripTags(s) {
  return s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#039;|&#x27;/g, "'").replace(/&quot;/g, '"').trim();
}

function extractFromHtml(html) {
  const hd = jsonStringValue(html, 'video_hd_url');
  const sd = jsonStringValue(html, 'video_sd_url');
  let videoUrl = hd || sd || null;
  if (!videoUrl) {
    const tag = /<video[^>]+src=["']([^"']+)["']/i.exec(html);
    if (tag) videoUrl = tag[1].replace(/&amp;/g, '&');
  }
  if (!videoUrl) videoUrl = metaContent(html, 'og:video:secure_url') || metaContent(html, 'og:video');

  const posterUrl =
    jsonStringValue(html, 'video_preview_image_url') ||
    jsonStringValue(html, 'original_image_url') ||
    jsonStringValue(html, 'resized_image_url') ||
    metaContent(html, 'og:image');

  const pageName = jsonStringValue(html, 'page_name') || null;

  let text = null;
  const plain = /"body"\s*:\s*\{\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(html);
  if (plain) text = decodeJsonString(plain[1]);
  if (!text) {
    const markup = /"body"\s*:\s*\{\s*"markup"\s*:\s*\{\s*"__html"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(html);
    if (markup) text = stripTags(decodeJsonString(markup[1]));
  }
  if (!text) text = metaContent(html, 'og:description');

  return { videoUrl, videoSdUrl: sd && sd !== videoUrl ? sd : null, posterUrl, pageName, text };
}

function isAllowedMediaUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' && ALLOWED_MEDIA_HOSTS.test(url.hostname);
  } catch { return false; }
}

module.exports = { parseInput, extractFromHtml, isAllowedMediaUrl, VIDEO_EXT };
