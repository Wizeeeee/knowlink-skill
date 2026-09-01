// ====================================================================
//  Obsidian 知识星系 — 共享工具（移植自 knowlink-view/utils.js）
//  仅保留无 chrome.* 依赖的部分；navigateToSource 依赖扩展 API，已移除。
// ====================================================================

export var SOURCE_COLORS = [
  '#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
  '#ec4899', '#f43f5e', '#f97316', '#eab308',
  '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6'
];

// ---- HTML 转义 ----
export function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---- 为知识点分配来源颜色 ----
export function assignSourceColors(points, colorMap) {
  if (!colorMap) return;
  for (var k in colorMap) { if (Object.prototype.hasOwnProperty.call(colorMap, k)) delete colorMap[k]; }
  var ci = 0;
  points.forEach(function(p) {
    if (!colorMap[p.url]) colorMap[p.url] = SOURCE_COLORS[ci++ % SOURCE_COLORS.length];
  });
}

// ---- 解析真实 URL（从各种包装格式中提取原始链接）----
export function resolveRealUrl(url) {
  if (!url) return url;
  if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('file:///')) return url;

  try {
    var normalized = url;
    if (url.startsWith('extension://')) normalized = 'chrome-' + url;
    var u = new URL(normalized);

    var paramNames = ['src', 'file', 'url', 'originalUrl', 'source', 'pdf', 'href', 'path', 'filename'];
    for (var i = 0; i < paramNames.length; i++) {
      var val = u.searchParams.get(paramNames[i]);
      if (val && val.length > 0) {
        try { var d = decodeURIComponent(val); if (d.startsWith('file://') || d.startsWith('http')) return d; } catch (e2) {}
        if (val.startsWith('file://') || val.startsWith('http')) return val;
      }
    }

    var s = u.search || '';
    if (s.length > 1) {
      var raw = s.substring(1);
      var decoded = raw;
      try { decoded = decodeURIComponent(raw); } catch (e2) {}
      if (decoded.startsWith('file://') || decoded.startsWith('http')) return decoded;
      if (raw.startsWith('file://') || raw.startsWith('http')) return raw;
    }

    var hash = u.hash || '';
    if (hash.length > 1) {
      var h = hash.substring(1);
      try { h = decodeURIComponent(h); } catch (e2) {}
      if (h.startsWith('file://') || h.startsWith('http')) return h;
    }
  } catch (e) {}

  return url;
}
