'use strict';
const fs = require('fs');
const path = 'C:\\backup\\New folder\\nexamanga.xml';
const lines = fs.readFileSync(path, 'utf8').split('\n');
const doomed = [
  /^\s*\.kv-reader-top, \.kv-reader-tools\s*\{/,
  /^\s*\.kv-reader-title\s*\{/,
  /^\s*\.kv-reader-subtitle\s*\{/,
  /^\s*\.kv-reader-chapter-nav\s*\{/,
  /^\s*\.kv-reader-chapter-link\s*\{/,
  /^\s*\.kv-reader-tools\s*\{/,
  /^\s*\.kv-reader-tools \.kv-btn, \.kv-reader-tools \.kv-select\s*\{/,
  /^\s*\.kv-reader-tools \.kv-btn-ghost, \.kv-reader-tools \.kv-select\s*\{/
];
const doomedLines = [
  /^\s*margin-right: auto;$/,
  /^\s*color: var\(--kv-reader-muted\);$/,
  /^\s*font-size: 0\.75rem;$/,
  /^\s*font-weight: 600;$/,
  /^\s*\.kv-reader-title\s*\{ max-width: (36vw|32vw)/,
  /^\s*\.kv-reader-subtitle\s*\{ font-size:/,
  /^\s*\.kv-reader-chapter-link\s*\{/,
  /^\s*\.kv-reader-top, \.kv-reader-tools\s*\{ padding-right/,
  /^\s*\.kv-reader-chapter-nav\s*\{ gap:/,
  /^\s*\.kv-reader-tools \.kv-btn, \.kv-reader-tools \.kv-select\s*\{ font-size/
];
const out = [];
let i = 0, removed = 0;
while (i < lines.length) {
  const line = lines[i];
  let matched = false;
  for (const re of doomed) {
    if (re.test(line)) {
      matched = true;
      let depth = 0, started = false;
      do {
        const current = lines[i] || '';
        for (const ch of current) {
          if (ch === '{') { depth += 1; started = true; }
          else if (ch === '}') depth -= 1;
        }
        i += 1;
      } while (i < lines.length && (!started || depth > 0));
      removed += 1;
      break;
    }
  }
  if (matched) continue;
  let dropped = false;
  for (const re of doomedLines) {
    if (re.test(line)) { dropped = true; removed += 1; i += 1; break; }
  }
  if (dropped) continue;
  out.push(line);
  i += 1;
}
fs.writeFileSync(path, out.join('\n'));
console.log('removed:', removed);
