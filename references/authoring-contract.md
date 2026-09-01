# Authoring contract — Knowlink Page 编写契约

## 字段语义

### meta
- `title`（必填）：页面标题，显示在顶栏。不要用副标题复述它。
- `subtitle`（可选）：一行短说明。不要复述标题或节点。
- `locale`：`zh-CN` / `en`。只控制 Viewer UI 文案（搜索占位符、图例、按钮）。**不翻译 authored 内容**——title/text 用什么语言由作者决定。
- `author` / `date`：来源标注（当前模板未显示，保留字段）。

### points
- `id`：稳定字符串。显式边引用它。缺省 `kp-<i>`。
- `title`：节点标签。渲染时 `truncateToWords(5)` 截断。**这是用户第一眼看到的东西，要短而准**。
- `text`：详情文本 + 关键词连线依据。越长关键词越丰富，但别塞无关内容。
- `url`：同源（相同 URL → strength 100）/同域（相同 host → 75）连线的依据。缺省则只靠关键词。
- `source`：来源名，显示在详情面板。
- `page`：页码（PDF 跳转，当前模板未用）。

### edges
- 可选。不提供时引擎自动计算。
- `from` / `to`：point id，必须存在（校验会查）。
- `strength`：1-100。≥15 参与星系聚类。
- `reason`：`same-source` / `same-domain` / `keyword-overlap` / `ai-inferred`。影响边样式（金实线/蓝虚点/白虚线/紫虚线）。

### config
- `theme`：`dark`（默认）/ `light`（模板当前只实现 dark，light 待做）。
- `width` / `height`：布局逻辑尺寸（默认 1200×800）。影响星系网格和螺旋臂半径。
- `showSearch` / `showLegend` / `showStats`：UI 开关（模板当前全开）。
- `interactive`：false 时生成静态快照（当前模板未实现，默认交互式）。
- `seed`：布局种子（缺省用 meta.title hash）。

## 布局参数（来自 knowlink-core.js）

| 参数 | 值 | 说明 |
|---|---|---|
| 星系聚类阈值 | strength ≥ 15 | 弱边不参与聚类 |
| 星系网格 padding | 250 | 星系中心间距 |
| 螺旋臂数量 | `max(2, min(4, ceil(n/6)))` | 每星系 |
| 力模拟迭代 | 40，DAMP 0.8 | 布局松弛 |
| 边理想长度 | `130 - strength*0.7` | 弹簧力 |
| 节点半径 | `10 + min(importance*2.5, 18) + min(len*0.2, 8)` | 核心节点更大 |

## 修复顺序（布局质量）

如果生成的页面有节点重叠/边穿节点/标签遮挡：

1. **先调数据**：删低价值边（strength < 15 的弱关联）、精简 title 长度。
2. **再调布局**：增大 `config.width/height`（给星系更多空间）、调整 points 分组。
3. **最后才改引擎**：改 `lib/knowlink-core.js` 的布局参数（如 padding、maxR），改完必须重新 render 验证。

**不要**为了通过而隐藏问题（如 overflow:hidden 裁掉节点）。

## 确定性

- 布局用 seeded RNG（mulberry32 + hashString），种子 = `meta.title` hash（或 `config.seed`）。
- 相同输入 → 相同坐标 → 可做 golden 测试。
- 改 `config.seed` 可换一种布局观感。

## 双端同步

- `lib/knowlink-core.js` 是从 `knowlink-obsidian/src/lib/knowlink-core.js` 复制的。
- 上游（Chrome 扩展 `knowlink-layout.js` / `knowlink-renderer.js`）改算法时，**三处都要同步**：
  1. `knowlink-view/js/core/knowlink-layout.js` + `knowlink-renderer.js`
  2. `knowlink-obsidian/src/lib/knowlink-core.js`
  3. `knowlink-skill/lib/knowlink-core.js`
- 同步后跑 `node bin/knowlink-page.mjs demo` 验证不回归。

## 已知限制

- 模板只实现 dark 主题（light 待做）。
- `interactive: false` 静态模式未实现。
- 无导出 PNG/WebM（archify 有，本项目暂不需要）。
- 无 preview watch（改 JSON 后手动重新 render）。