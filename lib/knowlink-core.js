// ====================================================================
//  Obsidian 知识星系 — 布局 + 渲染核心（移植自 Chrome 扩展 knowlink-view/）
//  将 knowlink-layout.js 与 knowlink-renderer.js 合并进同一模块作用域，
//  保持两者间 graphNodes / graphEdges / galaxies 的全局协作方式不变。
//  原实现代码零改动，仅在文件头导入共享工具、文件尾追加导出 shim。
// ====================================================================
import { assignSourceColors, SOURCE_COLORS } from './utils.js';

// ====================================================================
//  ESM 严格模式适配：原扩展在宽松模式下依赖隐式全局，
//  转为 ES 模块后需显式声明这些共享状态变量。
// ====================================================================
var graphNodes = [];
var graphEdges = [];
var knowlinkDustGeneratedFor = '';
var _animQueue = [];
var sourceColorMap = {};

// ====================================================================
//  KnowLink 知识星系 — 图计算与布局引擎 (knowlink-layout.js)
//  负责：图构建、星系检测、力模拟、布局计算、坐标系统
//  读取 graphNodes/graphEdges 全局变量，写入位置数据
//  由 knowlink-engine.js 和 knowlink-renderer.js 共享
// ====================================================================

// ---- 确定性随机（seeded RNG）----
// 修复: 用 mulberry32 + 字符串 hash 替代 Math.random()，保证相同输入产生相同布局
function hashString(str) {
  var h = 0;
  for (var i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}
function seededRandom(seed) {
  var t = seed >>> 0;
  return function () {
    t += 0x6D2B79F5;
    var r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- 常量：领域颜色光谱 ----
var DOMAIN_COLORS = [
  '#ef4444', // 红 — 人文社科
  '#3b82f6', // 蓝 — 科学技术
  '#10b981', // 绿 — 自然生态
  '#f59e0b', // 金 — 实用技巧
  '#8b5cf6', // 紫 — 抽象思想
  '#ec4899', // 粉 — 艺术创意
  '#06b6d4', // 青 — 数据逻辑
  '#f97316', // 橙 — 生活经验
];

// ---- 全局星系数据 ----
var galaxies = [];  // { id, name, centerX, centerY, color, armAngle, nodeIds }

// ---- 节点 ID 查找表（稳定字符串 ID → 数组下标） ----
var _nodeIdToIndex = {};

function resolveNodeIndex(edgeEndpoint) {
  if (typeof edgeEndpoint === 'number') return edgeEndpoint;
  if (typeof edgeEndpoint === 'string') {
    var idx = _nodeIdToIndex[edgeEndpoint];
    if (idx !== undefined) return idx;
    // 修复: 查不到时打警告，帮助排查稳定 ID 失效问题
    console.warn('[Knowlink] resolveNodeIndex: 未找到稳定 ID "' + edgeEndpoint + '" 对应的节点下标');
    return -1;
  }
  return -1;
}

// 工具函数 escapeHtml / assignSourceColors 已移至 utils.js 共享

function normalizeUrl(raw) {
  if (!raw) return '';
  try {
    var u = new URL(raw);
    var host = u.hostname.replace(/^www\./, '');
    var path = u.pathname.replace(/\/$/, '');
    return 'https://' + host + path;
  } catch (e) {
    return raw.trim().toLowerCase();
  }
}

// 截断文本为最多 N 个词的短标签
// 中英文混合：按空格、标点、中文字符边界分词
function truncateToWords(text, maxWords) {
  if (!text) return '';
  // 按空格和常见分隔符拆分
  var tokens = text.split(/[\s,;，。；、：:！!？?·•\|/\\\(\)\[\]{}<>]+/).filter(function(t) { return t.length > 0; });
  if (tokens.length <= maxWords) return text.trim();
  return tokens.slice(0, maxWords).join(' ') + '…';
}

function extractKeywords(text) {
  if (!text) return [];
  var cleaned = text.replace(/[，。！？、；：""''【】《》（）\n\r\t.,!?;:'"()\[\]{}]/g, ' ');
  var cn = cleaned.match(/[一-鿿]{2,}/g) || [];
  var en = (cleaned.match(/[a-zA-Z]{3,}/g) || []).map(function(w) { return w.toLowerCase(); });
  return cn.concat(en).filter(function(v, i, a) { return a.indexOf(v) === i; });
}

// assignSourceColors 已移至 utils.js 共享

function screenToWorld(sx, sy, vt) {
  return {
    x: (sx - vt.offsetX) / vt.scale,
    y: (sy - vt.offsetY) / vt.scale
  };
}

// ---- 图计算 ----

function computeStrength(a, b) {
  var urlA = normalizeUrl(a.url);
  var urlB = normalizeUrl(b.url);
  if (urlA && urlB && urlA === urlB) return { strength: 100, reason: 'same-source' };

  try {
    var ua = new URL(a.url), ub = new URL(b.url);
    if (ua.hostname === ub.hostname && urlA !== urlB) return { strength: 75, reason: 'same-domain' };
  } catch (_) {}

  var wa = extractKeywords(a.text), wb = extractKeywords(b.text);
  if (wa.length && wb.length) {
    var intersect = wa.filter(function(w) { return wb.includes(w); });
    var ratio = (2 * intersect.length) / (wa.length + wb.length);
    var s = Math.round(ratio * 60);
    // 提高关键词建边阈值：只保留强关联（≥15），避免弱关联导致全连接
    if (s >= 15) return { strength: s, reason: 'keyword-overlap' };
  }
  return { strength: 0, reason: 'none' };
}

function computeStrengthCached(urlNormA, urlNormB, kwA, kwB, rawUrlA, rawUrlB) {
  if (urlNormA && urlNormB && urlNormA === urlNormB) return { strength: 100, reason: 'same-source' };

  try {
    var ua = new URL(rawUrlA), ub = new URL(rawUrlB);
    if (ua.hostname === ub.hostname && urlNormA !== urlNormB) return { strength: 75, reason: 'same-domain' };
  } catch (_) {}

  if (kwA.length && kwB.length) {
    var intersect = kwA.filter(function(w) { return kwB.includes(w); });
    var ratio = (2 * intersect.length) / (kwA.length + kwB.length);
    var s = Math.round(ratio * 60);
    // 提高关键词建边阈值：只保留强关联（≥15），避免弱关联导致全连接
    if (s >= 15) return { strength: s, reason: 'keyword-overlap' };
  }
  return { strength: 0, reason: 'none' };
}

// ---- 边叙事文案（替代百分比） ----
function getEdgeNarrative(reason, strength) {
  switch (reason) {
    case 'same-source':   return '📖 来自同一篇文章';
    case 'same-domain':   return '🌐 来自同一网站';
    case 'keyword-overlap':
      if (strength >= 40) return '💡 主题高度相关';
      if (strength >= 20) return '🔗 共享部分关键词';
      return '📎 略有交集';
    case 'ai-inferred':   return '🤖 AI 发现的深层关联';
    default:              return '—';
  }
}

// ====================================================================
//  星系检测 — 基于连通分量的社区发现
// ====================================================================
function detectGalaxies(graphNodes, graphEdges) {
  var n = graphNodes.length;
  if (!n) { galaxies = []; return; }

  // 构建邻接表（只考虑强关联边）
  var adj = {};
  for (var i = 0; i < n; i++) adj[i] = [];
  graphEdges.forEach(function(e) {
    if (e.strength >= 15) { // 只考虑强度>=15的边做聚类
      adj[e.from].push(e.to);
      adj[e.to].push(e.from);
    }
  });

  // BFS 连通分量
  var visited = {};
  var components = [];
  for (var i = 0; i < n; i++) {
    if (visited[i]) continue;
    var comp = [];
    var queue = [i];
    visited[i] = true;
    while (queue.length) {
      var v = queue.shift();
      comp.push(v);
      (adj[v] || []).forEach(function(w) {
        if (!visited[w]) { visited[w] = true; queue.push(w); }
      });
    }
    components.push(comp);
  }

  // 孤立的单节点合并到最近的星系
  var singletons = components.filter(function(c) { return c.length === 1; });
  var clusters   = components.filter(function(c) { return c.length > 1; });

  // 给每个星系分配颜色
  galaxies = clusters.map(function(comp, gi) {
    var color = DOMAIN_COLORS[gi % DOMAIN_COLORS.length];
    return {
      id: 'knowlink-' + gi,
      name: '知识星系 ' + (gi + 1),
      color: color,
      armAngle: seededRandom(hashString('knowlink-' + gi))() * Math.PI * 2,
      nodeIds: comp
    };
  });

  // 单节点分配到最近星系（基于关键词/来源相似度）
  singletons.forEach(function(sc) {
    var nodeId = sc[0];
    var bestKnowlink = galaxies[0];
    var bestScore = -1;
    galaxies.forEach(function(gal) {
      var score = 0;
      gal.nodeIds.forEach(function(gid) {
        graphEdges.forEach(function(e) {
          if ((e.from === nodeId && e.to === gid) || (e.to === nodeId && e.from === gid)) {
            score += e.strength;
          }
        });
      });
      if (score > bestScore) { bestScore = score; bestKnowlink = gal; }
    });
    if (bestKnowlink && bestScore > 0) {
      bestKnowlink.nodeIds.push(nodeId);
    } else if (galaxies.length > 0) {
      galaxies[0].nodeIds.push(nodeId);
    }
  });

  // 命名星系
  galaxies.forEach(function(gal) {
    // 统计节点中最常见的关键词来确定星系名称
    var allText = gal.nodeIds.map(function(id) {
      return graphNodes[id].fullText || '';
    }).join(' ');
    var kws = extractKeywords(allText);
    if (kws.length > 0) {
      gal.name = kws.slice(0, 2).join('·');
    }
  });

  // 回写节点的 knowlink 字段
  galaxies.forEach(function(gal) {
    gal.nodeIds.forEach(function(id) {
      graphNodes[id].knowlink = gal.id;
    });
  });

  console.log('[Knowlink] 检测到 ' + galaxies.length + ' 个星系，共 ' + n + ' 个节点');
  galaxies.forEach(function(g) {
    console.log('[Knowlink]   ' + g.name + ': ' + g.nodeIds.length + ' 颗恒星');
  });
}

// ====================================================================
//  星系布局引擎 — 螺旋臂 + 行星轨道
// ====================================================================
function computeKnowlinkLayout(graphNodes, graphEdges, containerW, containerH) {
  var W = containerW || 800, H = containerH || 600;
  if (W < 10) W = 800; if (H < 10) H = 600;

  var n = graphNodes.length;
  if (!n) return;

  // 情形: 无星系 → 用默认圆形布局
  if (!galaxies.length) {
    var cx = W / 2, cy = H / 2, R = Math.min(W, H) * 0.3;
    graphNodes.forEach(function(nd, i) {
      var a = (2 * Math.PI * i) / n - Math.PI / 2;
      nd.x = cx + R * Math.cos(a);
      nd.y = cy + R * Math.sin(a);
    });
    return;
  }

  // 每个星系分配一个中心位置
  var padding = 220;
  var galCount = galaxies.length;
  var cols = Math.ceil(Math.sqrt(galCount));
  var rows = Math.ceil(galCount / cols);
  var cellW = (W - padding * 2) / cols;
  var cellH = (H - padding * 2) / rows;

  galaxies.forEach(function(gal, gi) {
    var col = gi % cols, row = Math.floor(gi / cols);
    var cx = padding + cellW * (col + 0.5);
    var cy = padding + cellH * (row + 0.5);
    // 向画布中心压缩 50%，缩短星系间距离（左右星系更靠近）
    gal.centerX = W / 2 + (cx - W / 2) * 0.5;
    gal.centerY = H / 2 + (cy - H / 2) * 0.5;
  });

  // 在每个星系内部用螺旋臂排列节点
  galaxies.forEach(function(gal) {
    var ids = gal.nodeIds.slice(); // 修复: 复制后再排序，避免修改 gal.nodeIds
    if (!ids.length) return;
    var cx = gal.centerX, cy = gal.centerY;

    // 按节点重要性（边数）排序，核心节点靠近中心
    var deg = {};
    graphEdges.forEach(function(e) {
      deg[e.from] = (deg[e.from] || 0) + 1;
      deg[e.to]   = (deg[e.to]   || 0) + 1;
    });
    ids.sort(function(a, b) { return (deg[b] || 0) - (deg[a] || 0); });

    var armCount = Math.max(2, Math.min(4, Math.ceil(ids.length / 6)));
    var maxR = Math.min(cellW, cellH) * 0.28;  // 减小 maxR，星系更紧凑

    ids.forEach(function(nodeId, i) {
      var nd = graphNodes[nodeId];
      if (!nd) return;

      // 对数螺线: r = a * e^(b*theta)
      var armIndex = i % armCount;
      var armAngle = gal.armAngle + (armIndex / armCount) * Math.PI * 2;
      var t = Math.floor(i / armCount) / (Math.ceil(ids.length / armCount) || 1);
      var r = t * maxR + 40;
      var angle = armAngle + t * 2.5; // 螺线旋转

      nd.x = cx + r * Math.cos(angle);
      nd.y = cy + r * Math.sin(angle);

      // 核心节点更大（缩小：与文字大小接近）
      var importance = (deg[nodeId] || 0) + 1;
      nd.radius = 3 + Math.min(importance * 1.0, 6) + Math.min(nd.fullText.length * 0.04, 2);
      nd.importance = importance;
    });
  });

  // 同源节点的行星轨道偏移
  var sourceGroups = {};
  graphNodes.forEach(function(nd) {
    if (!nd.url) return;
    var key = normalizeUrl(nd.url);
    if (!sourceGroups[key]) sourceGroups[key] = [];
    sourceGroups[key].push(nd.id);
  });

  Object.keys(sourceGroups).forEach(function(key) {
    var group = sourceGroups[key];
    if (group.length < 2) return;
    var parent = group[0];
    var px = graphNodes[parent].x, py = graphNodes[parent].y;
    for (var s = 1; s < group.length; s++) {
      var child = graphNodes[group[s]];
      var orbitR = 30 + s * 22;
      var orbitA = (s / group.length) * Math.PI * 2 + seededRandom(hashString('orbit-' + parent))() * 0.5;
      child.x = px + orbitR * Math.cos(orbitA);
      child.y = py + orbitR * Math.sin(orbitA);
      child.orbitParent = parent;
      child.orbitRadius  = orbitR;
      child.orbitAngle   = orbitA;
    }
  });

  // 运行力导向松弛迭代
  runKnowlinkForceSimulation(graphNodes, graphEdges, W, H);
}

function runKnowlinkForceSimulation(graphNodes, graphEdges, W, H) {
  var n = graphNodes.length;
  if (!n) return;
  var ITER = 40, DAMP = 0.8;

  for (var iter = 0; iter < ITER; iter++) {
    var forces = graphNodes.map(function() { return { fx: 0, fy: 0 }; });

    // 排斥力
    for (var i = 0; i < n; i++) {
      for (var j = i + 1; j < n; j++) {
        var dx = graphNodes[j].x - graphNodes[i].x;
        var dy = graphNodes[j].y - graphNodes[i].y;
        var d  = Math.sqrt(dx*dx + dy*dy) || 1;
        if (d < 1) d = 1;
        var f  = 2000 / (d * d);
        var ffx = (dx / d) * f, ffy = (dy / d) * f;
        forces[i].fx -= ffx; forces[i].fy -= ffy;
        forces[j].fx += ffx; forces[j].fy += ffy;
      }
    }

    // 边引力 (弹簧)
    graphEdges.forEach(function(e) {
      var from = graphNodes[e.from], to = graphNodes[e.to];
      if (!from || !to) return;
      var dx = to.x - from.x, dy = to.y - from.y;
      var d  = Math.sqrt(dx*dx + dy*dy) || 1;
      // 越相关越近：strength 越高理想距离越短（同源 100→50px，弱关联→104px）
      var ideal = 140 - e.strength * 0.9;
      // 同源边（strength 100）加强弹簧系数，保证同源节点紧密聚集
      var k = e.strength >= 100 ? 0.012 : 0.004;
      var f = (d - ideal) * k;
      var ffx = (dx / d) * f, ffy = (dy / d) * f;
      forces[e.from].fx += ffx; forces[e.from].fy += ffy;
      forces[e.to  ].fx -= ffx; forces[e.to  ].fy -= ffy;
    });

    // 星系中心引力 + 星系间排斥
    graphNodes.forEach(function(nd, i) {
      // 拉向所属星系中心
      if (nd.knowlink) {
        var gal = galaxies.find(function(g) { return g.id === nd.knowlink; });
        if (gal) {
          forces[i].fx += (gal.centerX - nd.x) * 0.003;
          forces[i].fy += (gal.centerY - nd.y) * 0.003;
        }
      }
      // 星系间排斥：其他星系中心推开本星系节点（减弱，配合中心压缩）
      galaxies.forEach(function(other) {
        if (other.id === nd.knowlink) return;
        var dx = nd.x - other.centerX, dy = nd.y - other.centerY;
        var d = Math.sqrt(dx*dx + dy*dy) || 1;
        var f = 400 / (d * d);  // 星系间排斥力（减弱）
        forces[i].fx += (dx / d) * f;
        forces[i].fy += (dy / d) * f;
      });
      // 全局中心引力（把星系拉向中间）
      forces[i].fx += (W/2 - nd.x) * 0.0005;
      forces[i].fy += (H/2 - nd.y) * 0.0005;

      nd.x += forces[i].fx * DAMP;
      nd.y += forces[i].fy * DAMP;
    });
  }
}

// ====================================================================
//  增量图更新（Phase 4a）
// ====================================================================

// 向已有图谱中增量添加节点
// 返回新节点的数组下标列表
function addNodesToGraph(newPoints, containerW, containerH) {
  var W = containerW || 800, H = containerH || 600;
  if (W < 10) W = 800; if (H < 10) H = 600;

  var newCount = newPoints.length;
  if (!newCount) return [];

  var existingCount = graphNodes.length;
  var newIndices = [];
  var keywordCache = [];
  var urlCache = [];

  // 预计算所有节点的关键词和URL缓存（增量版）
  // 移植说明：原扩展此处引用页面全局 knowledgePoints，模块化后改为 graphNodes
  for (var i = 0; i < existingCount; i++) {
    var ept = graphNodes[i] || {};
    keywordCache[i] = extractKeywords(ept.fullText || '');
    urlCache[i] = normalizeUrl(ept.url || '');
  }

  // 创建新节点
  for (var j = 0; j < newCount; j++) {
    var p = newPoints[j];
    var title = p.title || '';
    var txt = p.text || title || '';
    var rawLabel = title || txt;
    var label = truncateToWords(rawLabel, 5);
    var idx = existingCount + j;
    var sid = p.id || ('_idx_' + idx);
    _nodeIdToIndex[sid] = idx;

    graphNodes.push({
      id: idx,
      stableId: sid,
      label:    label,
      fullText: txt,
      source:   p.source || '',
      url:      p.url || '',
      page:     p.page || 0,
      color:    sourceColorMap[p.url] || SOURCE_COLORS[idx % SOURCE_COLORS.length],
      x: 0, y: 0,
      radius: 3 + Math.min(label.length * 0.3, 4),
      matchesFilter: true,
      knowlink: null,
      importance: 1,
      orbitParent: null,
      orbitRadius: 0,
      orbitAngle: 0,
      glowPhase: seededRandom(hashString('glow-' + sid))() * Math.PI * 2
    });

    // 缓存新节点的关键词和URL
    keywordCache[idx] = extractKeywords(txt);
    urlCache[idx] = normalizeUrl(p.url || '');

    newIndices.push(idx);
  }

  // 增量计算边：只计算 newPoints × allPoints
  // 已有节点间边保持不变
  var newEdges = [];
  for (var ni = 0; ni < newCount; ni++) {
    var newIdx = existingCount + ni;
    var newPt = newPoints[ni];

    // 新节点与已有节点的边
    for (var ei = 0; ei < existingCount; ei++) {
      var result = computeStrengthCached(
        urlCache[newIdx], urlCache[ei],
        keywordCache[newIdx], keywordCache[ei],
        newPt.url || '', graphNodes[ei].url || ''
      );
      if (result.strength > 0) {
        newEdges.push({
          id: newIdx + '-' + ei, from: newIdx, to: ei,
          strength: result.strength,
          reason: result.reason,
          narrative: getEdgeNarrative(result.reason, result.strength),
          visualStrength: result.strength / 100,
          bidirectional: true
        });
      }
    }

    // 新节点之间的边
    for (var nj = ni + 1; nj < newCount; nj++) {
      var otherIdx = existingCount + nj;
      var otherPt = newPoints[nj];
      var result2 = computeStrengthCached(
        urlCache[newIdx], urlCache[otherIdx],
        keywordCache[newIdx], keywordCache[otherIdx],
        newPt.url || '', otherPt.url || ''
      );
      if (result2.strength > 0) {
        newEdges.push({
          id: newIdx + '-' + otherIdx, from: newIdx, to: otherIdx,
          strength: result2.strength,
          reason: result2.reason,
          narrative: getEdgeNarrative(result2.reason, result2.strength),
          visualStrength: result2.strength / 100,
          bidirectional: true
        });
      }
    }
  }

  // 合并边到 graphEdges（去重）
  var existingKeys = {};
  graphEdges.forEach(function(e) { existingKeys[e.from + '-' + e.to] = true; });
  newEdges.forEach(function(e) {
    var key = e.from + '-' + e.to;
    if (!existingKeys[key]) {
      graphEdges.push(e);
      existingKeys[key] = true;
    }
  });

  // 放置新节点：靠近其最强连接的已有节点
  newIndices.forEach(function(newIdx) {
    var bestEdge = null;
    // 找到新节点与已有节点的最强边
    for (var k = 0; k < graphEdges.length; k++) {
      var edge = graphEdges[k];
      if ((edge.from === newIdx && edge.to < existingCount) ||
          (edge.to === newIdx && edge.from < existingCount)) {
        if (!bestEdge || edge.strength > bestEdge.strength) bestEdge = edge;
      }
    }
    var nd = graphNodes[newIdx];
    if (bestEdge) {
      var neighborIdx = bestEdge.from === newIdx ? bestEdge.to : bestEdge.from;
      var neighbor = graphNodes[neighborIdx];
      // 放置在邻居附近（确定性随机偏移）
      var rnd = seededRandom(hashString('new-' + newIdx));
      var angle = rnd() * Math.PI * 2;
      var dist = 80 + rnd() * 120;
      nd.x = neighbor.x + Math.cos(angle) * dist;
      nd.y = neighbor.y + Math.sin(angle) * dist;
    } else {
      // 无连接则放置在视图中心附近（确定性随机偏移）
      var rndFree = seededRandom(hashString('new-free-' + newIdx));
      nd.x = W / 2 + (rndFree() - 0.5) * 200;
      nd.y = H / 2 + (rndFree() - 0.5) * 200;
    }
  });

  console.log('[Knowlink] 增量添加: +' + newCount + ' 节点, +' + newEdges.length + ' 条边 (总计 ' + graphNodes.length + ' 节点, ' + graphEdges.length + ' 边)');

  return newIndices;
}

// ====================================================================
//  增量力模拟（Phase 4b）
// ====================================================================

// 仅对新节点及其一度邻居运行轻量力模拟
// 其他已有节点位置锁定（冻结）
function relaxNewNodes(newNodeIndices, iterations) {
  var ITER = iterations || 6;
  var DAMP = 0.65;
  var n = graphNodes.length;
  if (!n) return;

  // 确定参与节点：新节点 + 一度邻居
  var participating = {};
  newNodeIndices.forEach(function(i) { participating[i] = true; });

  // 找一度邻居（与任何新节点有边连接的已有节点）
  graphEdges.forEach(function(e) {
    if (participating[e.from] && e.to < n) participating[e.to] = true;
    if (participating[e.to] && e.from < n) participating[e.from] = true;
  });

  var partList = Object.keys(participating).map(Number);
  if (partList.length < 2) return;

  // 轻量力模拟
  for (var iter = 0; iter < ITER; iter++) {
    var forces = {};
    partList.forEach(function(i) { forces[i] = { fx: 0, fy: 0 }; });

    // 排斥力（仅在参与节点之间）
    for (var a = 0; a < partList.length; a++) {
      for (var b = a + 1; b < partList.length; b++) {
        var i = partList[a], j = partList[b];
        var dx = graphNodes[j].x - graphNodes[i].x;
        var dy = graphNodes[j].y - graphNodes[i].y;
        var d  = Math.sqrt(dx*dx + dy*dy) || 1;
        if (d < 1) d = 1;
        var f  = 2000 / (d * d);
        var ffx = (dx / d) * f, ffy = (dy / d) * f;
        forces[i].fx -= ffx; forces[i].fy -= ffy;
        forces[j].fx += ffx; forces[j].fy += ffy;
      }
    }

    // 边引力（仅涉及参与节点的边）
    graphEdges.forEach(function(e) {
      if (!participating[e.from] && !participating[e.to]) return;
      var from = graphNodes[e.from], to = graphNodes[e.to];
      if (!from || !to) return;
      var dx = to.x - from.x, dy = to.y - from.y;
      var d  = Math.sqrt(dx*dx + dy*dy) || 1;
      // 越相关越近：strength 越高理想距离越短（同源 100→50px，弱关联→104px）
      var ideal = 140 - e.strength * 0.9;
      // 同源边（strength 100）加强弹簧系数，保证同源节点紧密聚集
      var k = e.strength >= 100 ? 0.012 : 0.004;
      var f = (d - ideal) * k;
      var ffx = (dx / d) * f, ffy = (dy / d) * f;
      if (forces[e.from]) { forces[e.from].fx += ffx; forces[e.from].fy += ffy; }
      if (forces[e.to])   { forces[e.to].fx -= ffx; forces[e.to].fy -= ffy; }
    });

    // 星系中心引力（仅对参与节点）
    partList.forEach(function(i) {
      var nd = graphNodes[i];
      if (nd.knowlink) {
        var gal = galaxies.find(function(g) { return g.id === nd.knowlink; });
        // 移植修复：detectGalaxies 重建星系对象后 centerX/centerY 尚未计算
        // （仅 computeKnowlinkLayout 会写入），未计算时跳过中心引力，避免 NaN
        if (gal && typeof gal.centerX === 'number' && typeof gal.centerY === 'number') {
          forces[i].fx += (gal.centerX - nd.x) * 0.003;
          forces[i].fy += (gal.centerY - nd.y) * 0.003;
        }
      }
      nd.x += forces[i].fx * DAMP;
      nd.y += forces[i].fy * DAMP;
    });
  }

  console.log('[Knowlink] 增量力模拟完成: ' + partList.length + ' 个参与节点, ' + ITER + ' 次迭代');
}

// ====================================================================
//  图构建
// ====================================================================
function buildKnowlinkGraph(knowledgePoints, filterText) {
  var n = knowledgePoints.length;
  if (!n) { graphNodes = []; graphEdges = []; return; }

  var sourceColorMap = {};
  assignSourceColors(knowledgePoints, sourceColorMap);

  var keywordCache = knowledgePoints.map(function(p) { return extractKeywords(p.text); });
  var urlCache     = knowledgePoints.map(function(p) { return normalizeUrl(p.url); });

  graphNodes = knowledgePoints.map(function(p, i) {
    var title = p.title || '';
    var txt = p.text || '';
    // 优先使用 AI 提取的短标题（概念级），降级使用全文
    var rawLabel = title || txt;
    // 限制为 ~5 个词的简洁概念标签
    var label = truncateToWords(rawLabel, 5);
    // 注册稳定 ID → 数组下标映射
    var sid = p.id || ('_idx_' + i);
    _nodeIdToIndex[sid] = i;
    return {
      id: i,
      stableId: sid,
      label:    label,
      fullText: txt,
      source:   p.source || '',
      url:      p.url || '',
      // 存储页码（用于 PDF 跳转定位）
      page:     p.page || 0,
      color:    sourceColorMap[p.url] || SOURCE_COLORS[i % SOURCE_COLORS.length],
      x: 0, y: 0,
      radius: 3 + Math.min(label.length * 0.3, 4),
      matchesFilter: true,
      knowlink: null,
      importance: 1,
      orbitParent: null,
      orbitRadius: 0,
      orbitAngle: 0,
      glowPhase: seededRandom(hashString('glow-' + sid))() * Math.PI * 2
    };
  });

  graphEdges = [];
  var ft = filterText ? filterText.toLowerCase().trim() : '';

  // 每节点最大边数限制（避免 hub 节点连接一切导致全连接）
  var MAX_EDGES_PER_NODE = 6;
  var edgeCount = {};  // 每个节点的当前边数

  for (var i = 0; i < n; i++) {
    if (ft) {
      var p = knowledgePoints[i];
      graphNodes[i].matchesFilter = (p.text || '').toLowerCase().includes(ft) ||
                                     (p.source || '').toLowerCase().includes(ft) ||
                                     (p.url || '').toLowerCase().includes(ft);
    } else {
      graphNodes[i].matchesFilter = true;
    }

    for (var j = i + 1; j < n; j++) {
      var result = computeStrengthCached(
        urlCache[i], urlCache[j],
        keywordCache[i], keywordCache[j],
        knowledgePoints[i].url, knowledgePoints[j].url
      );
      if (result.strength > 0) {
        // 每节点边数上限：超过则跳过（保留强关联，避免全连接）
        if ((edgeCount[i] || 0) >= MAX_EDGES_PER_NODE || (edgeCount[j] || 0) >= MAX_EDGES_PER_NODE) continue;
        edgeCount[i] = (edgeCount[i] || 0) + 1;
        edgeCount[j] = (edgeCount[j] || 0) + 1;
        graphEdges.push({
          id: i + '-' + j, from: i, to: j,
          strength: result.strength,
          reason: result.reason,
          narrative: getEdgeNarrative(result.reason, result.strength),
          visualStrength: result.strength / 100,
          bidirectional: true
        });
      }
    }
  }

  console.log('[Knowlink] 构建图: ' + n + ' 节点, ' + graphEdges.length + ' 条边');

  // 自动检测星系
  detectGalaxies(graphNodes, graphEdges);
}

// ====================================================================
//  交互 — hover / 坐标检测
// ====================================================================
function findNodeAt(mx, my, vt) {
  var world = screenToWorld(mx, my, vt);
  for (var i = graphNodes.length - 1; i >= 0; i--) {
    var nd = graphNodes[i];
    var hitR = nd.radius + 6;
    if (Math.hypot(world.x - nd.x, world.y - nd.y) < hitR) {
      return i;
    }
  }
  return null;
}

// ====================================================================
//  KnowLink 知识星系 — Canvas 2D 渲染管线 (knowlink-renderer.js)
//  负责：星场背景、星云光晕、星系微尘、轨道环、边渲染、
//        节点渲染、入场动画、主渲染循环
//  读取 graphNodes/graphEdges/galaxies 全局变量（由 knowlink-layout.js 写入）
// ====================================================================

// ====================================================================
//  主题系统
// ====================================================================
var KNOWLINK_THEMES = {
  // Obsidian 纯色简洁风格（默认）
  obsidian: {
    name: 'Obsidian 简洁',
    background: '#f2f0ec',          // 柔和暖灰白（Obsidian 风格，低明度不刺眼）
    backgroundGrad: '#ece9e4',      // 微渐变底色
    showStarfield: false,
    showNebulae: false,
    showDust: false,
    nodeFill: 'rgba(0,0,0,0.08)',
    nodeColor: '#666666',              // Obsidian 关系图谱：灰色圆点（点击后变黑）
    nodeColorActive: '#000000',        // 聚焦/选中时黑色
    nodeBorder: 'rgba(0,0,0,0)',       // obsidian 无边框
    nodeBorderHover: '#000000',
    labelColor: '#333333',
    labelHover: '#000000',
    labelShadow: 'rgba(255,255,255,0.9)',  // 白底用白阴影（避免模糊）
    edgeKeyword: 'rgba(0,0,0,0.15)',
    edgeKeywordHover: 'rgba(0,0,0,0.5)',
    edgeSameSource: 'rgba(245,158,11,0.6)',
    edgeSameSourceHover: 'rgba(245,158,11,0.9)',
    edgeSameDomain: 'rgba(59,130,246,0.5)',
    edgeSameDomainHover: 'rgba(59,130,246,0.8)',
    edgeAI: 'rgba(139,92,246,0.5)',
    edgeAIHover: 'rgba(139,92,246,0.9)',
    emptyText: '#999999',
    focusRing: 'rgba(0,0,0,0.15)',
    selectedRing: 'rgba(245,158,11,0.6)',
    glowColor: 'rgba(0,0,0,0.2)'
  },
  // 深空星系风格（可选）
  space: {
    name: '深空星系',
    background: '#060610',
    backgroundGrad: '#0d0d28',
    showStarfield: true,
    showNebulae: true,
    showDust: true,
    nodeFill: 'rgba(255,255,255,0.75)',
    nodeColor: null,                    // space 用彩色渐变
    nodeBorder: 'rgba(255,255,255,0.25)',
    nodeBorderHover: '#ffffff',
    labelColor: 'rgba(255,255,255,0.92)',
    labelHover: '#ffffff',
    labelShadow: 'rgba(0,0,0,0.9)',     // 深空用黑阴影
    edgeKeyword: 'rgba(180,190,210,0.25)',
    edgeKeywordHover: 'rgba(200,210,230,0.7)',
    edgeSameSource: 'rgba(245,158,11,0.4)',
    edgeSameSourceHover: 'rgba(245,158,11,0.85)',
    edgeSameDomain: 'rgba(59,130,246,0.35)',
    edgeSameDomainHover: 'rgba(59,130,246,0.8)',
    edgeAI: 'rgba(139,92,246,0.45)',
    edgeAIHover: 'rgba(139,92,246,0.9)',
    emptyText: '#9ca3af',
    focusRing: 'rgba(255,255,255,0.3)',
    selectedRing: 'rgba(245,158,11,0.5)',
    glowColor: 'rgba(255,255,255,0.18)'
  }
};

// 当前主题（默认 obsidian）
var _knowlinkTheme = 'obsidian';

function getKnowlinkTheme() {
  return _knowlinkTheme;
}

function setKnowlinkTheme(name) {
  if (KNOWLINK_THEMES[name]) _knowlinkTheme = name;
  return _knowlinkTheme;
}

function theme() {
  return KNOWLINK_THEMES[_knowlinkTheme] || KNOWLINK_THEMES.obsidian;
}

// ---- 深空背景色（space 主题用） ----
var SPACE_BG        = '#060610';
var SPACE_BG_GRAD   = '#0d0d28';
var NEBULA_COLORS   = ['rgba(59,130,246,0.05)', 'rgba(139,92,246,0.05)', 'rgba(99,102,241,0.04)', 'rgba(236,72,153,0.03)'];

// ====================================================================
//  深空背景粒子系统
// ====================================================================
var starParticles = [];

// 星体颜色光谱 (用于背景星的不同色温)
var STAR_SPECTRUM = [
  'rgba(255,255,255,__A__)',      // 纯白
  'rgba(200,215,255,__A__)',     // 蓝白
  'rgba(255,245,220,__A__)',     // 暖黄
  'rgba(180,200,255,__A__)',     // 淡蓝
  'rgba(255,220,200,__A__)',     // 暖橙
];

function initStarParticles(W, H) {
  starParticles = [];
  var count = Math.floor((W * H) / 1000); // 增加密度
  if (count < 120) count = 120;
  if (count > 800) count = 800; // 提高上限，避免大屏星星太少
  // 大幅扩大生成区域：覆盖视口 16 倍范围 (世界坐标 -6W~10W, -6H~10H)
  // 确保在最小缩放级别 (0.15x) 时仍有充足星星覆盖整个可见区域
  var areaW = W * 16;
  var areaH = H * 16;
  var offsetX = -W * 6;
  var offsetY = -H * 6;
  for (var i = 0; i < count; i++) {
    var colorIdx = Math.floor(Math.random() * STAR_SPECTRUM.length);
    starParticles.push({
      x: Math.random() * areaW + offsetX,
      y: Math.random() * areaH + offsetY,
      r: Math.random() * 1.8 + 0.2,
      twinkle: Math.random() * Math.PI * 2,
      speed: Math.random() * 0.025 + 0.003,
      alpha: Math.random() * 0.5 + 0.25,
      colorIdx: colorIdx,
      // 稀疏的十字星芒 (亮度高的星星有)
      hasCross: Math.random() < 0.08
    });
  }
}

function renderStarfield(ctx, vt, W, H, time) {
  var T = theme();

  // 背景：obsidian 纯色 / space 深空渐变
  if (!T.showStarfield) {
    ctx.fillStyle = T.background;
    ctx.fillRect(-vt.offsetX / vt.scale, -vt.offsetY / vt.scale, W / vt.scale, H / vt.scale);
    return;
  }

  // 深空背景渐变 — 使用视口中心的世界坐标，避免缩放/平移时的拖影
  var worldCX = (W/2 - vt.offsetX) / vt.scale;
  var worldCY = (H/2 - vt.offsetY) / vt.scale;
  var gradR = Math.max(W, H) * 0.9 / vt.scale;
  var grad = ctx.createRadialGradient(worldCX, worldCY, 0, worldCX, worldCY, Math.max(gradR, 100));
  grad.addColorStop(0, '#0d0d2b');
  grad.addColorStop(0.4, '#08081f');
  grad.addColorStop(0.7, '#050514');
  grad.addColorStop(1, '#020208');
  ctx.fillStyle = grad;
  ctx.fillRect(-vt.offsetX / vt.scale, -vt.offsetY / vt.scale, W / vt.scale, H / vt.scale);

  // 星场粒子
  starParticles.forEach(function(s) {
    s.twinkle += s.speed;
    var twinkleVal = Math.sin(s.twinkle);
    var alpha = s.alpha + twinkleVal * 0.35;
    alpha = Math.max(0.08, Math.min(0.95, alpha));

    // 使用色温光谱
    var baseColor = STAR_SPECTRUM[s.colorIdx];
    var color = baseColor.replace('__A__', alpha.toFixed(3));

    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    // 亮星加辉光
    if (s.r > 1.0) {
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r * 3.5, 0, Math.PI * 2);
      ctx.fillStyle = baseColor.replace('__A__', (alpha * 0.12).toFixed(4));
      ctx.fill();
    }

    // 十字星芒效果 (最亮的星星)
    if (s.hasCross && s.r > 1.2 && alpha > 0.7) {
      var crossAlpha = alpha * 0.25;
      ctx.strokeStyle = baseColor.replace('__A__', crossAlpha.toFixed(4));
      ctx.lineWidth = 0.4;
      ctx.beginPath();
      ctx.moveTo(s.x - s.r * 5, s.y);
      ctx.lineTo(s.x + s.r * 5, s.y);
      ctx.moveTo(s.x, s.y - s.r * 5);
      ctx.lineTo(s.x, s.y + s.r * 5);
      ctx.stroke();
    }
  });
}

// ---- 辅助: hex 转 rgba ----
function hexToRgba(hex, alpha) {
  if (!hex || !hex.startsWith('#')) return 'rgba(139,92,246,' + alpha + ')';
  var r = parseInt(hex.slice(1,3), 16);
  var g = parseInt(hex.slice(3,5), 16);
  var b = parseInt(hex.slice(5,7), 16);
  return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
}

// ---- 辅助: hex 颜色变亮/变暗（percent: -1 到 1，负变暗正变亮） ----
function shadeColor(hex, percent) {
  if (!hex || hex[0] !== '#') return hex;
  var r = parseInt(hex.slice(1,3), 16);
  var g = parseInt(hex.slice(3,5), 16);
  var b = parseInt(hex.slice(5,7), 16);
  var t = percent < 0 ? 0 : 255;
  var p = Math.abs(percent);
  r = Math.round((t - r) * p + r);
  g = Math.round((t - g) * p + g);
  b = Math.round((t - b) * p + b);
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}

// ---- 星云渲染 ----
function renderNebulae(ctx, vt) {
  if (!theme().showNebulae) return;
  // 在每个星系中心渲染多层柔和光晕
  galaxies.forEach(function(gal) {
    if (!gal.nodeIds || gal.nodeIds.length < 3) return;
    var cx = gal.centerX, cy = gal.centerY;

    // 外层大范围柔光
    var outerGrad = ctx.createRadialGradient(cx, cy, 50, cx, cy, 280);
    outerGrad.addColorStop(0, hexToRgba(gal.color, 0.05));
    outerGrad.addColorStop(0.4, hexToRgba(gal.color, 0.02));
    outerGrad.addColorStop(1, 'transparent');
    ctx.fillStyle = outerGrad;
    ctx.beginPath();
    ctx.arc(cx, cy, 280, 0, Math.PI * 2);
    ctx.fill();

    // 内层核心柔光
    var innerGrad = ctx.createRadialGradient(cx, cy, 15, cx, cy, 100);
    innerGrad.addColorStop(0, hexToRgba(gal.color, 0.1));
    innerGrad.addColorStop(0.5, hexToRgba(gal.color, 0.04));
    innerGrad.addColorStop(1, 'transparent');
    ctx.fillStyle = innerGrad;
    ctx.beginPath();
    ctx.arc(cx, cy, 100, 0, Math.PI * 2);
    ctx.fill();
  });
}

// ---- 星系中心微尘 ----
var knowlinkDustParticles = [];
var knowlinkDustGeneratedFor = ''; // 跟踪是为哪些星系生成的

function initKnowlinkDust() {
  knowlinkDustParticles = [];
  knowlinkDustGeneratedFor = galaxies.map(function(g) { return g.id + ':' + g.nodeIds.length; }).join(',');
  galaxies.forEach(function(gal) {
    var count = Math.min((gal.nodeIds || []).length * 6, 50);
    for (var i = 0; i < count; i++) {
      var angle = Math.random() * Math.PI * 2;
      var dist = 30 + Math.random() * 180;
      knowlinkDustParticles.push({
        gx: gal.centerX + Math.cos(angle) * dist,
        gy: gal.centerY + Math.sin(angle) * dist,
        r: Math.random() * 0.8 + 0.2,
        alpha: Math.random() * 0.3 + 0.05,
        speed: Math.random() * 0.003 + 0.001,
        phase: Math.random() * Math.PI * 2,
        orbitCenterX: gal.centerX,
        orbitCenterY: gal.centerY,
        orbitDist: dist,
        orbitAngle: angle,
        color: gal.color
      });
    }
  });
}

function renderKnowlinkDust(ctx, vt, time) {
  if (!theme().showDust) return;
  // 检查是否需要重新生成
  var currentSig = galaxies.map(function(g) { return g.id + ':' + g.nodeIds.length; }).join(',');
  if (knowlinkDustGeneratedFor !== currentSig) {
    initKnowlinkDust();
  }

  if (!knowlinkDustParticles.length) return;
  knowlinkDustParticles.forEach(function(d) {
    d.phase += d.speed;
    d.alpha += Math.sin(d.phase) * 0.04;
    d.alpha = Math.max(0.03, Math.min(0.35, d.alpha));

    var colorStr = hexToRgba(d.color, d.alpha);

    ctx.beginPath();
    ctx.arc(d.gx, d.gy, d.r, 0, Math.PI * 2);
    ctx.fillStyle = colorStr;
    ctx.fill();
  });
}

// ---- 边渲染 ----
function renderKnowlinkEdges(ctx, vt, allEdges, hoveredNode, focusedNode, filterText, time) {
  var ft = filterText ? filterText.toLowerCase().trim() : '';

  allEdges.forEach(function(e) {
    var fromIdx = resolveNodeIndex(e.from);
    var toIdx   = resolveNodeIndex(e.to);
    var from = graphNodes[fromIdx], to = graphNodes[toIdx];
    if (!from || !to) return;

    // 聚焦模式：淡化不相关边
    var hl = false;
    if (focusedNode !== null && focusedNode !== undefined) {
      hl = (focusedNode === fromIdx || focusedNode === toIdx);
    } else if (hoveredNode !== null && hoveredNode !== undefined) {
      hl = (hoveredNode === fromIdx || hoveredNode === toIdx);
    }

    var alpha = 0.35;
    if (focusedNode !== null && focusedNode !== undefined) {
      alpha = hl ? 0.8 : 0.04;
    } else if (ft) {
      if (!from.matchesFilter && !to.matchesFilter) alpha = 0.03;
      else if (!from.matchesFilter || !to.matchesFilter) alpha = 0.1;
      else alpha = 0.55;
    } else if (hl) {
      alpha = 0.9;
    }

    var vs = e.visualStrength !== undefined ? e.visualStrength : (e.strength / 100);
    var reason = e.reason || 'keyword-overlap';
    var T = theme();

    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);

    // 颜色与样式按连接类型（主题化）
    if (reason === 'ai-inferred') {
      // AI 边: 紫色虚线
      ctx.strokeStyle = hl ? T.edgeAIHover : T.edgeAI;
      ctx.lineWidth   = hl ? 3 : 1.2 + vs * 1.5;
      ctx.setLineDash([2, 8]);
    } else if (reason === 'same-source') {
      // 同源: 金色实线
      ctx.strokeStyle = hl ? T.edgeSameSourceHover : T.edgeSameSource;
      ctx.lineWidth   = hl ? 3.5 : 1.5 + vs * 2;
      ctx.setLineDash([]);
    } else if (reason === 'same-domain') {
      // 同域名: 蓝色虚点线
      ctx.strokeStyle = hl ? T.edgeSameDomainHover : T.edgeSameDomain;
      ctx.lineWidth   = hl ? 2.8 : 1.2 + vs * 1.5;
      ctx.setLineDash([6, 6]);
    } else {
      // 关键词: 半透明白色发光带（星座连线）
      ctx.strokeStyle = hl ? 'rgba(200,210,230,0.7)' : 'rgba(180,190,210,0.25)';
      ctx.lineWidth   = hl ? 2.2 : 0.8 + vs * 1.2;
      ctx.setLineDash([3, 8]);
    }

    // 辉光效果 — 使用 shadowBlur
    if (hl) {
      ctx.shadowColor = ctx.strokeStyle;
      ctx.shadowBlur = 8;
    }

    ctx.globalAlpha = alpha;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;

    // 不显示百分比标签 — 悬停时显示叙事文案在 tooltip 中
  });
}

// ---- 节点渲染 ----
function renderKnowlinkNodes(ctx, vt, hoveredNode, focusedNode, selectedNode, filterText, time) {
  var ft = filterText ? filterText.toLowerCase().trim() : '';

  graphNodes.forEach(function(nd, i) {
    var hl = (hoveredNode === i);
    var fc = (focusedNode === i);
    var sl = (selectedNode === i);

    // 聚焦模式：淡化其他节点
    var alpha = 1;
    if (focusedNode !== null && focusedNode !== undefined) {
      if (!fc && !hl) {
        // 检查是否与聚焦节点有关联边
        var connected = false;
        if (typeof graphEdges !== 'undefined') {
          connected = graphEdges.some(function(e) {
            return (e.from === focusedNode && e.to === i) || (e.to === focusedNode && e.from === i);
          });
        }
        if (typeof window.KnowLinkAI !== 'undefined') {
          var aiE = window.KnowLinkAI._getAIEdges();
          var focusedStableId = graphNodes[focusedNode] ? graphNodes[focusedNode].stableId : '';
          var nodeStableId = nd.stableId || '';
          connected = connected || aiE.some(function(e) {
            return (e.from === focusedStableId && e.to === nodeStableId) ||
                   (e.to === focusedStableId && e.from === nodeStableId);
          });
        }
        alpha = connected ? 0.7 : 0.1;
      }
    } else if (ft) {
      if (!nd.matchesFilter) { alpha = 0.12; if (hl) alpha = 0.5; }
    }

    ctx.globalAlpha = alpha;

    var x = nd.x, y = nd.y, r = nd.radius;
    var color = nd.color;
    var T = theme();

    // ---- 聚焦光环 ----
    if (fc) {
      ctx.beginPath();
      ctx.arc(x, y, r + 10, 0, Math.PI * 2);
      var ringGrad = ctx.createRadialGradient(x, y, r + 2, x, y, r + 12);
      ringGrad.addColorStop(0, T.focusRing);
      ringGrad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = ringGrad;
      ctx.fill();
    }

    // ---- 选中高亮 ----
    if (sl) {
      ctx.beginPath();
      ctx.arc(x, y, r + 6, 0, Math.PI * 2);
      ctx.strokeStyle = T.selectedRing;
      ctx.lineWidth = 2.5;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // ---- 辉光 (shadowBlur) ----
    if (hl || fc) {
      if (color.startsWith('#')) {
        ctx.shadowColor = hexToRgba(color, 0.5);
      } else {
        ctx.shadowColor = color.replace(')', ',0.5)').replace('rgb', 'rgba');
      }
      // 除以缩放比例，使模糊在屏幕空间保持恒定，避免放大后边缘发虚
      ctx.shadowBlur = vt.scale > 0.01 ? 14 / vt.scale : 14;
    }

    // ==================== 小球本体（obsidian 黑点 / space 渐变） ====================
    if (_knowlinkTheme === 'obsidian') {
      // Obsidian 关系图谱风格：灰色圆点（缩小一倍，无边框；聚焦/选中变黑）
      var dotR = r * 0.5;
      ctx.beginPath();
      ctx.arc(x, y, dotR, 0, Math.PI * 2);
      ctx.fillStyle = (hl || fc || sl) ? (T.nodeColorActive || '#000000') : (T.nodeColor || color);
      ctx.fill();
    } else {
      // Space 深空：径向渐变（中心 75% 透明度 → 边缘淡出）
      var ballGrad = ctx.createRadialGradient(x, y, 0, x, y, r);
      ballGrad.addColorStop(0, hexToRgba(color, hl ? 0.9 : 0.75));    // 中心 75%（hover 90%）
      ballGrad.addColorStop(0.6, hexToRgba(color, hl ? 0.5 : 0.4));   // 中段
      ballGrad.addColorStop(1, 'rgba(0,0,0,0)');                       // 边缘淡出
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = ballGrad;
      ctx.fill();

      // Space 渐变外环：柔和光晕环（营造星球氛围）
      var haloGrad = ctx.createRadialGradient(x, y, r * 0.6, x, y, r * 1.8);
      haloGrad.addColorStop(0, hexToRgba(color, hl ? 0.25 : 0.12));
      haloGrad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.beginPath();
      ctx.arc(x, y, r * 1.8, 0, Math.PI * 2);
      ctx.fillStyle = haloGrad;
      ctx.fill();
    }

    // 2. 细边框（精致描边）
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.strokeStyle = hl ? T.nodeBorderHover : T.nodeBorder;
    ctx.lineWidth = hl ? 1.5 : 1;
    ctx.stroke();

    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;

    // ==================== 标签（移到小球下方，提升可读性） ====================
    var lbl = nd.label || '';
    ctx.font = 'bold ' + (hl || fc ? 12 : 11) + 'px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.shadowColor = T.labelShadow;
    ctx.shadowBlur = 4;
    ctx.fillStyle = hl ? T.labelHover : T.labelColor;
    ctx.fillText(lbl, x, y + r + 4);
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;

    // ---- 悬停脉动动画 ----
    if (hl) {
      var pulse = 1 + Math.sin(time * 0.005 + nd.glowPhase) * 0.12;
      ctx.beginPath();
      ctx.arc(x, y, r * (1.25 + pulse * 0.25), 0, Math.PI * 2);
      ctx.strokeStyle = T.glowColor;
      ctx.lineWidth = 1.2;
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
  });
}

// ====================================================================
//  入场动画渲染（Phase 4c）
// ====================================================================
// ---- 入场动画队列 ----
var _animQueue = [];  // {type:'supernova'|'wormhole', startTime, duration, nodeIdx|fromIdx|toIdx}

function startSupernovaAnimation(nodeIdx) {
  _animQueue.push({ type: 'supernova', nodeIdx: nodeIdx, startTime: performance.now(), duration: 250 });
}

function startWormholePulseAnimation(fromIdx, toIdx) {
  _animQueue.push({ type: 'wormhole', fromIdx: fromIdx, toIdx: toIdx, startTime: performance.now(), duration: 500 });
}

// 清理过期动画，返回活跃动画列表
function cleanupAnimations(now) {
  _animQueue = _animQueue.filter(function(a) { return (now - a.startTime) < a.duration; });
  return _animQueue;
}

function renderEntryAnimations(ctx, allEdges, time) {
  if (!_animQueue.length) return;
  var now = performance.now();
  var dpr = window.devicePixelRatio || 1;

  // 检查 prefers-reduced-motion
  var reducedMotion = false;
  try {
    reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch(e) {}
  if (reducedMotion) {
    _animQueue = [];
    return;
  }

  var alive = [];

  _animQueue.forEach(function(anim) {
    var elapsed = now - anim.startTime;
    if (elapsed >= anim.duration) return; // 已过期，移除
    alive.push(anim);

    var t = elapsed / anim.duration; // 0 → 1 进度

    if (anim.type === 'supernova') {
      var nd = graphNodes[anim.nodeIdx];
      if (!nd) return;

      // 超新星爆发：光环从 3x 半径缩小到 0，alpha 从 0.9 → 0
      var ringR = nd.radius * 3 * (1 - t);
      var alpha = 0.9 * (1 - t);

      // 外层大光环
      ctx.beginPath();
      ctx.arc(nd.x, nd.y, ringR + nd.radius * 0.5, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,' + alpha.toFixed(3) + ')';
      ctx.lineWidth = 2 + 4 * (1 - t);
      ctx.shadowColor = 'rgba(192,132,252,' + alpha.toFixed(3) + ')';
      ctx.shadowBlur = 20;
      ctx.stroke();

      // 内层光环
      ctx.beginPath();
      ctx.arc(nd.x, nd.y, ringR * 0.6, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(139,92,246,' + (alpha * 0.7).toFixed(3) + ')';
      ctx.lineWidth = 1 + 2 * (1 - t);
      ctx.shadowBlur = 12;
      ctx.stroke();

      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;

    } else if (anim.type === 'wormhole') {
      var fromNd = graphNodes[anim.fromIdx];
      var toNd = graphNodes[anim.toIdx];
      if (!fromNd || !toNd) return;

      // 虫洞脉冲：光点沿连线传播
      // 缓动：ease-in-out
      var easeT = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;

      var px = fromNd.x + (toNd.x - fromNd.x) * easeT;
      var py = fromNd.y + (toNd.y - fromNd.y) * easeT;

      // 前导光晕
      var glowAlpha = 0.6 * (1 - Math.abs(t - 0.5) * 2); // 中间最亮
      ctx.beginPath();
      ctx.arc(px, py, 5 + 3 * glowAlpha, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(139,92,246,' + glowAlpha.toFixed(3) + ')';
      ctx.shadowColor = 'rgba(139,92,246,0.5)';
      ctx.shadowBlur = 15;
      ctx.fill();

      // 拖尾点
      ctx.beginPath();
      var trail = Math.max(0, easeT - 0.08);
      var trailX = fromNd.x + (toNd.x - fromNd.x) * trail;
      var trailY = fromNd.y + (toNd.y - fromNd.y) * trail;
      ctx.arc(trailX, trailY, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(192,132,252,' + (glowAlpha * 0.5).toFixed(3) + ')';
      ctx.shadowBlur = 8;
      ctx.fill();

      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
    }
  });

  _animQueue = alive;
}

// ====================================================================
//  主渲染入口
// ====================================================================
function renderKnowlink(ctx, vt, W, H, opt) {
  opt = opt || {};
  var hoveredNode  = opt.hoveredNode;
  var focusedNode  = opt.focusedNode;
  var selectedNode = opt.selectedNode;
  var filterText   = opt.filterText || '';
  var time         = opt.time || 0;
  var aiEdges      = opt.aiEdges || [];

  if (!ctx || !W || !H) return;

  var dpr = window.devicePixelRatio || 1;
  ctx.save();
  // 注意: offsetX/Y 是 CSS 像素，需要乘以 dpr 转换为设备像素
  // canvas 后备存储是 W*dpr × H*dpr，平移量必须匹配设备像素坐标系
  ctx.setTransform(
    dpr * vt.scale, 0,
    0, dpr * vt.scale,
    vt.offsetX * dpr, vt.offsetY * dpr
  );

  var vpX = -vt.offsetX / vt.scale;
  var vpY = -vt.offsetY / vt.scale;
  var vpW = W / vt.scale;
  var vpH = H / vt.scale;

  ctx.clearRect(vpX, vpY, vpW, vpH);

  // ---- Layer 1: 深空背景 + 星场 ----
  renderStarfield(ctx, vt, W, H, time);

  // ---- Layer 2: 星云光晕（密集知识区域） ----
  renderNebulae(ctx, vt);

  // ---- Layer 2.5: 星系中心微尘 ----
  renderKnowlinkDust(ctx, vt, time);

  // ---- Layer 4: 边（连线） ----
  var allEdges = graphEdges.concat(aiEdges);
  renderKnowlinkEdges(ctx, vt, allEdges, hoveredNode, focusedNode, filterText, time);

  // ---- Layer 5: 星座连线（跨星系的语义关联） ----
  // (已在 renderKnowlinkEdges 中通过 reason 区分渲染)

  // ---- Layer 6: 恒星节点 ----
  renderKnowlinkNodes(ctx, vt, hoveredNode, focusedNode, selectedNode, filterText, time);

  // ---- Layer 6.5: 入场动画（超新星 + 虫洞脉冲） ----
  renderEntryAnimations(ctx, allEdges, time);

  ctx.restore();

  // ---- Layer 7: 空状态消息 ----
  if (!graphNodes.length) {
    ctx.fillStyle = theme().emptyText;
    ctx.font = '15px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('🌌 知识宇宙中还没有星光，去收集一些知识点吧', W / 2, H / 2);
  }
}



// ====================================================================
//  Obsidian 移植导出 shim（追加内容，原实现未改动）
// ====================================================================
export {
  buildKnowlinkGraph, detectGalaxies, computeKnowlinkLayout, runKnowlinkForceSimulation,
  addNodesToGraph, relaxNewNodes, findNodeAt, computeStrength, getEdgeNarrative,
  renderKnowlink, getKnowlinkTheme, setKnowlinkTheme, KNOWLINK_THEMES
};

export function getKnowlinkState() {
  return { graphNodes: graphNodes, graphEdges: graphEdges, galaxies: galaxies };
}
