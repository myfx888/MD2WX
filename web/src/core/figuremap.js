/**
 * MD2WX 配图映射纯逻辑层:图片引用收集、智能匹配、预览替换、源文本替换。
 * 零 DOM 依赖(Node 可测);路径归一化 = 剥 ./ 前缀、\ 转 /、合并连续 /,大小写敏感。
 */

/** 归一化路径:剥 ./ 前缀、\ 统一为 /、合并连续 /、去首尾空白 */
export function normalizePath(p) {
  let s = String(p || '').trim().replace(/\\/g, '/');
  while (s.startsWith('./')) s = s.slice(2);
  return s.replace(/\/{2,}/g, '/');
}

/** 取 basename('images/01.png' -> '01.png') */
function basename(p) {
  const s = normalizePath(p);
  const idx = s.lastIndexOf('/');
  return idx === -1 ? s : s.slice(idx + 1);
}

/** 已远程的引用(协议相对 //、http(s)://、data:)不参与本地匹配 */
function isRemoteRef(path) {
  return /^(https?:)?\/\//i.test(path) || /^data:/i.test(path);
}

/**
 * 收集文中图片引用,返回 [{ raw, path, kind: 'md' | 'html' }]。
 * raw 与 path 相同(保留原文写法作替换键);已远程引用与重复路径跳过。
 */
export function collectImageRefs(markdown) {
  const text = String(markdown || '');
  const refs = [];
  const seen = new Set();
  let m;

  // Markdown: ![alt](path) / ![alt](path "title")
  const mdRe = /!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
  while ((m = mdRe.exec(text)) !== null) {
    const p = m[1];
    if (isRemoteRef(p) || seen.has(p)) continue;
    seen.add(p);
    refs.push({ raw: p, path: p, kind: 'md' });
  }

  // HTML: <img ... src="path"> / src='path'
  const htmlRe = /<img\s+[^>]*?src=(?:"([^"]+)"|'([^']+)')/gi;
  while ((m = htmlRe.exec(text)) !== null) {
    const p = m[1] !== undefined ? m[1] : m[2];
    if (isRemoteRef(p) || seen.has(p)) continue;
    seen.add(p);
    refs.push({ raw: p, path: p, kind: 'html' });
  }

  return refs;
}
