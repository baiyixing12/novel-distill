// core/decode.js
// 编码探测 + 转码。纯 Node 内置模块，零依赖。
// 覆盖 UTF-8 / GB18030(含GBK) / BIG5 / UTF-16LE / UTF-16BE。
//
// 关键：不要用 TextDecoder 的 { fatal: true } 做探测。
// fatal 要求整段全部合法，而爬取来的小说常有个别坏字节，
// 会把明明正确的编码（如 gb18030）整体判失败。
// 正确做法：fatal:false 解码，再用替换符比例 + CJK 占比评分。

import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const CANDIDATES = ['utf-8', 'gb18030', 'big5', 'utf-16le', 'utf-16be'];

export function detectEncoding(buf) {
  const sample = buf.subarray(0, Math.min(buf.length, 512 * 1024));
  let best = { enc: 'utf-8', score: -Infinity };
  const results = {};
  for (const enc of CANDIDATES) {
    let text;
    try {
      text = new TextDecoder(enc).decode(sample);
    } catch (e) {
      results[enc] = { ok: false, reason: e.message };
      continue;
    }
    const m = measure(text);
    const score = scoreOf(m, enc);
    results[enc] = { ok: true, ...m, score };
    if (score > best.score) best = { enc, score };
  }
  return { encoding: best.enc, score: best.score, results };
}

export function measure(text) {
  const n = text.length || 1;
  let cjk = 0, ascii = 0, printable = 0, replacement = 0, ctrl = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const bad = (c === 0xfffd) || (c < 0x20 && c !== 10 && c !== 13 && c !== 9);
    if (c === 0xfffd) replacement++;
    else if (c < 0x20 && c !== 10 && c !== 13 && c !== 9) ctrl++;
    if (c >= 0x4e00 && c <= 0x9fff) cjk++;
    else if (c < 0x80) ascii++;
    if (!bad) printable++;
  }
  return {
    n: text.length, cjk, ascii, printable, replacement, ctrl,
    cjkRatio: cjk / n, replacementRatio: replacement / n, ctrlRatio: ctrl / n,
  };
}

export function scoreOf(m, enc) {
  let score = 0;
  score += m.cjkRatio * 100;
  score += (m.printable / (m.n || 1)) * 20;
  score -= m.replacementRatio * 1000;
  score -= m.ctrlRatio * 800;
  if (enc === 'utf-8') {
    const asciiRatio = m.ascii / (m.n || 1);
    if (m.cjkRatio < 0.02 && asciiRatio > 0.8) score += 5;
  } else if (enc === 'utf-16le' || enc === 'utf-16be') {
    if (m.cjkRatio < 0.05) score -= 100;
  }
  return score;
}

export function readText(filePath, opts = {}) {
  const buf = fs.readFileSync(filePath);
  const detected = detectEncoding(buf);
  const enc = opts.encoding || detected.encoding;
  const text = normalize(new TextDecoder(enc).decode(buf));
  return { text, encoding: enc, bytes: buf.length, detected };
}

export function normalize(text) {
  let s = text;
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  s = s.replace(/\r\n?/g, '\n');
  s = s.replace(/&nbsp;/gi, ' ');
  s = s.replace(/&#(\d+);/g, (_, d) => safeCp(Number(d)));
  s = s.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeCp(parseInt(h, 16)));
  s = s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  s = s.replace(/"/g, '"').replace(/'/g, "'");
  s = s.replace(/\u3000/g, ' ');
  return s;
}

function safeCp(code) {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try { return String.fromCodePoint(code); } catch { return ''; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const p = process.argv[2];
  if (!p) { console.error('用法: node core/decode.js <文件>'); process.exit(1); }
  const buf = fs.readFileSync(p);
  const d = detectEncoding(buf);
  console.log('文件:', p);
  console.log('字节:', buf.length);
  console.log('探测编码:', d.encoding, '(score=' + d.score.toFixed(2) + ')');
  for (const [k, v] of Object.entries(d.results)) {
    if (!v.ok) { console.log('  ', k, 'fail:', v.reason); continue; }
    console.log('  ', k.padEnd(9),
      'cjk=' + (v.cjkRatio * 100).toFixed(1) + '%',
      'repl=' + (v.replacementRatio * 100).toFixed(3) + '%',
      'ctrl=' + (v.ctrlRatio * 100).toFixed(3) + '%',
      'score=' + v.score.toFixed(2));
  }
  const { text } = readText(p);
  console.log('---前 200 字---');
  console.log(text.slice(0, 200));
}