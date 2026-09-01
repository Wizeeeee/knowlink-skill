---
name: knowlink-page
description: "基于 KnowLink 知识星系引擎生成自包含交互式 HTML 知识图谱页面。输入 typed JSON 规范（知识点 + 边 + 页面配置），输出可分享的知识簇可视化页面（Canvas 渲染、缩放/平移/搜索/详情面板）。复用 knowlink-core.js 布局+渲染引擎，Node 端预计算布局坐标。当用户要求把知识点/概念/主题可视化为知识图谱页面、生成报告/演示用知识簇图、或把 JSON 数据变成交互式 HTML 时使用。"
metadata:
  version: "1.0"
  last_updated: "2026-08-29"
---

# Knowlink Page — 知识星系页面生成器

把"知识点数据"变成"可分享的交互式知识簇页面"。输入 JSON 规范，输出自包含 HTML（内联数据 + 预计算布局坐标，浏览器端用 knowlink-core.js 渲染）。

## 快速路径（Fast authoring path）

1. **写规范**：参考 `examples/demo.json` 的字段形状，写 `meta`（标题/语言）+ `points`（知识点）+ 可选 `edges`（显式边）+ 可选 `config`（页面配置）。
2. **校验**：
   ```bash
   node bin/knowlink-page.mjs validate <input.json>
   ```
   校验通过（exit 0）才继续。错误会指出具体字段。
3. **渲染**：
   ```bash
   node bin/knowlink-page.mjs render <input.json> [output.html]
   ```
   输出自包含 HTML。Node 端预计算布局坐标（确定性，seeded RNG），浏览器端直接渲染。
4. **交付**：打开 HTML 验证。报告 `spec sha256` + `html sha256` + 节点/知识簇数量。

## 命令

| 命令 | 用途 |
|---|---|
| `validate <input.json>` | schema 校验（零依赖手写检查） |
| `render <input.json> [output.html]` | 生成自包含 HTML |
| `demo [out-dir]` | 生成示例页面（默认 `examples/out/demo.html`） |
| `doctor` | 检查 skill 资产完整性 |

## 输入规范

```json
{
  "meta": { "title": "标题", "subtitle": "可选", "locale": "zh-CN|en" },
  "points": [
    { "id": "kp-1", "title": "短标题", "text": "详情文本", "url": "来源", "source": "来源名" }
  ],
  "edges": [  // 可选：不提供则自动计算（同源/同域/关键词重叠）
    { "from": "kp-1", "to": "kp-2", "strength": 80, "reason": "ai-inferred" }
  ],
  "config": { "theme": "dark", "width": 1200, "height": 800 }
}
```

## 编写守则

1. **title 是节点标签**：≤5 词最佳（渲染时截断）。text 用于关键词连线和详情面板。
2. **id 稳定**：显式边引用 point id。缺省自动生成 `kp-<i>`。
3. **边可选**：不写 edges 时引擎自动计算（同源 100 / 同域 75 / 关键词重叠 5-60）。显式边用 `ai-inferred` 语义。
4. **strength 1-100**：决定边粗细和知识簇聚类（≥15 参与聚类）。
5. **locale 只影响 Viewer UI**：`zh-CN` / `en`。其他语言用 `zh-CN` 并说明。
6. **≤200 个点**：超过会警告。大图建议精简或分组。
7. **确定性**：相同输入产生相同布局（seeded RNG），可做 golden 测试。

## 交付契约

- 校验失败（exit 1）绝不能描述为成功。
- 交付后必须打开 HTML 实际查看：节点不重叠、边不穿节点、标签可读、缩放/搜索/详情面板正常。
- 报告：
  ```text
  output: /absolute/path/to/file.html
  spec_sha256: <值>
  html_sha256: <值>
  nodes: N · galaxies: G
  ```

## 架构

```
用户需求 → agent 写 JSON 规范
    ↓
validate（schema 校验）
    ↓
render（Node 端跑布局 → 坐标序列化 → 注入模板）
    ↓
自包含 HTML（内联 knowlink-core.js + 数据 + 样式）
```

- `lib/knowlink-core.js`：从 `knowlink-obsidian/src/lib/knowlink-core.js` 复制的布局+渲染核心（含 seeded RNG 修复）
- `assets/template.html`：页面模板（基于 network.html 精简，去 Chrome 依赖）
- 布局函数不碰 DOM → Node 端可预计算坐标；渲染函数浏览器端执行

## 参考

- `references/authoring-contract.md` — 字段语义、布局参数、修复顺序
- `schemas/page.schema.json` — 输入规范（JSON Schema）
- `examples/demo.json` — 示例（深度学习概念图谱）