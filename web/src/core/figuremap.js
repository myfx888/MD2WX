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

/**
 * 智能匹配:第一轮归一化相对路径精确;第二轮 basename 唯一回落;同名多个 -> conflict。
 * files: [{ path, file }](path 为文件夹内相对路径)。
 * 返回 Map<rawPath, 结果>;结果恒含 status,matched 另含 file/filePath/matchType,
 * conflict 另含 conflicts(排序后的候选路径数组)。
 */
export function matchFiles(refs, files) {
  const result = new Map();
  const byPath = new Map();
  const byName = new Map();
  for (const f of files) {
    const np = normalizePath(f.path);
    byPath.set(np, f);
    const name = basename(np);
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(np);
  }

  for (const ref of refs) {
    const np = normalizePath(ref.path);
    if (byPath.has(np)) {
      result.set(ref.path, { file: byPath.get(np).file, filePath: np, matchType: 'exact', status: 'matched' });
      continue;
    }
    const candidates = (byName.get(basename(np)) || []).slice().sort();
    if (candidates.length === 1) {
      const hit = byPath.get(candidates[0]);
      result.set(ref.path, { file: hit.file, filePath: candidates[0], matchType: 'filename', status: 'matched' });
    } else if (candidates.length > 1) {
      result.set(ref.path, { file: null, filePath: null, status: 'conflict', conflicts: candidates });
    } else {
      result.set(ref.path, { file: null, filePath: null, status: 'unmatched' });
    }
  }
  return result;
}
