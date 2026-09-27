// core/text.js
// 文本切分与基础统计工具。纯 Node，零依赖。

// 章节标题：第N章 / 第N回 / 第N节 + 标题
const CHAPTER_RE = /^\s*第\s*[0-9零一二三四五六七八九十百千万两〇]+\s*[章回节卷篇]\s*(.*)$/;

export function splitChapters(text) {
  const lines = text.split('\n');
  const chapters = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(CHAPTER_RE);
    if (m) {
      if (cur) chapters.push(cur);
      cur = { title: line.trim(), body: [] };
    } else if (cur) {
      cur.body.push(line);
    }
  }
  if (cur) chapters.push(cur);
  for (const c of chapters) {
    c.body = c.body.join('\n').trim();
  }
  return chapters;
}

// 段落切分：空行分段；无空行时按行
export function splitParagraphs(text) {
  const blocks = text.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
  if (blocks.length > 5) return blocks;
  return text.split('\n').map(s => s.trim()).filter(Boolean);
}

// 句子切分：中文标点 + 英文句号
export function splitSentences(text) {
  const parts = text
    .split(/(?<=[。！？!?…])\s*|(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
  return parts;
}

export function countCJK(s) {
  let n = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c >= 0x4e00 && c <= 0x9fff) n++;
  }
  return n;
}

// 字符是否中文/中文标点
export function isCJKPunct(ch) {
  return '，。！？；：、（）《》「」『』…—""\u2014\u2018\u2019\u201c\u201d'.includes(ch);
}

export function freq(list) {
  const m = new Map();
  for (const x of list) m.set(x, (m.get(x) || 0) + 1);
  return m;
}

export function sortedFreq(map, min = 1) {
  return [...map.entries()]
    .filter(([, v]) => v >= min)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
}

export function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

export function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length);
}

export function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor(p * s.length));
  return s[idx];
}
