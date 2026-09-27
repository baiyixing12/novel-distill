// core/deai_semantic.js
// 语义层 AI 味检测（两段式插件协议）——纯字符串处理，零依赖、不联网、不调模型。
//
// 为什么是「两段式」：
//   本模块是 agent 的插件，宿主 agent 本身有模型能力。
//   所以插件只负责两件事：① 定义「要问什么」 ② 解析「答了什么」。
//   模型调用由宿主完成 —— 插件永远不碰 API key、不联网、不知道用的是哪种模型。
//
// 流程：
//   stage1：规则跑完 → 挑出「语义可疑片段」→ 组装 prompt 字符串（纯文本，不发请求）
//   [宿主 agent 拿 prompt 去问自己的模型，拿到 JSON 答案]
//   stage2：接收宿主回传的 semanticAnswers → 逐条校验（防幻觉）→ 与规则分并列融合
//
// 校验红线：模型返回的 quote 必须能在原文对应区间内找到，否则丢弃该条。
//   这是防止模型「编造一个不存在的句子」当证据。

// ── 常量 ──────────────────────────────────────────────

// 每个可疑片段的上下文窗口（前后各取多少字），给模型足够语境但不至于淹没
const CONTEXT_PAD = 60;
// 单条片段正文最多截取多少字
const SLICE_MAX = 220;
// 一次最多挑多少片（控制 prompt 体积与宿主成本）
const DEFAULT_MAX_SLICES = 12;
// 片段之间至少间隔多少字，避免同一处反复挑
const MIN_GAP = 120;

// 规则命中项 → 语义审视重点 的映射。
// 规则是「结构化」的（列表体、括号、连接词），模型要补的是「语义空洞」：
// 说了一堆但没信息量、情绪是贴标签贴出来的、动作是抽象概括而非具体动作。
const RULE_FOCUS = {
  bullet_list: '这段是被排版成条目的说明文，请判断它是否缺少叙事性、只是信息的罗列',
  hr: '这片区域被分隔线切碎，请判断分隔前后的段落是否各自空洞、缺乏推进',
  explain_paren: '括号里在替读者解释，请判断该解释是否属于多余的说教、打断了叙事呼吸',
  en_cn: '中英混排处，请判断该英文词是否生硬、像术语堆砌而非人物自然口吻',
  vague_adj: '形容词密集，请判断这些形容词是否只是情绪标签、删掉后信息量几乎不变',
  connector: '说教连接词，请判断这句是否在做总结陈词而非推进情节',
  not_but: '「不是…而是…」对仗，请判断是否属于模板化的顿悟句式、缺乏真实心理过程',
  fragmented: '单句成段比例高，请判断是否只是断句造节奏、内容上并未真正推进',
  parallel: '连续等长句，请判断是否属于排比堆砌、语感机械',
  dash: '破折号频繁，请判断是否在用过度的停顿制造并不存在的张力'
};

// 与规则无关，纯语义通吃的审视维度（挑片时若某段无规则命中仍可疑时用）
const GENERIC_FOCUS = '请判断这段是否「看着通顺但信息空洞」：情绪靠形容词贴标签、动作是抽象概括、没有具体的人/物/动作细节';

// ── stage1：挑片 ──────────────────────────────────────

// 在原文里定位一个 issue 的典型出现位置（取第一条命中样本附近）。
// 规则只给了 count 和 sample，没给位置，所以这里用 sample 的首次出现定位；
// 定位不到则退回该 issue 在文本中的启发式扫描位置。
function locateIssue(text, issue) {
  const hits = [];
  const sample = issue.sample && issue.sample.trim();

  if (sample && sample.length >= 2) {
    let from = 0, idx;
    while ((idx = text.indexOf(sample, from)) !== -1) {
      hits.push(idx);
      from = idx + sample.length;
      if (hits.length >= 8) break;
    }
  }
  return hits;
}

/**
 * stage1 挑片：从规则结果里挑出值得交给模型「语义复审」的片段。
 * @param {object} ruleResult  deaiScan() 的返回值
 * @param {string} text        原文（须与喂给 deaiScan 的一致）
 * @param {object} opts        { maxSlices }
 * @returns {{ slices: Array, prompt: string }}
 */
export function pickSlices(ruleResult, text, opts = {}) {
  const maxSlices = opts.maxSlices || DEFAULT_MAX_SLICES;
  const issues = (ruleResult && ruleResult.issues) || [];

  // 候选位置：把每个 issue 的命中位置摊平，带上「这个位置为什么可疑」的语义提示
  const candidates = [];
  for (const issue of issues) {
    const focus = RULE_FOCUS[issue.id] || GENERIC_FOCUS;
    const locs = locateIssue(text, issue);
    if (!locs.length) {
      // 定位不到具体位置（如纯统计型 issue），跳过——宁可少挑，不硬凑
      continue;
    }
    // 按严重度加权：per1k*weight 越高，越优先挑它的命中点
    const sev = (issue.per1k || 0) * (issue.weight || 1);
    for (const at of locs) {
      candidates.push({ at, issueId: issue.id, label: issue.label, focus, sev });
    }
  }

  // 严重度降序 → 挑片，带最小间隔去重
  candidates.sort((a, b) => b.sev - a.sev);

  const chosen = [];
  const taken = []; // 已占用的中心点，用于间隔去重
  for (const c of candidates) {
    if (chosen.length >= maxSlices) break;
    if (taken.some(t => Math.abs(t - c.at) < MIN_GAP)) continue;
    taken.push(c.at);
    chosen.push(c);
  }

  // 若规则命中太少，用「长段落」做兜底补片：语义空洞常出现在又长又平的段落里
  if (chosen.length < Math.min(6, maxSlices)) {
    const paras = text.split(/\n\s*\n/);
    let cursor = 0;
    for (const p of paras) {
      if (chosen.length >= maxSlices) break;
      const len = p.trim().length;
      if (len >= 120) {
        const at = cursor + Math.floor((p.length - Math.min(SLICE_MAX, len)) / 2);
        if (!taken.some(t => Math.abs(t - at) < MIN_GAP)) {
          taken.push(at);
          chosen.push({ at, issueId: 'long_para', label: '长段落（语义兜底）', focus: GENERIC_FOCUS, sev: 0 });
        }
      }
      cursor += p.length + 2;
    }
  }

  // 按原文位置排序，阅读顺序更自然
  chosen.sort((a, b) => a.at - b.at);

  const slices = chosen.map((c, i) => {
    const start = Math.max(0, c.at - CONTEXT_PAD);
    const end = Math.min(text.length, c.at + SLICE_MAX);
    const body = text.slice(start, end);
    return {
      id: 'S' + (i + 1),
      issueId: c.issueId,
      ruleHint: c.label,
      focus: c.focus,
      range: [start, end],
      text: body
    };
  });

  return { slices, prompt: buildPrompt(slices) };
}

// ── prompt 组装（纯字符串，不发请求）───────────────────

/**
 * 把挑出的片段组装成一段给宿主模型的提问文本。
 * 注意：这里只返回字符串。谁去问模型、用什么模型、要不要问，全由宿主决定。
 */
export function buildPrompt(slices) {
  if (!slices || !slices.length) {
    return '（无可疑片段，无需语义复审。规则分即为最终分。）';
  }

  const L = [];
  L.push('你是一个中文小说文本的「语义层 AI 味」审查器。');
  L.push('');
  L.push('背景：已有一套规则检测器抓出了结构化的 AI 味（列表体、解释性括号、说教连接词等）。');
  L.push('但它抓不到「语义空洞」——句子看着通顺，却只是情绪标签、抽象概括，没有具体的人、物、动作。');
  L.push('你的任务是逐段判断：这段是不是「像 AI 写的」——注意，判断依据是语义空洞，不是题材。');
  L.push('人类写手也会写平淡的段落，不要因为「平淡」就打高 AI 味；要因为「空转、贴标签、无具体信息」才打高。');
  L.push('');
  L.push('评分口径（0-100，越高越像 AI）：');
  L.push('  0-20   有具体的人/物/动作细节，是人类正常写作');
  L.push('  21-50  略显空泛，但基本可读，有问题不大');
  L.push('  51-75  明显依赖形容词贴情绪、动作抽象、信息量低');
  L.push('  76-100 典型 AI 腔：大词堆叠、总结陈词、无实质内容');
  L.push('');
  L.push('待审片段（共 ' + slices.length + ' 段）：');
  L.push('');
  for (const s of slices) {
    L.push('--- ' + s.id + '（规则提示：' + s.ruleHint + '）---');
    L.push('复审重点：' + s.focus);
    L.push('原文：');
    L.push(s.text);
    L.push('');
  }
  L.push('请严格输出 JSON 数组，不要任何解释、不要 markdown 代码块包裹，格式：');
  L.push('[{"id":"S1","score":数字,"reason":"一句话理由","quote":"从原文里原样复制的证据句"}]');
  L.push('要求：');
  L.push('  1. 每个片段都要有一条结果，id 与上面一一对应。');
  L.push('  2. quote 必须是从该片段原文里「原样复制」的一小句，用于校验，不可改写、不可编造。');
  L.push('  3. reason 不超过 40 字。');
  L.push('  4. 只输出 JSON 数组本身。');
  return L.join('\n');
}

// ── stage2：解析 + 校验 + 融合 ────────────────────────

// 从模型自由回复里抠出 JSON（容忍 markdown 代码块、前后废话）
function extractJsonArray(raw) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  // 去掉 ```json ... ``` 包裹
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  // 直接尝试
  try {
    const v = JSON.parse(s);
    if (Array.isArray(v)) return v;
    if (v && Array.isArray(v.answers)) return v.answers;
    if (v && Array.isArray(v.results)) return v.results;
  } catch (_) { /* 继续用抠取法 */ }
  // 抠第一个 [ ... ] 平衡块
  const start = s.indexOf('[');
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < s.length; i++) {
      if (s[i] === '[') depth++;
      else if (s[i] === ']') {
        depth--;
        if (depth === 0) {
          try {
            const v = JSON.parse(s.slice(start, i + 1));
            if (Array.isArray(v)) return v;
          } catch (_) { /* ignore */ }
          break;
        }
      }
    }
  }
  return null;
}

// 归一化：把任意输入（字符串 / 对象数组）变成标准 answers
function normalizeAnswers(input) {
  let arr = input;
  if (typeof input === 'string') arr = extractJsonArray(input);
  if (!Array.isArray(arr)) return { answers: [], error: '无法从输入中解析出 JSON 数组' };
  const answers = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const id = typeof item.id === 'string' ? item.id.trim() : null;
    if (!id) continue;
    let score = Number(item.score);
    if (!Number.isFinite(score)) score = null;
    if (score != null) score = Math.max(0, Math.min(100, Math.round(score)));
    answers.push({
      id,
      score,
      reason: typeof item.reason === 'string' ? item.reason.slice(0, 120) : '',
      quote: typeof item.quote === 'string' ? item.quote.trim() : ''
    });
  }
  return { answers, error: null };
}

// quote 是否能在原文对应区间内找到（模糊容错：去掉空白后比对）
function quoteGrounded(quote, text, range) {
  if (!quote || quote.length < 2) return false;
  const [start, end] = range || [0, text.length];
  const window = text.slice(start, end);
  const norm = s => s.replace(/\s+/g, '');
  const q = norm(quote);
  if (q.length < 2) return false;
  if (norm(window).includes(q)) return true;
  // 容错：模型可能截取跨窗口边界的句子，放宽到全文再试一次
  return norm(text).includes(q);
}

/**
 * stage2：接收宿主模型的答案，校验后与规则分融合。
 * @param {object} ruleResult                 deaiScan() 结果
 * @param {Array}  slices                     stage1 返回的 slices（用于校验锚点）
 * @param {*}      semanticInput              宿主模型返回（数组或原始字符串）
 * @param {string} text                       原文
 * @returns {object} 融合报告
 */
export function parseAnswers(ruleResult, slices, semanticInput, text) {
  const { answers, error } = normalizeAnswers(semanticInput);
  const sliceMap = new Map((slices || []).map(s => [s.id, s]));

  const accepted = [];
  const rejected = [];

  for (const a of answers) {
    const s = sliceMap.get(a.id);
    if (!s) { rejected.push({ ...a, dropReason: '未知片段 id' }); continue; }
    if (a.score == null) { rejected.push({ ...a, dropReason: 'score 非数字' }); continue; }
    if (!quoteGrounded(a.quote, text, s.range)) {
      rejected.push({ ...a, dropReason: 'quote 无法在原文定位（疑似幻觉）' });
      continue;
    }
    accepted.push({
      id: a.id,
      issueId: s.issueId,
      ruleHint: s.ruleHint,
      range: s.range,
      score: a.score,
      reason: a.reason,
      quote: a.quote
    });
  }

  // 语义分 = 已接受片段的平均分（无接受片段则不参与融合）
  const semanticScore = accepted.length
    ? Math.round(accepted.reduce((sum, a) => sum + a.score, 0) / accepted.length)
    : null;

  // ── 融合口径：并列，不加权成一个数 ──
  // 规则分与语义分各自独立展示。理由：可复核、可审计；
  // 「规则说干净但模型觉得这段有 AI 味」这个分歧本身就是信息，
  // 强行加权成单一数字会掉回不可解释，削弱插件的通用性。
  const ruleScore = ruleResult ? ruleResult.score : null;
  let verdict = '两者一致';
  if (semanticScore != null && ruleScore != null) {
    const d = semanticScore - ruleScore;
    if (d >= 25) verdict = '语义层比规则层更可疑（规则抓不到的空洞）';
    else if (d <= -25) verdict = '规则层比语义层更可疑（结构性痕迹明显，但文字本身有细节）';
  }

  return {
    ruleScore,
    ruleLevel: ruleResult ? ruleResult.level : null,
    semanticScore,
    semanticSamples: accepted.length,
    verdict,
    accepted,
    rejected,
    parseError: error,
    note: '规则分与语义分并列，不合并为单一分数。分歧本身即为诊断信息。'
  };
}

// ── 渲染 ──────────────────────────────────────────────

export function renderSemantic(report) {
  const L = [];
  L.push('══════ 语义层复审（两段式插件）══════');
  L.push(`规则分：${report.ruleScore != null ? report.ruleScore + '/100（' + report.ruleLevel + '）' : '未提供'}`);
  L.push(`语义分：${report.semanticScore != null ? report.semanticScore + '/100（有效样本 ' + report.semanticSamples + '）' : '未获得有效答案'}`);
  L.push(`结论：${report.verdict}`);
  L.push('');
  if (report.accepted && report.accepted.length) {
    L.push('模型复审明细（已通过 quote 校验）：');
    for (const a of report.accepted) {
      L.push(`  · [${a.id}] ${a.score} 分  （规则提示：${a.ruleHint}）`);
      L.push(`      理由：${a.reason}`);
      L.push(`      证据：${a.quote}`);
    }
  }
  if (report.rejected && report.rejected.length) {
    L.push('');
    L.push(`已丢弃 ${report.rejected.length} 条（防幻觉）：`);
    for (const r of report.rejected) {
      L.push(`  · [${r.id || '?'}] ${r.dropReason}`);
    }
  }
  L.push('');
  L.push(report.note);
  L.push('══════════════════════════════════');
  return L.join('\n');
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  console.log('core/deai_semantic.js —— 两段式语义复审模块。');
  console.log('导出：pickSlices(ruleResult, text, opts) / buildPrompt(slices) / parseAnswers(ruleResult, slices, input, text) / renderSemantic(report)');
}
