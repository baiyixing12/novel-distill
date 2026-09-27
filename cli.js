#!/usr/bin/env node
// cli.js —— novel-distill 主入口
// 对小说正文做「文风指纹 + 设定档案 + 去 AI 味」三合一蒸馏。
// 纯 JS 零依赖，不联网、不调模型。适用于任何 agent / 命令行环境。
//
// 用法：
//   node cli.js <文件> [选项]
//   node cli.js 小说.txt                # 全部三项，打印到终端
//   node cli.js 小说.txt --style        # 只出文风指纹
//   node cli.js 小说.txt --entities     # 只出设定档案
//   node cli.js 小说.txt --deai         # 只出去 AI 味报告
//   node cli.js 小说.txt --json         # 输出 JSON（供上游 agent 消费）
//   node cli.js 小说.txt -o out.md      # 结果写入文件
//   node cli.js 小说.txt --max-chars 200000   # 限制分析字符数（大文件提速）

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readText } from './core/decode.js';
import { splitChapters } from './core/text.js';
import { styleFingerprint, renderStyle } from './core/style.js';
import { extractEntities, renderEntities } from './core/entity.js';
import { deaiScan, renderDeai } from './core/deai.js';
import { pickSlices, parseAnswers, renderSemantic } from './core/deai_semantic.js';

const TOOL_VERSION = '0.2.0';

function parseArgs(argv) {
  const o = { file: null, style: false, entities: false, deai: false, json: false, out: null, maxChars: null, quiet: false, semantic: false, semanticAnswers: null, maxSlices: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--style') o.style = true;
    else if (a === '--entities') o.entities = true;
    else if (a === '--deai') o.deai = true;
    else if (a === '--json') o.json = true;
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--semantic') o.semantic = true;
    else if (a === '--answers') o.semanticAnswers = argv[++i];
    else if (a === '--max-slices') o.maxSlices = parseInt(argv[++i], 10) || null;
    else if (a === '-o' || a === '--out') o.out = argv[++i];
    else if (a === '--max-chars') o.maxChars = parseInt(argv[++i], 10) || null;
    else if (!a.startsWith('-')) o.file = a;
  }
  if (!o.style && !o.entities && !o.deai) { o.style = o.entities = o.deai = true; }
  return o;
}

function usage() {
  console.log(`novel-distill v${TOOL_VERSION} —— 小说文本蒸馏器（文风 / 设定 / 去 AI 味）

用法：node cli.js <文件> [选项]

选项：
  --style          只生成文风指纹
  --entities       只抽取设定档案
  --deai           只做去 AI 味检测
  （不指定则三项全出）
  --json           输出 JSON（供 agent 程序化消费）
  -o, --out <文件>  结果写入指定文件（默认打印到终端）
  --max-chars <N>  最多分析 N 个字符（默认不限，大文件建议设 200000~500000 提速）
  --quiet          静默模式，只输出结果
  -h, --help       显示帮助

语义层复审（两段式，需配合 --deai）：
  --semantic             第一段：跑规则 + 挑可疑片段 + 打印 prompt（供你手动贴给任意模型）
  --answers <json>       第二段：把你从模型拿到的答复（JSON 数组或文件路径）交给本工具解析
  --max-slices <N>       最多挑多少可疑片段，默认 12

  手动模式示例：
    node cli.js 小说.txt --deai --semantic              # 打印 prompt
    node cli.js 小说.txt --deai --answers reply.json    # 校验并融合（reply.json 是模型答复）
  本工具永不联网、不调模型；模型由你（或宿主 agent）提供。`);
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv.includes('-h') || argv.includes('--help')) { usage(); process.exit(0); }
  const o = parseArgs(argv);
  if (!o.file) { console.error('错误：未指定输入文件。\n'); usage(); process.exit(1); }
  if (!fs.existsSync(o.file)) { console.error(`错误：文件不存在：${o.file}`); process.exit(1); }

  const t0 = Date.now();
  // readText 负责编码探测 + 解码（gb18030 / utf-8 / big5 / utf-16 等）
  const { text, encoding, detected } = readText(o.file);
  const encScore = detected && typeof detected.score === 'number' ? detected.score.toFixed(2) : 'n/a';
  const src = o.maxChars ? text.slice(0, o.maxChars) : text;

  const result = { tool: 'novel-distill', version: TOOL_VERSION, file: path.basename(o.file), encoding, encodingScore: encScore };

  if (!o.quiet && !o.json) {
    console.log(`■ 输入：${path.basename(o.file)}`);
    console.log(`  编码探测：${encoding}（置信度 ${encScore}）`);
    console.log(`  文本长度：${text.length} 字${o.maxChars && text.length > o.maxChars ? `（已截取前 ${o.maxChars}）` : ''}`);
    const chapters = splitChapters(src);
    console.log(`  章节数：${chapters.length}`);
    console.log('');
  }

  if (o.style) {
    const fp = styleFingerprint(src);
    result.style = fp;
    if (!o.json) console.log(renderStyle(fp) + '\n');
  }
  if (o.entities) {
    const ents = extractEntities(src);
    result.entities = ents;
    if (!o.json) console.log(renderEntities(ents) + '\n');
  }
  if (o.deai) {
    const d = deaiScan(src, { maxChars: o.maxChars || 500000 });
    result.deai = d;
    if (!o.json) console.log(renderDeai(d) + '\n');

    // ── 语义层复审（两段式手动模式）──
    // --semantic：打印 prompt，让用户手动贴给任意模型（无宿主时的降级路径）
    // --answers ：读取用户从模型拿到的答复，校验并融合
    if (o.semantic || o.semanticAnswers) {
      const { slices, prompt } = pickSlices(d, src, { maxSlices: o.maxSlices || 12 });

      if (o.semanticAnswers) {
        let ansRaw = o.semanticAnswers;
        // 若 --answers 指向一个存在的文件，则读文件内容
        if (fs.existsSync(ansRaw)) ansRaw = fs.readFileSync(ansRaw, 'utf8');
        const report = parseAnswers(d, slices, ansRaw, src);
        result.semantic = report;
        if (!o.json) console.log(renderSemantic(report) + '\n');
      } else {
        // 只出 prompt
        result.semantic = { stage: 1, slices, prompt };
        if (o.json) {
          // JSON 模式下把 prompt 放进 result.semantic（稍后统一输出）
        } else {
          console.log('══════ 语义层复审 · 第一段（挑片 + prompt）══════');
          console.log(`规则分：${d.score}/100（${d.level}）`);
          console.log(`可疑片段：共 ${slices.length} 段`);
          for (const s of slices) console.log(`  · ${s.id}  [${s.ruleHint}]  @${s.range[0]}-${s.range[1]}`);
          console.log('');
          console.log('──── 请把下面这段 prompt 复制给任意模型 ────');
          console.log('');
          console.log(prompt);
          console.log('');
          console.log('──── 拿到模型答复后 ────');
          console.log('把答复存成文件（例如 reply.json），再运行：');
          console.log(`  node cli.js ${o.file} --deai --answers reply.json`);
          console.log('══════════════════════════════════════════');
          console.log('');
        }
      }
    }
  }

  const outStr = o.json ? JSON.stringify(result, null, 2) : '';
  if (o.out) {
    if (o.json) fs.writeFileSync(o.out, outStr, 'utf8');
    else {
      // 非 json 模式写文件：重跑一遍渲染拼接
      const parts = [];
      if (o.style) parts.push(renderStyle(result.style));
      if (o.entities) parts.push(renderEntities(result.entities));
      if (o.deai) parts.push(renderDeai(result.deai));
      fs.writeFileSync(o.out, parts.join('\n\n'), 'utf8');
    }
    console.log(`✓ 结果已写入：${o.out}`);
  } else if (o.json) {
    console.log(outStr);
  }

  if (!o.quiet && !o.json) console.log(`\n（耗时 ${Date.now() - t0}ms）`);
}

main();
