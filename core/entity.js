// core/entity.js
// 设定文档抽取：人物 / 地名 / 组织 / 术语 / 物件。
// 纯规则 + 词频 + 上下文共现，零依赖。

import { splitChapters, countCJK, freq, sortedFreq } from './text.js';

// 常见中文姓氏（复姓在前）
const SURNAMES = [
  '欧阳', '上官', '司马', '诸葛', '东方', '皇甫', '尉迟', '公孙', '慕容', '长孙',
  '宇文', '司徒', '司空', '令狐', '独孤', '南宫', '西门', '夏侯', '轩辕', '端木',
  '王', '李', '张', '刘', '陈', '杨', '赵', '黄', '周', '吴', '徐', '孙', '胡', '朱',
  '高', '林', '何', '郭', '马', '罗', '梁', '宋', '郑', '谢', '韩', '唐', '冯', '于',
  '董', '萧', '程', '曹', '袁', '邓', '许', '傅', '沈', '曾', '彭', '吕', '苏', '卢',
  '蒋', '蔡', '贾', '丁', '魏', '薛', '叶', '阎', '余', '潘', '杜', '戴', '夏', '钟',
  '汪', '田', '任', '姜', '范', '方', '石', '姚', '谭', '廖', '邹', '熊', '金', '陆',
  '郝', '孔', '白', '崔', '康', '毛', '邱', '秦', '江', '史', '顾', '侯', '邵', '孟',
  '龙', '万', '段', '章', '钱', '汤', '尹', '黎', '易', '常', '武', '乔', '贺', '赖',
  '龚', '文', '庞', '樊', '兰', '殷', '施', '陶', '洪', '翟', '安', '颜', '倪', '严',
  '牛', '温', '芦', '季', '俞', '章', '鲁', '葛', '伍', '韦', '申', '尤', '毕',
];

// 身份/称谓后缀（用于识别角色）
const ROLE_SUFFIX = [
  '陛下', '殿下', '大人', '先生', '小姐', '夫人', '太太', '将军', '元帅', '公爵',
  '侯爵', '伯爵', '子爵', '男爵', '骑士', '法师', '巫师', '魔女', '圣女', '教皇',
  '国王', '女王', '王子', '公主', '皇帝', '皇后', '领主', '城主', '团长', '队长',
  '老师', '教授', '博士', '大师', '长老', '族长', '会长', '掌柜', '老板',
];

// 地名后缀
const PLACE_SUFFIX = [
  '王国', '帝国', '公国', '联邦', '共和国', '城', '镇', '村', '市', '郡', '州',
  '省', '国', '大陆', '大陆', '岛', '半岛', '海', '洋', '湖', '河', '江', '山',
  '山脉', '森林', '沙漠', '草原', '平原', '峡谷', '要塞', '城堡', '宫殿', '神殿',
  '教堂', '学院', '学院', '广场', '街道', '港', '港口', '关', '谷', '岭', '域',
];

// 组织后缀
const ORG_SUFFIX = [
  '教会', '骑士团', '军团', '工会', '公会', '商会', '家族', '家', '门派', '宗',
  '帮', '堂', '会', '团', '军', '盟', '阁', '楼', '院', '所', '局', '署',
];

// 物件/概念后缀
const ITEM_SUFFIX = [
  '剑', '刀', '枪', '弓', '杖', '盾', '铠甲', '戒指', '项链', '宝石', '水晶',
  '药剂', '卷轴', '魔杖', '法杖', '神器', '圣器', '符文', '阵法', '结界', '诅咒',
  '血脉', '血统', '契约', '誓约', '魔力', '魔法', '斗气', '灵力', '圣光', '深渊',
];

const SUFFIX_TABLES = [
  { type: '组织', list: ORG_SUFFIX },
  { type: '地点', list: PLACE_SUFFIX },
  { type: '物件', list: ITEM_SUFFIX },
];

function inRange(cp, lo, hi) { return cp >= lo && cp <= hi; }
function isCJKChar(ch) {
  const cp = ch.codePointAt(0);
  return inRange(cp, 0x4e00, 0x9fff);
}

// 虚词/停用前缀与后缀：出现在词首或词尾说明是跨词边界误抽
const STOP_HEAD = new Set(['的', '在', '个', '是', '会', '也', '都', '就', '还', '才', '又', '很', '不', '没', '有', '和', '与', '及', '或', '把', '被', '让', '给', '向', '从', '到', '对', '为', '因', '所', '以', '这', '那', '些', '们', '我', '你', '他', '她', '它', '全', '半', '第', '之', '其', '若', '但', '而', '且', '则', '即', '便', '于', '乎', '者', '的']);
const STOP_TAIL = new Set(['的', '了', '着', '过', '们', '之', '者', '地', '得', '和', '与', '及', '或', '而', '且', '是', '在', '有', '会', '要', '能', '可', '就', '都', '也', '把', '被', '个', '些', '个', '上', '下', '里', '中', '外', '时', '后', '前', '间']);
// 通用名词黑名单：这些词即便带后缀也几乎不可能是作品专有名词。
// 分三层：① 章节/排版残留 ② 常见通用名词 ③ 泛化身份/抽象词。
// 用「精确匹配」过滤，不误伤含这些字的长专名（如「星港城」不是「城市」）。
const GENERIC_BLACKLIST = new Set([
  // ① 章节 / 排版残留
  '章完', '本章完', '未完待续', '请收藏', '求推荐', '求月票', '求订阅',
  '第一', '第二', '第三', '下一', '上一', '最大', '最小',
  // ② 常见通用名词（几乎必然是普通名词而非专名）
  '城市', '小镇', '村庄', '国家', '世界', '大陆', '天空', '太阳', '月亮',
  '学院', '学校', '医院', '商店', '市场', '街道', '广场', '公园', '车站',
  '房间', '房子', '门口', '窗户', '桌子', '椅子', '床', '灯',
  '身体', '脑袋', '眼睛', '嘴巴', '双手', '双脚', '心脏', '血液',
  '时间', '时候', '地方', '东西', '事情', '问题', '情况', '感觉',
  '声音', '样子', '办法', '结果', '原因', '关系', '意思', '感情',
  '力量', '能力', '气息', '魔法', '魔力', '灵力', '斗气', '圣光',
  '武器', '铠甲', '服装', '食物', '马车', '船只',
  // ③ 泛化身份 / 抽象词
  '大家', '人们', '众人', '别人', '自己', '对方', '各位',
  '老师', '学生', '朋友', '敌人', '家人', '父母', '孩子',
  '其中', '之后', '之前', '最后', '开始', '结束', '现在', '当时',
  '一样', '许多', '一些', '一点', '一直', '已经', '仿佛', '似乎',
  '生命', '死亡', '命运', '希望', '梦想', '记忆', '灵魂', '意识',
  '训练', '任务', '计划', '目标', '行动', '选择', '决定', '方式',
]);

// 明显的非专名词（口语/功能短语）
const STOP_WORDS = new Set([
  // 常见口语/职业/通用词（词级过滤，不会误伤专名）
  '管家', '一家', '大家', '学院', '学校', '许多人', '众人', '那人', '这人', '有人',
  '不会', '也会', '就会', '都会', '还会', '才会', '是会', '一会', '了一会', '大家',
  '许多', '方法', '方面', '方面', '相关', '方向', '脑海', '机会', '有所', '谢谢',
  '许久之', '段时间', '许多', '人家', '武器', '马车', '事情', '时候', '地方', '东西',
  '问题', '情况', '感觉', '眼神', '目光', '心中', '内心', '声音', '样子', '回事',
  '温暖', '安静', '高大', '曾经', '周围', '白色', '金色', '黄昏时', '温暖的', '安静的',
]);

function looksLikeWord(w) {
  if (w.length < 2) return false;
  if (STOP_WORDS.has(w)) return false;
  if (GENERIC_BLACKLIST.has(w)) return false;
  if (STOP_HEAD.has(w[0])) return false; // 以虚词开头 → 跨边界
  if (STOP_TAIL.has(w[w.length - 1])) return false; // 以虚词结尾 → 跨边界
  if (hasBadHead(w)) return false; // 以量词/指示/动词开头 → 跨边界
  // 通用规则：短词若完全由「通用名词字」构成（如「城市」「地方」），过滤。
  if (w.length <= 3 && isAllGenericChars(w)) return false;
  return true;
}

// 通用名词用字（低专名信息量），仅作辅助，配合长度判定使用
const GENERIC_CHARS = new Set('城市镇村国家世界天地日月星云山海河湖林田道路街道口门窗桌椅床灯身体头脸眼嘴手脚心血肉脑声影光亮暗色香味道时地东西事情问感情力能气息法灵斗器甲衣食车船人们自己对方众位老师学友敌家父母孩子'.split(''));

// 前置字：只保留真正的量词/称量单字，不收专名首字（如「提」「一」「大」）
const BAD_HEAD = new Set('座个只支颗张片双对群些种份场次回顿番遍层排串堆束把'.split(''));
function hasBadHead(w) {
  return BAD_HEAD.has(w[0]);
}
function isAllGenericChars(w) {
  for (const ch of w) if (!GENERIC_CHARS.has(ch)) return false;
  return true;
}

// 用「后缀 + 前缀N字」扫描法抽实体词
function scanBySuffix(text, list, type, ctx) {
  const hits = new Map();
  for (const suf of list) {
    let from = 0;
    while (true) {
      const idx = text.indexOf(suf, from);
      if (idx < 0) break;
      from = idx + suf.length;
      // 向前取 1..6 个 CJK 字作前缀
      let start = idx;
      let cnt = 0;
      while (start > 0 && cnt < 8 && isCJKChar(text[start - 1])) { start--; cnt++; }
      for (let take = 1; take <= Math.min(cnt, 6); take++) {
        const word = text.slice(idx - take, idx + suf.length);
        if (!looksLikeWord(word)) continue;
        const key = word;
        if (!hits.has(key)) hits.set(key, { count: 0 });
        hits.get(key).count++;
      }
    }
  }
  // 只保留「最长」的切法：若 A 是 B 的前缀且 B 计数接近 A，倾向保留 B
  const words = [...hits.entries()].map(([w, v]) => ({ w, c: v.count }));
  words.sort((a, b) => b.c - a.c || b.w.length - a.w.length);
  const kept = [];
  for (const cand of words) {
    if (cand.c < 2) continue;
    // 若已保留的词包含它且计数更大，跳过（避免「兰西」「西王国」并存）
    const sub = kept.find(k => k.w.includes(cand.w) && k.c >= cand.c * 0.6);
    if (sub) continue;
    kept.push(cand);
    if (kept.length >= 60) break;
  }
  for (const k of kept) {
    if (!ctx[k.w]) { ctx[k.w] = { type, count: k.c }; }
  }
}

// 扫人名：姓氏 + 1~2 字名，用「称谓后缀」和「对话主导」双重加权
function scanNames(text, ctx) {
  const counts = new Map();
  for (const sur of SURNAMES) {
    const re = new RegExp(escapeRe(sur) + '[\\u4e00-\\u9fff]?[\\u4e00-\\u9fff]?', 'g');
    let m;
    while ((m = re.exec(text))) {
      const name = m[0];
      if (name.length < sur.length + 1) { // 只有姓，跳过
        // 但「王」后跟标点的可能是单姓称呼，跳过
        continue;
      }
      if (!looksLikeWord(name)) continue;
      counts.set(name, (counts.get(name) || 0) + 1);
    }
  }
  const kept = [...counts.entries()].filter(([, c]) => c >= 5)
    .sort((a, b) => b[1] - a[1]).slice(0, 80);
  for (const [name, c] of kept) {
    if (!ctx[name] || c > (ctx[name].count || 0)) {
      ctx[name] = { type: '人物', count: c };
    }
  }
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function extractEntities(text, opts = {}) {
  const maxChars = opts.maxChars || 0;
  let src = text;
  if (maxChars > 0 && text.length > maxChars) src = text.slice(0, maxChars);

  const ctx = {};
  scanNames(src, ctx);
  for (const { type, list } of SUFFIX_TABLES) scanBySuffix(src, list, type, ctx);

  // 分类
  const byType = { 人物: [], 地点: [], 组织: [], 物件: [] };
  for (const [w, v] of Object.entries(ctx)) {
    const t = byType[v.type] ? v.type : '物件';
    byType[t].push({ w, c: v.count });
  }
  for (const k of Object.keys(byType)) {
    byType[k].sort((a, b) => b.c - a.c);
    byType[k] = byType[k].slice(0, 50);
  }
  return byType;
}

export function renderEntities(ents) {
  const L = [];
  L.push('══════ 设定档案 ══════');
  const order = ['人物', '地点', '组织', '物件'];
  const labels = { 人物: '人物', 地点: '地点 / 势力范围', 组织: '组织 / 势力', 物件: '术语 / 物件 / 概念' };
  for (const t of order) {
    const arr = ents[t] || [];
    L.push('');
    L.push(`【${labels[t]}】 共 ${arr.length} 项`);
    L.push('  ' + arr.slice(0, 40).map(x => `${x.w}(${x.c})`).join('  '));
  }
  L.push('══════════════════════');
  return L.join('\n');
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const { readText } = await import('./decode.js');
  const p = process.argv[2];
  if (p) {
    const { text } = readText(p);
    console.log(renderEntities(extractEntities(text, { maxChars: 2000000 })));
  }
}