#!/usr/bin/env node
// ====================================================================
//  knowlink-page — KnowLink 知识星系页面生成器 CLI
//  用法：
//    node bin/knowlink-page.mjs validate <input.json> [--json]
//    node bin/knowlink-page.mjs render   <input.json> [output.html] [--json]
//    node bin/knowlink-page.mjs demo     [output-directory]
//    node bin/knowlink-page.mjs doctor
//  流程：读 JSON 规范 → schema 校验 → Node 端预计算布局 → 注入模板 → 输出自包含 HTML
// ====================================================================

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const skillRoot = path.resolve(__dirname, '..');

// ==================== 工具 ====================
function fail(message, code = 2) {
  console.error(message);
  process.exit(code);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    fail(`无法读取或解析 JSON: ${file}\n  ${e.message}`);
  }
}

function sha256(str) {
  return createHash('sha256').update(str).digest('hex');
}

// ==================== 校验（手写 schema 检查，零依赖） ====================
function validateSpec(spec) {
  const errors = [];
  const warnings = [];
  const ids = new Set();

  // meta
  if (!spec || typeof spec !== 'object') {
    errors.push({ code: 'spec-not-object', message: '规范必须是 JSON 对象' });
    return { valid: false, errors, warnings };
  }
  if (!spec.meta || typeof spec.meta !== 'object') {
    errors.push({ code: 'meta-required', message: '缺少 meta 对象' });
  } else if (!spec.meta.title || typeof spec.meta.title !== 'string' || !spec.meta.title.trim()) {
    errors.push({ code: 'meta-title-required', message: 'meta.title 必填且非空' });
  }
  if (spec.meta && spec.meta.locale && !['zh-CN', 'en'].includes(spec.meta.locale)) {
    errors.push({ code: 'meta-locale-invalid', message: 'meta.locale 仅支持 zh-CN / en' });
  }

  // points
  if (!Array.isArray(spec.points) || spec.points.length === 0) {
    errors.push({ code: 'points-required', message: 'points 必填且至少 1 条' });
  } else {
    if (spec.points.length > 200) {
      warnings.push({ code: 'points-too-many', message: `points 超过 200 条（${spec.points.length}），建议精简` });
    }
    spec.points.forEach((p, i) => {
      if (!p || typeof p !== 'object') {
        errors.push({ code: 'point-invalid', message: `points[${i}] 不是对象` });
        return;
      }
      if (!p.title || typeof p.title !== 'string' || !p.title.trim()) {
        errors.push({ code: 'point-title-required', message: `points[${i}] 缺少 title` });
      }
      if (p.id !== undefined) {
        if (typeof p.id !== 'string' || !p.id.trim()) {
          errors.push({ code: 'point-id-invalid', message: `points[${i}].id 必须是字符串` });
        } else if (ids.has(p.id)) {
          errors.push({ code: 'point-id-duplicate', message: `points[${i}].id "${p.id}" 重复` });
        } else {
          ids.add(p.id);
        }
      }
      if (p.text !== undefined && typeof p.text !== 'string') {
        errors.push({ code: 'point-text-invalid', message: `points[${i}].text 必须是字符串` });
      }
      if (p.url !== undefined && typeof p.url !== 'string') {
        errors.push({ code: 'point-url-invalid', message: `points[${i}].url 必须是字符串` });
      }
    });
  }

  // edges（可选）
  if (spec.edges !== undefined) {
    if (!Array.isArray(spec.edges)) {
      errors.push({ code: 'edges-invalid', message: 'edges 必须是数组' });
    } else {
      spec.edges.forEach((e, i) => {
        if (!e || typeof e !== 'object' || !e.from || !e.to) {
          errors.push({ code: 'edge-invalid', message: `edges[${i}] 缺少 from/to` });
          return;
        }
        if (ids.size > 0 && (!ids.has(e.from) || !ids.has(e.to))) {
          errors.push({ code: 'edge-unknown-point', message: `edges[${i}] 引用了不存在的 point id: ${e.from} / ${e.to}` });
        }
        if (e.strength !== undefined && (typeof e.strength !== 'number' || e.strength < 1 || e.strength > 100)) {
          errors.push({ code: 'edge-strength-invalid', message: `edges[${i}].strength 必须在 1-100` });
        }
      });
    }
  }

  // config（可选）
  if (spec.config !== undefined) {
    if (typeof spec.config !== 'object') {
      errors.push({ code: 'config-invalid', message: 'config 必须是对象' });
    } else {
      if (spec.config.theme && !['dark', 'light'].includes(spec.config.theme)) {
        errors.push({ code: 'config-theme-invalid', message: 'config.theme 仅支持 dark / light' });
      }
      if (spec.config.width !== undefined && (typeof spec.config.width !== 'number' || spec.config.width < 400)) {
        errors.push({ code: 'config-width-invalid', message: 'config.width 必须 ≥ 400' });
      }
      if (spec.config.height !== undefined && (typeof spec.config.height !== 'number' || spec.config.height < 300)) {
        errors.push({ code: 'config-height-invalid', message: 'config.height 必须 ≥ 300' });
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ==================== 布局预计算（Node 端，复用 knowlink-core） ====================
async function computeLayout(spec) {
  const core = await import(pathToFileURL(path.join(skillRoot, 'lib', 'knowlink-core.js')).href);

  const points = spec.points.map((p, i) => ({
    id: p.id || ('kp-' + i),
    title: p.title || '',
    text: p.text || p.title || '',
    url: p.url || '',
    source: p.source || '',
    page: p.page || 0
  }));

  const W = (spec.config && spec.config.width) || 1200;
  const H = (spec.config && spec.config.height) || 800;

  core.buildKnowlinkGraph(points, '');
  const state = core.getKnowlinkState();

  // 合并显式边
  const explicitEdges = (spec.edges || []).map(e => {
    const fromIdx = points.findIndex(p => p.id === e.from);
    const toIdx = points.findIndex(p => p.id === e.to);
    return { from: fromIdx, to: toIdx, strength: e.strength || 50, reason: e.reason || 'ai-inferred' };
  }).filter(e => e.from >= 0 && e.to >= 0);

  explicitEdges.forEach(ee => {
    const dup = state.graphEdges.some(e => (e.from === ee.from && e.to === ee.to) || (e.from === ee.to && e.to === ee.from));
    if (!dup) state.graphEdges.push({ id: ee.from + '-' + ee.to, from: ee.from, to: ee.to, strength: ee.strength, reason: ee.reason, narrative: '', visualStrength: ee.strength / 100, bidirectional: true });
  });

  // buildKnowlinkGraph 已自动调用 detectGalaxies，只需计算布局
  core.computeKnowlinkLayout(state.graphNodes, state.graphEdges, W, H);

  // 归一化坐标到 [0,1]（保持宽高比，中心在 0.5,0.5）
  // 浏览器端按实际 canvas 尺寸还原，适配任意屏幕
  const xs = state.graphNodes.map(nd => nd.x);
  const ys = state.graphNodes.map(nd => nd.y);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const cx = (xMin + xMax) / 2, cy = (yMin + yMax) / 2;
  const span = Math.max(xMax - xMin, yMax - yMin, 1);

  const layout = {
    nodes: state.graphNodes.map(nd => ({
      id: nd.stableId || nd.id,
      x: Math.round(((nd.x - cx) / span + 0.5) * 1000) / 1000,
      y: Math.round(((nd.y - cy) / span + 0.5) * 1000) / 1000,
      radius: nd.radius,
      color: nd.color,
      label: nd.label,
      fullText: nd.fullText,
      source: nd.source,
      url: nd.url,
      page: nd.page,
      knowlink: nd.knowlink
    })),
    galaxies: state.galaxies.map(g => ({
      id: g.id,
      name: g.name,
      centerX: Math.round(((g.centerX - cx) / span + 0.5) * 1000) / 1000,
      centerY: Math.round(((g.centerY - cy) / span + 0.5) * 1000) / 1000,
      color: g.color
    }))
  };

  return layout;
}

// ==================== 内联核心（自包含 HTML） ====================
// 把 utils.js + knowlink-core.js 转成普通脚本内联进 HTML，
// 避免 file:// 下 ES module 的 CORS 限制，实现真正自包含。
function inlineCore() {
  // utils.js：去掉 export 前缀
  let utils = fs.readFileSync(path.join(skillRoot, 'lib', 'utils.js'), 'utf8');
  utils = utils
    .replace(/export var /g, 'var ')
    .replace(/export function /g, 'function ');

  // knowlink-core.js：去掉 import 行 + export shim，挂到 window.KnowlinkCore
  let core = fs.readFileSync(path.join(skillRoot, 'lib', 'knowlink-core.js'), 'utf8');
  core = core.replace(/import \{ assignSourceColors, SOURCE_COLORS \} from '\.\/utils\.js';\n?/, '');
  // 从 export shim 处截断（字符串定位，比正则可靠），再追加内联 shim
  const shimIdx = core.indexOf('export {');
  if (shimIdx >= 0) core = core.substring(0, shimIdx);
  core += `// ====================================================================
//  Knowlink Page 内联导出 shim（由 knowlink-page render 注入）
// ====================================================================
window.KnowlinkCore = {
  buildKnowlinkGraph, detectGalaxies, computeKnowlinkLayout, runKnowlinkForceSimulation,
  addNodesToGraph, relaxNewNodes, findNodeAt, computeStrength, getEdgeNarrative,
  renderKnowlink, getKnowlinkTheme, setKnowlinkTheme, KNOWLINK_THEMES,
  getKnowlinkState: function () {
    return { graphNodes: graphNodes, graphEdges: graphEdges, galaxies: galaxies };
  }
};`;

  return { utils, core };
}

// ==================== 渲染 ====================
function renderHtml(spec, layout) {
  const template = fs.readFileSync(path.join(skillRoot, 'assets', 'template.html'), 'utf8');
  const locale = (spec.meta && spec.meta.locale) || 'zh-CN';
  const isEn = locale === 'en';

  const L = {
    searchPlaceholder: isEn ? 'Search stars...' : '搜索节点...',
    statsLoading: isEn ? 'Loading...' : '加载中...',
    crumbAll: isEn ? 'All' : '全部',
    legendStar: isEn ? 'Node' : '节点',
    legendOrbit: isEn ? 'Same source' : '同源',
    legendConstellation: isEn ? 'Related' : '关联',
    legendWormhole: isEn ? 'AI link' : 'AI 连线',
    zoomIn: isEn ? 'Zoom in' : '放大',
    zoomOut: isEn ? 'Zoom out' : '缩小',
    zoomReset: isEn ? 'Reset view' : '重置视图',
    traceSource: isEn ? '🔗 Trace source' : '🔗 追溯来源'
  };

  const data = {
    points: spec.points,
    edges: spec.edges || [],
    layout,
    config: spec.config || {}
  };

  const { utils, core } = inlineCore();

  let html = template
    .replace(/__TITLE__/g, escapeHtml(spec.meta.title))
    .replace(/__SUBTITLE__/g, spec.meta.subtitle ? escapeHtml(spec.meta.subtitle) : '')
    .replace(/__SEARCH_PLACEHOLDER__/g, L.searchPlaceholder)
    .replace(/__STATS_LOADING__/g, L.statsLoading)
    .replace(/__CRUMB_ALL__/g, L.crumbAll)
    .replace(/__LEGEND_STAR__/g, L.legendStar)
    .replace(/__LEGEND_ORBIT__/g, L.legendOrbit)
    .replace(/__LEGEND_CONSTELLATION__/g, L.legendConstellation)
    .replace(/__LEGEND_WORMHOLE__/g, L.legendWormhole)
    .replace(/__ZOOM_IN__/g, L.zoomIn)
    .replace(/__ZOOM_OUT__/g, L.zoomOut)
    .replace(/__ZOOM_RESET__/g, L.zoomReset)
    .replace(/__TRACE_SOURCE__/g, L.traceSource)
    .replace(/__KNOWLINK_DATA_JSON__/g, () => JSON.stringify(data))
    .replace(/__UTILS_INLINE__/g, () => utils)
    .replace(/__CORE_INLINE__/g, () => core);

  // 语言属性
  html = html.replace('<html lang="zh-CN">', `<html lang="${isEn ? 'en' : 'zh-CN'}">`);

  return html;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ==================== 命令分发 ====================
function usage() {
  return `Usage:
  knowlink-page validate <input.json> [--json]
  knowlink-page render   <input.json> [output.html] [--json]
  knowlink-page demo     [output-directory]
  knowlink-page doctor
`;
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === '--help' || cmd === '-h') {
    console.log(usage());
    return;
  }

  if (cmd === 'doctor') {
    console.log('knowlink-page doctor:');
    console.log('  skill root:', skillRoot);
    console.log('  template:', fs.existsSync(path.join(skillRoot, 'assets', 'template.html')) ? '✅' : '❌');
    console.log('  knowlink-core:', fs.existsSync(path.join(skillRoot, 'lib', 'knowlink-core.js')) ? '✅' : '❌');
    console.log('  utils:', fs.existsSync(path.join(skillRoot, 'lib', 'utils.js')) ? '✅' : '❌');
    console.log('  schema:', fs.existsSync(path.join(skillRoot, 'schemas', 'page.schema.json')) ? '✅' : '❌');
    return;
  }

  if (cmd === 'demo') {
    const outDir = args[1] || path.join(skillRoot, 'examples', 'out');
    const demoSpec = readJson(path.join(skillRoot, 'examples', 'demo.json'));
    const v = validateSpec(demoSpec);
    if (!v.valid) {
      fail('demo.json 校验失败:\n' + v.errors.map(e => '  - ' + e.message).join('\n'));
    }
    const layout = await computeLayout(demoSpec);
    const html = renderHtml(demoSpec, layout);
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, 'demo.html');
    fs.writeFileSync(outFile, html);
    console.log('✅ demo 已生成:', outFile);
    console.log('   spec sha256:', sha256(JSON.stringify(demoSpec)));
    console.log('   html sha256:', sha256(html));
    console.log('   html bytes:', Buffer.byteLength(html));
    return;
  }

  if (cmd === 'validate') {
    const input = args[1];
    if (!input) fail('validate 需要 <input.json>');
    const spec = readJson(input);
    const v = validateSpec(spec);
    if (args.includes('--json')) {
      console.log(JSON.stringify({ valid: v.valid, errors: v.errors, warnings: v.warnings }, null, 2));
    } else {
      if (v.valid) {
        console.log(`✅ 校验通过: ${spec.points.length} 个知识点, ${(spec.edges || []).length} 条显式边`);
        v.warnings.forEach(w => console.log('  ⚠️ ' + w.message));
      } else {
        console.log('❌ 校验失败:');
        v.errors.forEach(e => console.log('  - ' + e.message));
      }
    }
    process.exit(v.valid ? 0 : 1);
  }

  if (cmd === 'render') {
    const input = args[1];
    if (!input) fail('render 需要 <input.json>');
    const spec = readJson(input);
    const v = validateSpec(spec);
    if (!v.valid) {
      fail('❌ 校验失败:\n' + v.errors.map(e => '  - ' + e.message).join('\n'));
    }
    const output = args[2] || input.replace(/\.json$/i, '.html');
    const layout = await computeLayout(spec);
    const html = renderHtml(spec, layout);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, html);
    if (args.includes('--json')) {
      console.log(JSON.stringify({
        output,
        specSha256: sha256(JSON.stringify(spec)),
        htmlSha256: sha256(html),
        htmlBytes: Buffer.byteLength(html),
        nodes: layout.nodes.length,
        galaxies: layout.galaxies.length
      }, null, 2));
    } else {
      console.log('✅ 已生成:', output);
      console.log('   节点:', layout.nodes.length, '· 知识簇:', layout.galaxies.length);
      console.log('   HTML:', Buffer.byteLength(html), 'bytes');
    }
    return;
  }

  fail('未知命令: ' + cmd + '\n\n' + usage());
}

// 动态 import 需要 fileURLToPath
import { pathToFileURL } from 'node:url';

main().catch(e => {
  console.error('❌ 执行失败:', e.message);
  process.exit(1);
});