// core/style.js
// 文风指纹蒸馏。纯规则、零依赖、不调模型。
// 从正文抽取可量化的文风特征，用于「喂给写作模型」或「续写时约束文风」。

import {
  splitChapters, splitParagraphs, splitSentences,
  countCJK, freq, sortedFreq, mean, stddev, median, percentile,
} from './text.js';

// 中文高频虚词/功能词表（用于捕捉作者口吻）
const FUNCTION_WORDS = [
  '的', '了', '是', '在', '我', '你', '他', '她', '它', '们',
  '这', '那', '也', '就', '都', '又', '很', '还', '但', '而',
  '只', '才', '却', '已', '将', '把', '被', '让', '给', '向',
  '着', '过', '吗', '呢', '吧', '啊', '呀', '哦', '嗯', '呢',
  '仿佛', '似乎', '好像', '然后', '于是', '因为', '所以', '如果', '只是',
];

// 标点
const PUNCT = ['，', '。', '！', '？', '；', '：', '、', '…', '—', '“', '"', '《', '（'];

// 空泛/夸张形容词与套话（用于 AI 味检测，也用于文风画像）
const CLICHES = [
  '不禁', '不由', '微微', '缓缓', '淡淡', '轻轻', '静静', '默默', '悄悄',
  '顿时', '瞬间', '刹那', '倏然', '恍然', '竟然', '居然', '终究', '终于',
  '一股', '一丝', '一抹', '一缕', '些许', '几分', '无比', '万分', '格外',
  '深深', '深深', '狠狠', '紧紧', '冷冷', '深深', '幽幽', '沉沉',
  '嘴角', '眼神', '目光', '心中', '心底', '心头', '内心',
];

function topList(map, n, min = 2) {
  return sortedFreq(map, min).slice(0, n).map(([w, c]) => ({ w, c }));
}

export function styleFingerprint(text, opts = {}) {
  const maxChars = opts.maxChars || 0;
  let src = text;
  if (maxChars > 0 && text.length > maxChars) src = text.slice(0, maxChars);

  const chapters = splitChapters(src);
  const paragraphs = splitParagraphs(src);
  const sentences = splitSentences(src);

  const paraLens = paragraphs.map(p => countCJK(p)).filter(n => n > 0);
  const sentLens = sentences
    .map(s => countCJK(s))
    .filter(n => n > 0 && n < 200); // 去掉异常长句（可能切分残留）

  // 标点频率
  const punctMap = new Map(PUNCT.map(p => [p, 0]));
  for (const s of sentences) {
    for (const ch of s) if (punctMap.has(ch)) punctMap.set(ch, punctMap.get(ch) + 1);
  }
  const totalChars = countCJK(src) || 1;
  const punctFreq = [...punctMap.entries()]
    .map(([p, c]) => ({ p, per1000: +(c / totalChars * 1000).toFixed(2) }))
    .sort((a, b) => b.per1000 - a.per1000);

  // 虚词频率
  const fwMap = new Map();
  for (const w of FUNCTION_WORDS) {
    const c = src.split(w).length - 1;
    if (c > 0) fwMap.set(w, c);
  }
  const funcWords = topList(fwMap, 30, 5)
    .map(({ w, c }) => ({ w, per10k: +(c / totalChars * 10000).toFixed(1) }));

  // 套话/形容词频率
  const clMap = new Map();
  for (const w of CLICHES) {
    const c = src.split(w).length - 1;
    if (c > 0) clMap.set(w, c);
  }
  const cliches = topList(clMap, 25, 3)
    .map(({ w, c }) => ({ w, per10k: +(c / totalChars * 10000).toFixed(1) }));

  // 对话占比：以「“」开头的段/句
  let dialogChars = 0;
  for (const s of sentences) {
    if (/^\s*[“"]/.test(s)) dialogChars += countCJK(s);
  }

  // 比喻/明喻标记
  const simileCount = (src.match(/仿佛|好像|似乎|犹如|宛如|如同|似的|一般/g) || []).length;

  return {
    source: {
      chapters: chapters.length,
      chars: countCJK(src),
      paragraphs: paragraphs.length,
      sentences: sentences.length,
    },
    rhythm: {
      avgParagraph: +mean(paraLens).toFixed(2),
      medianParagraph: +median(paraLens).toFixed(2),
      stdParagraph: +stddev(paraLens).toFixed(2),
      p90Paragraph: +percentile(paraLens, 0.9).toFixed(2),
      avgSentence: +mean(sentLens).toFixed(2),
      medianSentence: +median(sentLens).toFixed(2),
      stdSentence: +stddev(sentLens).toFixed(2),
      p90Sentence: +percentile(sentLens, 0.9).toFixed(2),
      shortSentenceRatio: +(sentLens.filter(n => n <= 8).length / (sentLens.length || 1)).toFixed(3),
      longSentenceRatio: +(sentLens.filter(n => n >= 40).length / (sentLens.length || 1)).toFixed(3),
    },
    punctuation: punctFreq,
    functionWords: funcWords,
    cliches,
    style: {
      dialogRatio: +(dialogChars / totalChars).toFixed(3),
      similePer10k: +(simileCount / totalChars * 10000).toFixed(1),
    },
  };
}

// 生成可读的中文报告
export function renderStyle(fp) {
  const L = [];
  L.push('══════ 文风指纹 ══════');
  L.push(`样本：${fp.source.chapters} 章 / ${fp.source.chars} 字 / ${fp.source.paragraphs} 段 / ${fp.source.sentences} 句`);
  L.push('');
  L.push('【节奏】');
  L.push(`  段落：平均 ${fp.rhythm.avgParagraph} 字，中位 ${fp.rhythm.medianParagraph}，标准差 ${fp.rhythm.stdParagraph}，P90 ${fp.rhythm.p90Paragraph}`);
  L.push(`  句子：平均 ${fp.rhythm.avgSentence} 字，中位 ${fp.rhythm.medianSentence}，标准差 ${fp.rhythm.stdSentence}，P90 ${fp.rhythm.p90Sentence}`);
  L.push(`  短句(≤8字)占比 ${(fp.rhythm.shortSentenceRatio * 100).toFixed(1)}% ；长句(≥40字)占比 ${(fp.rhythm.longSentenceRatio * 100).toFixed(1)}%`);
  L.push('');
  L.push('【标点（每千字）】');
  L.push('  ' + fp.punctuation.map(x => `${x.p}${x.per1000}`).join('  '));
  L.push('');
  L.push('【高频虚词（每万字）】');
  L.push('  ' + fp.functionWords.slice(0, 15).map(x => `${x.w}${x.per10k}`).join('  '));
  L.push('');
  L.push('【套话/常用修饰（每万字）】');
  L.push('  ' + fp.cliches.slice(0, 15).map(x => `${x.w}${x.per10k}`).join('  '));
  L.push('');
  L.push('【风格倾向】');
  L.push(`  对话占比 ${(fp.style.dialogRatio * 100).toFixed(1)}% ；比喻标记密度 ${fp.style.similePer10k}/万字`);
  L.push('══════════════════════');
  return L.join('\n');
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const fs = await import('node:fs');
  const { readText } = await import('./decode.js');
  const p = process.argv[2];
  if (p) {
    const { text } = readText(p);
    console.log(renderStyle(styleFingerprint(text, { maxChars: 2000000 })));
  }
}