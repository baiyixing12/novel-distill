// core/deai.js
// 去 AI 味检测。纯规则可解释，不调模型、不联网。
// v0.1 只输出「诊断报告」：定位 AI 味来源 + 给出人类写手的对照基线。
// 模型改写留待 v0.2。

import { splitParagraphs, splitSentences, countCJK } from './text.js';

// ── 规则定义 ────────────────────────────────────────────

// 1. Markdown 列表体：行首 * - • 1. 等
const RE_BULLET = /^\s*([*\-•·]|\d+[.、)])\s+\S/;
// 2. 过度解释性括号：（）里是解释而非内容
const RE_EXPLAIN_PAREN = /[（(][^）)]{4,}[）)]/g;
// 3. 中英混排：夹在中文里的英文单词
const RE_ENGLISH_IN_CN = /[\u4e00-\u9fff][A-Za-z]{2,}[\u4e00-\u9fff]/g;
const RE_ENGLISH_WORD = /[A-Za-z]{3,}/g;
// 4. 平行排比堆叠：连续 3 句以上句式高度相似
// 5. 空泛形容词（AI 味的核心是「堆叠」，单个出现算正常用词）
//    仅在短窗口内密集出现才计分，见下方 stagger 逻辑。
const VAGUE_ADJ = ['重要的', '关键的', '深刻的', '独特的', '丰富的', '复杂的', '显著的', '极大的', '巨大的', '彻底的', '完全的', '充分的'];
// 6. 连接词模板（只保留「说教/总结」性，剔除叙事时序词如 首先/然后/最后）
const CONNECTORS = ['总而言之', '综上所述', '总的来说', '需要注意的是', '值得一提的是', '换句话说', '一言以蔽之', '由此可见'];
// 6b. 系统框/提示框特征：小说里作者写的系统提示也算文风，不算 AI 味
const SYSTEM_PAREN_HINT = /宿主|系统|提示|警告|任务|奖励|面板|状态|技能|经验|等级|确认|是否|请选择|叮/;
// 6c. 对话行特征：网文对话本就大量单句成段，需豁免碎片化误判
const RE_DIALOGUE_LINE = /[“”"「」『』]/;
// 7. 破折号/分隔线滥用
const RE_HR = /^\s*(-{3,}|={3,}|\*{3,}|—{3,})\s*$/;
// 8. 「不是……而是……」对仗模板
const RE_NOT_BUT = /不是[^，。；]{1,20}而是/g;
// 9. 空行/短段落碎片化（AI 爱每句一段）
// 10. 破折号解释 "——" 高频

export function deaiScan(text, opts = {}) {
  const maxChars = opts.maxChars || text.length;
  const src = text.slice(0, maxChars);

  const lines = src.split('\n');
  const paragraphs = splitParagraphs(src);
  const sentences = splitSentences(src);
  const totalChars = countCJK(src) || 1;

  const issues = [];
  function add(id, label, count, sample, weight) {
    if (count > 0) issues.push({ id, label, count, sample: sample ? sample.slice(0, 60) : '', weight });
  }

  // 1. Markdown 列表（AI 大纲铁证，权重最高）
  const bulletLines = lines.filter(l => RE_BULLET.test(l));
  add('bullet_list', 'Markdown 列表体（* / - / 数字序号）', bulletLines.length, bulletLines[0], 5);

  // 2. 分隔线（同上，结构型铁证）
  const hrLines = lines.filter(l => RE_HR.test(l));
  add('hr', '分隔线滥用（--- / === / ***）', hrLines.length, hrLines[0], 5);
  // 3. 解释性括号：括号内是「解释」而非正文内容时才计。
  //    排除系统框括号（作者写的系统提示属文风），且要求括号内至少含一个分隔符。
  const parens = src.match(RE_EXPLAIN_PAREN) || [];
  const explainParens = parens.filter(p => {
    if (SYSTEM_PAREN_HINT.test(p)) return false;          // 系统框豁免
    return /[，。、：；]|例如|也就是|即|比如|换言之/.test(p); // 内部有解释性分隔符
  });
  add('explain_paren', '解释性括号（把解释塞进括号）', explainParens.length, explainParens[0], 2);

  // 4. 中英混排：排除「的mod一」这种字母紧贴汉字的词内混排噪声，只收真英文单词
  const enInCn = (src.match(RE_ENGLISH_IN_CN) || []).filter(s => /[A-Za-z]{2,}/.test(s) && /\s[A-Za-z]|[A-Za-z]{3,}/.test(s));
  add('en_cn', '中英混排（中文句里夹英文词）', enInCn.length, enInCn[0], 2);

  // 5. 空泛形容词：单次出现属正常，只在 200 字窗口内密集（≥3 个）才算堆叠
  const vaguePositions = [];
  for (const w of VAGUE_ADJ) {
    let from = 0, idx;
    while ((idx = src.indexOf(w, from)) !== -1) { vaguePositions.push(idx); from = idx + w.length; }
  }
  vaguePositions.sort((a, b) => a - b);
  let vagueStack = 0;
  for (let i = 0; i + 2 < vaguePositions.length; i++) {
    if (vaguePositions[i + 2] - vaguePositions[i] <= 200) vagueStack++;
  }
  add('vague_adj', '空泛形容词堆叠（重要的/深刻的/独特的…密集出现）', vagueStack, '', 2);


  // 6. 连接词模板
  const connHits = [];
  for (const w of CONNECTORS) {
    const c = src.split(w).length - 1;
    if (c > 0) for (let i = 0; i < c; i++) connHits.push(w);
  }
  add('connector', '说教式连接词（首先/其次/总而言之…）', connHits.length, connHits[0], 2);

  // 7. 「不是…而是…」
  const notBut = src.match(RE_NOT_BUT) || [];
  add('not_but', '「不是…而是…」对仗模板', notBut.length, notBut[0], 2);

  // 8. 每句一段（碎片化）——对话为主的文本豁免（网文对话本就单句成段）
  const dialogueLines = lines.filter(l => RE_DIALOGUE_LINE.test(l)).length;
  const dialogueRatio = dialogueLines / (lines.filter(l => l.trim()).length || 1);
  const oneLineParas = paragraphs.filter(p => splitSentences(p).length === 1);
  const fragRatio = oneLineParas.length / (paragraphs.length || 1);
  if (fragRatio > 0.5 && paragraphs.length > 20 && dialogueRatio < 0.5) {
    issues.push({ id: 'fragmented', label: '段落碎片化（大量单句成段）', count: Math.round(fragRatio * 100), sample: '比例 ' + (fragRatio * 100).toFixed(0) + '%', weight: 1 });
  }

  // 9. 平行排比：连续句子长度高度一致
  let parallelRun = 0, maxParallelRun = 0;
  for (let i = 1; i < sentences.length; i++) {
    const a = countCJK(sentences[i - 1]);
    const b = countCJK(sentences[i]);
    if (a > 4 && b > 4 && Math.abs(a - b) <= 2) { parallelRun++; maxParallelRun = Math.max(maxParallelRun, parallelRun); }
    else parallelRun = 0;
  }
  if (maxParallelRun >= 4) {
    issues.push({ id: 'parallel', label: '平行排比堆叠（连续等长句）', count: maxParallelRun, sample: '', weight: 2 });
  }

  // 10. 破折号解释
  const dashExpl = (src.match(/——/g) || []).length;
  add('dash', '破折号解释（——）', dashExpl, '', 1);

  // ── 评分 ──
  // 归一化到「每千字」，避免长文天然分高
  const per1k = n => +(n / totalChars * 1000).toFixed(2);
  let raw = 0;
  for (const it of issues) raw += per1k(it.count) * it.weight;
  for (const it of issues) it.per1k = per1k(it.count);

  const score = Math.min(100, Math.round(raw * 8));
  const level = score >= 60 ? '高' : score >= 30 ? '中' : score >= 12 ? '低' : '很干净';

  return {
    score,
    level,
    totalChars,
    issues: issues.sort((a, b) => (b.per1k * b.weight) - (a.per1k * a.weight)),
  };
}

export function renderDeai(r) {
  const L = [];
  L.push('══════ 去 AI 味检测 ══════');
  L.push(`AI 味评分：${r.score}/100  —— ${r.level}`);
  L.push(`（样本 ${r.totalChars} 字，得分越高越像 AI 生成）`);
  L.push('');
  if (!r.issues.length) {
    L.push('  未发现明显 AI 味特征。');
  } else {
    L.push('命中的 AI 味特征（按严重度排序）：');
    for (const it of r.issues) {
      L.push(`  · ${it.label}`);
      L.push(`      出现 ${it.count} 次（${it.per1k}/千字）${it.sample ? '  例：' + it.sample : ''}`);
    }
  }
  L.push('');
  L.push('人类小说基线对照：正文里一般「解释性括号=0、列表体=0、说教连接词≈0」，');
  L.push('若这些指标非零，基本可判定为大纲/说明文混入，而非叙事正文。');
  L.push('══════════════════════════');
  return L.join('\n');
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const fs = await import('node:fs');
  const p = process.argv[2];
  if (p) {
    const raw = fs.readFileSync(p, 'utf8');
    console.log(renderDeai(deaiScan(raw, { maxChars: 500000 })));
  }
}