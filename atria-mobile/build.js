// Builds dist/bookmarklet.txt from atria-mobile.user.js (strips the userscript header).
// Usage: node build.js
const fs = require('fs');
const path = require('path');
let src = fs.readFileSync(path.join(__dirname, 'atria-mobile.user.js'), 'utf8');
src = src.replace(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*/, '');
let body = src;
try {
  // optional: shrink with terser if it is installed (npx terser)
  const { execFileSync } = require('child_process');
  body = execFileSync('npx', ['--yes', 'terser@5.31.0', '--compress', '--mangle'], { input: src, encoding: 'utf8', maxBuffer: 1 << 26 });
} catch (e) {
  console.warn('terser unavailable, using unminified script:', e.message.split('\n')[0]);
  body = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
const bm = 'javascript:' + encodeURIComponent(body.trim());
fs.writeFileSync(path.join(__dirname, 'dist', 'bookmarklet.txt'), bm);
fs.writeFileSync(path.join(__dirname, 'dist', 'atria-mobile.min.js'), body.trim());
console.log('bookmarklet chars:', bm.length, ' min.js bytes:', body.length);
