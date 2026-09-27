#!/usr/bin/env node
// mcp-server.js
// novel-distill 的 MCP 薄壳（stdio / JSON-RPC 2.0）。
// 把三个分析器暴露为 MCP 工具，供 Claude / Cursor 类 agent 直接调用。
// 零依赖，可选安装：不用 MCP 时直接用 cli.js 即可。

import { readText } from './core/decode.js';
import { styleFingerprint, renderStyle } from './core/style.js';
import { extractEntities, renderEntities } from './core/entity.js';
import { deaiScan, renderDeai } from './core/deai.js';

const PROTOCOL = '2024-11-05';
const VERSION = '0.1.0';
const DEFAULT_CAP = 500000;

const TOOLS = [
  {
    name: 'distill_style',
    description: '对小说正文做文风指纹提取：段落/句子长度分布、标点密度、对话占比、比喻密度等。输入本地文本文件路径，输出可读报告。',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '本地文本文件绝对路径（自动探测 utf-8 / gb18030 / big5 等编码）' },
        maxChars: { type: 'number', description: '最多分析多少字符，默认 500000' },
        json: { type: 'boolean', description: '为 true 时返回结构化 JSON 而非 Markdown 报告' }
      },
      required: ['file']
    }
  },
  {
    name: 'distill_entities',
    description: '从小说正文抽取设定档案：人物 / 地点 / 组织 / 物件四类实体及出现频次。用于生成世界观设定文档。',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '本地文本文件绝对路径' },
        maxChars: { type: 'number', description: '最多分析多少字符，默认 500000' },
        json: { type: 'boolean', description: '为 true 时返回结构化 JSON' }
      },
      required: ['file']
    }
  },
  {
    name: 'distill_deai',
    description: 'AI 味检测：纯规则、可解释，定位 AI 写作痕迹（列表体、解释性括号、空泛形容词堆叠、说教连接词、平行排比等）并给 0-100 评分。不调模型、不联网。',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '本地文本文件绝对路径' },
        maxChars: { type: 'number', description: '最多分析多少字符，默认 500000' },
        json: { type: 'boolean', description: '为 true 时返回结构化 JSON' }
      },
      required: ['file']
    }
  },
  {
    name: 'distill_all',
    description: '一次性产出全部三项：文风指纹 + 设定档案 + AI 味检测。',
    inputSchema: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '本地文本文件绝对路径' },
        maxChars: { type: 'number', description: '最多分析多少字符，默认 500000' },
        json: { type: 'boolean', description: '为 true 时返回结构化 JSON' }
      },
      required: ['file']
    }
  }
];

function log(msg) {
  process.stderr.write('[novel-distill] ' + msg + '\n');
}

function send(obj) {
  const payload = JSON.stringify(obj);
  process.stdout.write(payload + '\n');
}

function ok(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

function cap(args) {
  const n = Number(args && args.maxChars);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return DEFAULT_CAP;
}

function runTool(name, args) {
  const file = args && args.file;
  if (!file) throw new Error('缺少参数 file');

  const loaded = readText(file);
  const limit = cap(args);
  const raw = loaded.text.slice(0, limit);
  const encScore = loaded.detected && Number.isFinite(loaded.detected.score)
    ? loaded.detected.score.toFixed(2)
    : 'n/a';

  const head =
    '文件: ' + file + '\n' +
    '编码: ' + loaded.encoding + '  置信度: ' + encScore + '\n' +
    '分析字符数: ' + raw.length + (loaded.text.length > limit ? '（原文 ' + loaded.text.length + '，已截取）' : '') + '\n';

  const wantJson = !!(args && args.json);

  if (name === 'distill_style') {
    const fp = styleFingerprint(raw);
    return wantJson ? JSON.stringify(fp, null, 2) : head + '\n' + renderStyle(fp);
  }
  if (name === 'distill_entities') {
    const ents = extractEntities(raw);
    return wantJson ? JSON.stringify(ents, null, 2) : head + '\n' + renderEntities(ents);
  }
  if (name === 'distill_deai') {
    const deai = deaiScan(raw, { maxChars: limit });
    return wantJson ? JSON.stringify(deai, null, 2) : head + '\n' + renderDeai(deai);
  }
  if (name === 'distill_all') {
    const fp = styleFingerprint(raw);
    const ents = extractEntities(raw);
    const deai = deaiScan(raw, { maxChars: limit });
    if (wantJson) {
      return JSON.stringify({
        tool: 'novel-distill', version: VERSION, file,
        encoding: loaded.encoding, encodingScore: encScore,
        analyzedChars: raw.length, style: fp, entities: ents, deai
      }, null, 2);
    }
    return head + '\n' + renderStyle(fp) + '\n\n' + renderEntities(ents) + '\n\n' + renderDeai(deai);
  }
  throw new Error('未知工具: ' + name);
}

function handle(msg) {
  const { id, method, params } = msg;

  if (method === 'initialize') {
    return ok(id, {
      protocolVersion: PROTOCOL,
      capabilities: { tools: {} },
      serverInfo: { name: 'novel-distill', version: VERSION }
    });
  }
  if (method === 'notifications/initialized' || method === 'initialized') {
    return;
  }
  if (method === 'ping') {
    return ok(id, {});
  }
  if (method === 'tools/list') {
    return ok(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    try {
      const text = runTool(name, args);
      return ok(id, textResult(text));
    } catch (e) {
      return ok(id, { content: [{ type: 'text', text: '错误: ' + (e && e.message ? e.message : String(e)) }], isError: true });
    }
  }
  if (id != null) fail(id, -32601, '未实现的方法: ' + method);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (e) {
      log('无法解析的 JSON-RPC 行，已忽略');
      continue;
    }
    try {
      handle(msg);
    } catch (e) {
      log('处理消息出错: ' + (e && e.message ? e.message : String(e)));
      if (msg && msg.id != null) fail(msg.id, -32603, String(e && e.message || e));
    }
  }
});
process.stdin.on('end', () => process.exit(0));

log('novel-distill MCP server 已启动 (v' + VERSION + ')');
