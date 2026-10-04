/**
 * 作品 Hub 存储层：R2 键即目录（<分类>/<项目>/<相对路径>），零索引组件。
 * 列表/文件数/大小/入口全部由 list({ prefix, delimiter }) 实时推导；
 * 列表缓存由路由层负责（Cache API，60 秒，写后清除）。
 */
const SEG_RE = /^[\u4e00-\u9fa5A-Za-z0-9_-]+$/;        // 分类/项目名
const FILE_SEG_RE = /^[\u4e00-\u9fa5A-Za-z0-9_.-]+$/;  // 文件路径段（含扩展名的点）

export function validSegment(s, max) {
  return typeof s === 'string' && s.length >= 1 && s.length <= max && SEG_RE.test(s);
}

export function validFilePath(p) {
  if (typeof p !== 'string' || !p || p.length > 512) return false;
  if (p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((s) => s !== '..' && FILE_SEG_RE.test(s));
}

export const r2Key = (cat, proj, path) => `${cat}/${proj}/${path}`;

export const CAT_MAX = 24;
export const PROJ_MAX = 64;

/** 入口：根级 index.html 优先，其次根级字典序第一个 .html，最后全项目第一个 .html */
export function findEntryHtml(objects, prefix) {
  const rel = objects.map((o) => o.key).filter((k) => k.startsWith(prefix) && k.endsWith('.html'));
  if (!rel.length) return null;
  const roots = rel.filter((k) => !k.slice(prefix.length).includes('/'));
  const rootEntry = roots.find((k) => k === prefix + 'index.html') || roots.sort()[0];
  return rootEntry ? rootEntry.slice(prefix.length) : rel.sort()[0].slice(prefix.length);
}

function projAgg(objects, prefix) {
  const entry = findEntryHtml(objects, prefix);
  let fileCount = 0; let totalSize = 0; let latest = 0;
  for (const o of objects) { fileCount++; totalSize += o.size; latest = Math.max(latest, +new Date(o.uploaded)); }
  return { entry, fileCount, totalSize, updatedAt: new Date(latest).toISOString() };
}

export async function listProjects(env) {
  const catList = await env.HUB.list({ delimiter: '/' });
  const cats = [];
  for (const cp of catList.delimitedPrefixes.sort()) {
    const name = cp.slice(0, -1);
    const projList = await env.HUB.list({ prefix: cp, delimiter: '/' });
    const projects = [];
    for (const pp of projList.delimitedPrefixes.sort()) {
      const all = await env.HUB.list({ prefix: pp });
      projects.push({ name: pp.slice(cp.length, -1), ...projAgg(all.objects, pp) });
    }
    cats.push({ name, projects });
  }
  return cats;
}

export async function listFiles(env, cat, proj) {
  const prefix = r2Key(cat, proj, '');
  const all = await env.HUB.list({ prefix });
  return all.objects.map((o) => ({
    path: o.key.slice(prefix.length),
    size: o.size,
    updatedAt: new Date(o.uploaded).toISOString(),
  }));
}

export async function putFile(env, cat, proj, path, body) {
  await env.HUB.put(r2Key(cat, proj, path), body);
}

export async function deleteFile(env, cat, proj, path) {
  const key = r2Key(cat, proj, path);
  const obj = await env.HUB.get(key);
  if (!obj) return false;
  await env.HUB.delete(key);
  return true;
}

export async function deleteProject(env, cat, proj) {
  const prefix = r2Key(cat, proj, '');
  const all = await env.HUB.list({ prefix });
  if (!all.objects.length) return 0;
  await env.HUB.delete(all.objects.map((o) => o.key));
  return all.objects.length;
}
