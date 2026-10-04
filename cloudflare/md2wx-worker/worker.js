/**
 * MD2WX 一体化 Worker：整站静态托管（Workers Assets）+ Markdown 转换 API + 微信草稿箱推送
 *
 * 路由（本任务先实现 /api/health，其余路由由后续任务追加）：
 *   GET  /api/health   健康检查
 *   GET  /api/themes   枚举内置主题
 *   POST /api/convert  公开转换（markdown -> 微信内联 HTML）
 *   POST /api/draft    草稿推送（X-API-Key 或 ?key= 鉴权）
 *   POST /api/hub/*    作品 Hub 管理（登录/列表/上传/删除）+ GET|HEAD /hub/* 预览回源
 *
 * 非 /api 请求由 wrangler [assets] 直接托管 web/dist，不进入本 Worker 的路由逻辑。
 *
 * 密钥 (wrangler secret / .dev.vars)：
 *   DRAFT_API_KEY      推送鉴权 Key；未配置则 /api/draft 直接拒绝（fail-closed）
 *   WECHAT_APPID       微信 appid 兜底（请求体 appid 优先）
 *   WECHAT_APPSECRET   微信 secret 兜底（请求体 secret 优先）
 */

import { markdownToWechatHtml, parseFrontmatter } from '../../web/src/core/parser.js';
import { BUILTIN_THEMES, DEFAULT_THEME_ID, listThemes } from '../../web/src/core/themes.js';
import defaultCoverPng from './assets/default-cover.png';
import { signToken, verifyToken } from './hub-auth.js';
import {
  validSegment, validFilePath, findEntryHtml, listProjects, listFiles,
  putFile, deleteFile, deleteProject, CAT_MAX, PROJ_MAX,
} from './hub-store.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-API-Key',
  'Access-Control-Max-Age': '86400',
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}

async function enforceConvertRateLimit(request, env) {
  const limiter = env.CONVERT_RATE_LIMITER;
  if (!limiter || typeof limiter.limit !== 'function') return null;
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const { success } = await limiter.limit({ key: `convert:${ip}` });
  if (!success) return json({ code: 1, msg: '请求过于频繁，请稍后再试' }, 429);
  return null;
}

function resolveThemeId(theme) {
  return theme && Object.prototype.hasOwnProperty.call(BUILTIN_THEMES, theme)
    ? theme
    : DEFAULT_THEME_ID;
}

function buildConvertResult(body) {
  const themeId = resolveThemeId(body.theme);
  const html = markdownToWechatHtml(body.markdown, themeId);
  const { meta } = parseFrontmatter(body.markdown);
  return {
    code: 0,
    html,
    title: body.title || meta.title || '',
    digest: body.digest || meta.digest || '',
    theme: themeId,
  };
}

function handleConvert(body) {
  if (typeof body.markdown !== 'string' || !body.markdown.trim()) {
    return json({ code: 1, msg: 'markdown 必填且不能为空' }, 400);
  }
  return json(buildConvertResult(body));
}

// ============================== 微信草稿箱推送 ==============================
const WX_BASE = 'https://api.weixin.qq.com';
// token 缓存按 appid 隔离：请求体可穿透凭证（多公众号），共享单例缓存会串号
const tokenCache = new Map(); // appid -> { token, exp }

function dataUriToBlob(dataUri) {
  const m = /^data:([^;]+);base64,(.*)$/.exec(dataUri);
  if (!m) return null;
  const mime = m[1];
  const bin = atob(m[2]);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

function formDataFile(field, blob, filename) {
  const fd = new FormData();
  fd.append(field, blob, filename);
  return fd;
}

/**
 * 主题默认封面兜底（assets/default-cover.png，与 DEFAULT_THEME_ID 同源设计）。
 * 测试打包走 esbuild dataurl loader（字符串 data URI），生产打包走 wrangler Data rule（ArrayBuffer）。
 */
function defaultCoverBlob() {
  if (typeof defaultCoverPng === 'string') return dataUriToBlob(defaultCoverPng);
  return new Blob([defaultCoverPng], { type: 'image/png' });
}

export class WeChat {
  constructor(appid, secret, fetchImpl = globalThis.fetch) {
    this.appid = appid;
    this.secret = secret;
    // workerd 的 fetch 对 this 敏感：以实例属性形式调用会抛 Illegal invocation，
    // 必须绑定到全局对象；注入的测试 mock 为普通函数，bind 无副作用
    this.fetch = fetchImpl.bind(globalThis);
  }

  async getToken() {
    const now = Date.now();
    const cached = tokenCache.get(this.appid);
    if (cached && now < cached.exp) return cached.token;
    const resp = await this.fetch(`${WX_BASE}/cgi-bin/stable_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credential',
        appid: this.appid,
        secret: this.secret,
        force_refresh: false,
      }),
    });
    const data = await resp.json();
    if (!data.access_token) throw new Error('获取 token 失败: ' + JSON.stringify(data));
    tokenCache.set(this.appid, { token: data.access_token, exp: now + 7000 * 1000 });
    return data.access_token;
  }

  async uploadTempImage(blob) {
    const token = await this.getToken();
    const resp = await this.fetch(`${WX_BASE}/cgi-bin/media/uploadimg?access_token=${token}`, {
      method: 'POST',
      body: formDataFile('media', blob, 'img.png'),
    });
    const data = await resp.json();
    if (!data.url) throw new Error('上传正文图失败: ' + JSON.stringify(data));
    return data.url;
  }

  async uploadMaterial(blob) {
    const token = await this.getToken();
    const resp = await this.fetch(`${WX_BASE}/cgi-bin/material/add_material?access_token=${token}&type=image`, {
      method: 'POST',
      body: formDataFile('media', blob, 'cover.png'),
    });
    const data = await resp.json();
    if (!data.media_id) throw new Error('上传封面素材失败: ' + JSON.stringify(data));
    return data.media_id;
  }

  async urlToBlob(url) {
    const resp = await this.fetch(url);
    if (!resp.ok) throw new Error('下载图片失败: ' + url + ' (' + resp.status + ')');
    return resp.blob();
  }

  async localizeImages(html) {
    const re = /<img\s+[^>]*?src="([^"]+)"[^>]*?>/gi;
    const srcs = [];
    let m;
    while ((m = re.exec(html)) !== null) srcs.push(m[1]);
    for (const src of srcs) {
      if (src.startsWith('https://mmbiz.qpic.cn') || src.startsWith('http://mmbiz.qpic.cn')) continue;
      let blob = null;
      try {
        if (src.startsWith('data:')) blob = dataUriToBlob(src);
        else if (/^https?:\/\//.test(src)) blob = await this.urlToBlob(src);
      } catch (e) {
        continue;
      }
      if (blob) {
        try {
          const wxUrl = await this.uploadTempImage(blob);
          html = html.split(src).join(wxUrl);
        } catch (e) { }
      }
    }
    return html;
  }

  /**
   * 封面解析：cover 参数 -> 正文第一张图 -> 主题默认封面兜底。
   * 返回 { media_id, source }，source ∈ 'provided' | 'article' | 'default'
   */
  async resolveCover(cover, content) {
    if (cover) {
      let blob = null;
      if (cover.startsWith('data:')) blob = dataUriToBlob(cover);
      else if (/^https?:\/\//.test(cover)) blob = await this.urlToBlob(cover);
      if (blob) return { media_id: await this.uploadMaterial(blob), source: 'provided' };
    }
    const m = /<img\s+[^>]*?src="([^"]+)"[^>]*?>/i.exec(content);
    if (m) {
      const src = m[1];
      let blob = null;
      if (src.startsWith('data:')) blob = dataUriToBlob(src);
      else if (/^https?:\/\//.test(src)) blob = await this.urlToBlob(src);
      if (blob) return { media_id: await this.uploadMaterial(blob), source: 'article' };
    }
    return { media_id: await this.uploadMaterial(defaultCoverBlob()), source: 'default' };
  }

  async addDraft(article) {
    const token = await this.getToken();
    const resp = await this.fetch(`${WX_BASE}/cgi-bin/draft/add?access_token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ articles: [article] }),
    });
    const data = await resp.json();
    if (data.errcode) throw new Error('draft/add 失败: ' + JSON.stringify(data));
    return data.media_id;
  }
}

export function __resetTokenCache() {
  tokenCache.clear();
}

// ============================== 作品 Hub 辅助 ==============================
async function enforceHubLoginRateLimit(request, env) {
  const limiter = env.HUB_LOGIN_LIMITER;
  if (!limiter || typeof limiter.limit !== 'function') return null;
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const { success } = await limiter.limit({ key: `hublogin:${ip}` });
  return success ? null : true; // true = 已限流（文案统一走 401，防探测）
}

async function requireHubAuth(request, env) {
  if (!env.HUB_ADMIN_PASSWORD) return json({ code: 1, msg: '服务端未配置 HUB_ADMIN_PASSWORD，拒绝写入' }, 500);
  const provided = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const ok = await verifyToken(provided, env.HUB_ADMIN_PASSWORD);
  return ok ? null : json({ code: 1, msg: '未授权' }, 401);
}

// 列表缓存：单一合成键，TTL 60s，写操作后由路由层清除（Node 测试环境无 caches，自动跳过）
const HUB_CACHE_TTL = 60;
const hubCacheKey = (origin) => new Request(origin + '/__hubcache__/projects');
export async function getListCache(origin) {
  if (typeof caches === 'undefined') return null;
  return await caches.default.match(hubCacheKey(origin));
}
export async function putListCache(origin, response) {
  if (typeof caches === 'undefined') return;
  const copy = new Response(await response.arrayBuffer(), response);
  copy.headers.set('Cache-Control', `max-age=${HUB_CACHE_TTL}`);
  await caches.default.put(hubCacheKey(origin), copy);
}
export async function clearListCache(origin) {
  if (typeof caches === 'undefined') return;
  await caches.default.delete(hubCacheKey(origin));
}

const HUB_CONTENT_TYPES = {
  html: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  json: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp', ico: 'image/x-icon',
  txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  mp4: 'video/mp4', webm: 'video/webm', pdf: 'application/pdf',
  xml: 'application/xml', csv: 'text/csv',
};

function hubNotFoundPage() {
  return new Response(
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>页面不存在</title></head>' +
    '<body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0">' +
    '<div style="text-align:center"><p style="font-size:48px;margin:0">🧭</p>' +
    '<h1 style="font-size:18px;color:#555">页面不存在</h1>' +
    '<p style="color:#999"><a href="/hub.html">返回作品 Hub</a></p></div></body></html>',
    { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } }
  );
}

async function serveHubPreview(request, url, env) {
  if (!env.HUB) return hubNotFoundPage();
  const parts = url.pathname.slice('/hub/'.length).split('/').map((s) => {
    try { return decodeURIComponent(s); } catch { return null; }
  });
  if (parts.some((s) => s === null)) return hubNotFoundPage();
  const [cat, proj, ...rest] = parts;
  if (!validSegment(cat, CAT_MAX) || !validSegment(proj, PROJ_MAX)) return hubNotFoundPage();
  const prefix = cat + '/' + proj + '/';

  if (!rest.length || !rest.join('')) {
    const all = await env.HUB.list({ prefix });
    const entry = findEntryHtml(all.objects, prefix);
    if (!entry) return hubNotFoundPage();
    const loc = '/hub/' + encodeURIComponent(cat) + '/' + encodeURIComponent(proj) + '/' + entry.split('/').map(encodeURIComponent).join('/');
    return new Response(null, { status: 302, headers: { Location: loc } });
  }

  const filePath = rest.join('/');
  if (!validFilePath(filePath)) return hubNotFoundPage();
  const obj = await env.HUB.get(prefix + filePath);
  if (!obj) return hubNotFoundPage();

  const ext = (filePath.split('.').pop() || '').toLowerCase();
  const headers = {
    'Content-Type': HUB_CONTENT_TYPES[ext] || 'application/octet-stream',
    'Cache-Control': ext === 'html' ? 'public, max-age=300' : 'public, max-age=86400',
  };
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
  return new Response(await obj.arrayBuffer(), { status: 200, headers });
}

function normalizeDraftSource(body) {
  if (typeof body.markdown === 'string' && body.markdown.trim()) {
    const converted = buildConvertResult(body);
    return { content: converted.html, title: converted.title, digest: converted.digest };
  }
  if (typeof body.content === 'string' && body.content.trim()) {
    return { content: body.content, title: body.title || '', digest: body.digest || '' };
  }
  return null;
}

async function handleDraft(request, body, env) {
  const KEY = env.DRAFT_API_KEY || '';
  if (!KEY) return json({ code: 1, msg: '服务端未配置 DRAFT_API_KEY，拒绝推送' }, 500);
  const provided = request.headers.get('X-API-Key') || new URL(request.url).searchParams.get('key') || '';
  if (provided !== KEY) return json({ code: 1, msg: '未授权' }, 401);

  const source = normalizeDraftSource(body);
  if (!source) return json({ code: 1, msg: 'markdown 或 content 必填' }, 400);
  if (!source.title) return json({ code: 1, msg: 'title 必填（frontmatter title 或请求体 title）' }, 400);

  const appid = body.appid || env.WECHAT_APPID || '';
  const secret = body.secret || env.WECHAT_APPSECRET || '';
  if (!appid || !secret) {
    return json({ code: 1, msg: '缺少 appid/secret：请求体未带且 Worker 未配置环境变量' }, 400);
  }

  // env.__WX_FETCH 为测试注入口：生产环境恒为 undefined，走 globalThis.fetch
  const wx = new WeChat(appid, secret, env.__WX_FETCH || globalThis.fetch);
  try {
    const finalContent = await wx.localizeImages(source.content);
    const coverResult = await wx.resolveCover(body.cover, finalContent);
    const media_id = await wx.addDraft({
      title: source.title,
      author: body.author || '',
      digest: source.digest,
      content: finalContent,
      thumb_media_id: coverResult.media_id,
      content_source_url: body.content_source_url || '',
      need_open_comment: body.need_open_comment ? 1 : 0,
      only_fans_can_comment: body.only_fans_can_comment ? 1 : 0,
    });
    return json({ code: 0, media_id, used_default_cover: coverResult.source === 'default' });
  } catch (e) {
    return json({ code: 1, msg: String(e.message || e) }, 500);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method === 'GET' && url.pathname === '/api/health') {
      return json({ ok: true, service: 'md2wx-worker' });
    }

    if (request.method === 'GET' && url.pathname === '/api/themes') {
      return json({ code: 0, themes: listThemes() });
    }

    if (request.method === 'POST' && url.pathname === '/api/convert') {
      const limited = await enforceConvertRateLimit(request, env);
      if (limited) return limited;
      let body;
      try { body = await request.json(); } catch { return json({ code: 1, msg: 'invalid json' }, 400); }
      return handleConvert(body);
    }

    if (request.method === 'POST' && url.pathname === '/api/draft') {
      let body;
      try { body = await request.json(); } catch { return json({ code: 1, msg: 'invalid json' }, 400); }
      return handleDraft(request, body, env);
    }

    // ============================== 作品 Hub ==============================
    const hubLogin = url.pathname === '/api/hub/login';
    const hubFiles = url.pathname.match(/^\/api\/hub\/projects\/([^/]+)\/([^/]+)\/files(?:\/(.+))?$/);
    const hubProj = url.pathname.match(/^\/api\/hub\/projects\/([^/]+)\/([^/]+)$/);

    if (request.method === 'POST' && hubLogin) {
      const limited = await enforceHubLoginRateLimit(request, env);
      if (limited) return json({ code: 1, msg: '密码错误或请求过于频繁' }, 401);
      const password = env.HUB_ADMIN_PASSWORD || '';
      if (!password) return json({ code: 1, msg: '服务端未配置 HUB_ADMIN_PASSWORD' }, 500);
      let body;
      try { body = await request.json(); } catch { return json({ code: 1, msg: 'invalid json' }, 400); }
      if (body.password !== password) return json({ code: 1, msg: '密码错误或请求过于频繁' }, 401);
      return json({ code: 0, token: await signToken(password) });
    }

    if (request.method === 'GET' && url.pathname === '/api/hub/projects') {
      const cached = await getListCache(url.origin);
      if (cached) return cached;
      const categories = await listProjects(env);
      const resp = json({ code: 0, categories });
      await putListCache(url.origin, resp.clone());
      return resp;
    }

    if (hubFiles || hubProj) {
      const cat = decodeURIComponent((hubFiles || hubProj)[1]);
      const proj = decodeURIComponent((hubFiles || hubProj)[2]);
      if (!validSegment(cat, CAT_MAX) || !validSegment(proj, PROJ_MAX)) {
        return json({ code: 1, msg: '分类或项目名非法' }, 400);
      }
      const filePath = hubFiles && hubFiles[3] ? decodeURIComponent(hubFiles[3]) : null;
      if (hubFiles && hubFiles[3] !== undefined && (filePath === null || !validFilePath(filePath))) {
        return json({ code: 1, msg: '文件路径非法' }, 400);
      }

      if (request.method === 'GET' && hubFiles) {
        return json({ code: 0, files: await listFiles(env, cat, proj) });
      }

      const authFail = await requireHubAuth(request, env);
      if (authFail) return authFail;

      if (request.method === 'PUT' && hubFiles) {
        if (filePath === null) return json({ code: 1, msg: '文件路径非法' }, 400);
        const len = Number(request.headers.get('content-length') || 0);
        if (len > 95 * 1024 * 1024) return json({ code: 1, msg: '单文件上限 95MB' }, 413);
        await putFile(env, cat, proj, filePath, await request.arrayBuffer());
        await clearListCache(url.origin);
        return json({ code: 0 });
      }

      if (request.method === 'DELETE' && hubFiles) {
        if (filePath === null) return json({ code: 1, msg: '文件路径非法' }, 400);
        const ok = await deleteFile(env, cat, proj, filePath);
        if (!ok) return json({ code: 1, msg: '文件不存在' }, 404);
        await clearListCache(url.origin);
        return json({ code: 0 });
      }

      if (request.method === 'DELETE' && hubProj) {
        const deleted = await deleteProject(env, cat, proj);
        await clearListCache(url.origin);
        return json({ code: 0, deleted });
      }
    }

    if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname.startsWith('/hub/')) {
      return serveHubPreview(request, url, env);
    }

    return json({ code: 1, msg: 'not found' }, 404);
  },
};
