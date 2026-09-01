// ====================================================================
//  knowlink-core.js 单元测试（Node 内置 test runner，零依赖）
//  运行：npm test
// ====================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildKnowlinkGraph, computeStrength, getEdgeNarrative,
  getKnowlinkState, computeKnowlinkLayout
} from '../lib/knowlink-core.js';

// ---- 测试数据 ----
const SAMPLE_POINTS = [
  { id: 'kp-1', title: '深度学习', text: '深度学习是机器学习的一个分支，使用多层神经网络进行特征学习。', url: 'https://example.com/dl', source: 'AI 教程' },
  { id: 'kp-2', title: '神经网络', text: '神经网络由大量神经元组成，通过反向传播算法训练。', url: 'https://example.com/dl', source: 'AI 教程' },
  { id: 'kp-3', title: '卷积网络', text: '卷积神经网络 CNN 擅长图像识别，使用卷积核提取特征。', url: 'https://example.com/cnn', source: 'CV 笔记' },
  { id: 'kp-4', title: '量子计算', text: '量子计算利用量子比特的叠加态进行并行计算。', url: 'https://quantum.org/qc', source: '物理笔记' }
];

// ====================================================================
//  computeStrength — 边强度计算
// ====================================================================
test('computeStrength: 同源 URL → strength 100, reason same-source', () => {
  const a = { url: 'https://example.com/dl', text: '深度学习' };
  const b = { url: 'https://example.com/dl', text: '神经网络' };
  const r = computeStrength(a, b);
  assert.equal(r.strength, 100);
  assert.equal(r.reason, 'same-source');
});

test('computeStrength: 同域不同 URL → strength 75, reason same-domain', () => {
  const a = { url: 'https://example.com/dl', text: '深度学习' };
  const b = { url: 'https://example.com/cnn', text: '卷积网络' };
  const r = computeStrength(a, b);
  assert.equal(r.strength, 75);
  assert.equal(r.reason, 'same-domain');
});

test('computeStrength: 关键词重叠 → strength ≥ 15, reason keyword-overlap', () => {
  const a = { url: '', text: '深度学习 神经网络 特征学习' };
  const b = { url: '', text: '神经网络 反向传播 训练' };
  const r = computeStrength(a, b);
  assert.equal(r.reason, 'keyword-overlap');
  assert.ok(r.strength >= 15 && r.strength <= 60, `strength=${r.strength} 应在 [15,60]`);
});

test('computeStrength: 无关联 → strength 0, reason none', () => {
  const a = { url: '', text: '深度学习 神经网络' };
  const b = { url: '', text: '量子计算 量子比特' };
  const r = computeStrength(a, b);
  assert.equal(r.strength, 0);
  assert.equal(r.reason, 'none');
});

test('computeStrength: 弱关键词重叠（<15）不建边', () => {
  // 只共享 1 个词，ratio 低 → 应返回 0
  const a = { url: '', text: '苹果 香蕉 橘子 葡萄 西瓜 草莓' };
  const b = { url: '', text: '苹果 汽车 飞机 轮船 火车 地铁' };
  const r = computeStrength(a, b);
  assert.equal(r.strength, 0);
});

// ====================================================================
//  getEdgeNarrative — 边叙事文案
// ====================================================================
test('getEdgeNarrative: 各 reason 文案', () => {
  assert.equal(getEdgeNarrative('same-source', 100), '📖 来自同一篇文章');
  assert.equal(getEdgeNarrative('same-domain', 75), '🌐 来自同一网站');
  assert.equal(getEdgeNarrative('ai-inferred', 50), '🤖 AI 发现的深层关联');
  assert.equal(getEdgeNarrative('unknown', 0), '—');
});

test('getEdgeNarrative: keyword-overlap 按强度分级', () => {
  assert.equal(getEdgeNarrative('keyword-overlap', 50), '💡 主题高度相关');
  assert.equal(getEdgeNarrative('keyword-overlap', 25), '🔗 共享部分关键词');
  assert.equal(getEdgeNarrative('keyword-overlap', 15), '📎 略有交集');
});

// ====================================================================
//  buildKnowlinkGraph + getKnowlinkState — 图构建
// ====================================================================
test('buildKnowlinkGraph: 节点数正确，stableId 保留', () => {
  buildKnowlinkGraph(SAMPLE_POINTS);
  const { graphNodes } = getKnowlinkState();
  assert.equal(graphNodes.length, 4);
  assert.equal(graphNodes[0].stableId, 'kp-1');
  assert.equal(graphNodes[0].label, '深度学习');
  assert.ok(graphNodes[0].fullText.length > 0);
});

test('buildKnowlinkGraph: 同源点之间生成边', () => {
  buildKnowlinkGraph(SAMPLE_POINTS);
  const { graphEdges } = getKnowlinkState();
  // kp-1 与 kp-2 同源（example.com/dl）→ 必有边
  const sameSourceEdge = graphEdges.find(e =>
    (e.from === 0 && e.to === 1) || (e.from === 1 && e.to === 0)
  );
  assert.ok(sameSourceEdge, '同源点之间应有边');
  assert.equal(sameSourceEdge.strength, 100);
  assert.equal(sameSourceEdge.reason, 'same-source');
});

test('buildKnowlinkGraph: 检测到知识簇（连通分量）', () => {
  buildKnowlinkGraph(SAMPLE_POINTS);
  const { galaxies } = getKnowlinkState();
  // kp-1/kp-2/kp-3 通过同源/同域/关键词相连 → 至少 1 个多节点知识簇
  assert.ok(galaxies.length >= 1, `应有知识簇，实际 ${galaxies.length}`);
  const multiNode = galaxies.find(g => g.nodeIds.length >= 2);
  assert.ok(multiNode, '应有至少一个多节点知识簇');
});

test('buildKnowlinkGraph: 空输入 → 空图', () => {
  buildKnowlinkGraph([]);
  const { graphNodes, graphEdges } = getKnowlinkState();
  assert.equal(graphNodes.length, 0);
  assert.equal(graphEdges.length, 0);
});

// ====================================================================
//  computeKnowlinkLayout — 布局确定性
// ====================================================================
test('computeKnowlinkLayout: 相同输入产生相同布局（确定性）', () => {
  buildKnowlinkGraph(SAMPLE_POINTS);
  computeKnowlinkLayout(getKnowlinkState().graphNodes, getKnowlinkState().graphEdges, 1200, 800);
  const first = getKnowlinkState().graphNodes.map(n => [n.x, n.y]);

  buildKnowlinkGraph(SAMPLE_POINTS);
  computeKnowlinkLayout(getKnowlinkState().graphNodes, getKnowlinkState().graphEdges, 1200, 800);
  const second = getKnowlinkState().graphNodes.map(n => [n.x, n.y]);

  assert.deepEqual(first, second, '相同输入应产生相同布局坐标');
});

test('computeKnowlinkLayout: 所有节点坐标是有限数字', () => {
  buildKnowlinkGraph(SAMPLE_POINTS);
  computeKnowlinkLayout(getKnowlinkState().graphNodes, getKnowlinkState().graphEdges, 1200, 800);
  const { graphNodes } = getKnowlinkState();
  graphNodes.forEach(n => {
    assert.ok(Number.isFinite(n.x), `节点 ${n.stableId} x 应为有限数字`);
    assert.ok(Number.isFinite(n.y), `节点 ${n.stableId} y 应为有限数字`);
  });
});