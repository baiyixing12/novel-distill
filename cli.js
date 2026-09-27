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

const TOOL_VERSION = '0.1.0';

function parseArgs(argv) {
  const o = { file: null, style: false, entities: false, deai: false, json: false, out: null, maxChars: null, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--style') o.style = true;
    else if (a === '--entities') o.entities = true;
    else if (a === '--deai') o.deai = true;
    else if (a === '--json') o.json = true;
    else if (a === '--quiet') o.quiet = true;
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
  -h, --help       显示帮助`);
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
