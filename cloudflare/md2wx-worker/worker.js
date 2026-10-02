/**
 * MD2WX 一体化 Worker：整站静态托管（Workers Assets）+ Markdown 转换 API + 微信草稿箱推送
 *
 * 路由（本任务先实现 /api/health，其余路由由后续任务追加）：
 *   GET  /api/health   健康检查
 *   GET  /api/themes   枚举内置主题
 *   POST /api/convert  公开转换（markdown -> 微信内联 HTML）
 *   POST /api/draft    草稿推送（X-API-Key 或 ?key= 鉴权）
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

  async resolveCover(cover, content) {
    if (cover) {
      let blob = null;
      if (cover.startsWith('data:')) blob = dataUriToBlob(cover);
      else if (/^https?:\/\//.test(cover)) blob = await this.urlToBlob(cover);
      if (blob) return await this.uploadMaterial(blob);
    }
    const m = /<img\s+[^>]*?src="([^"]+)"[^>]*?>/i.exec(content);
    if (m) {
      const src = m[1];
      let blob = null;
      if (src.startsWith('data:')) blob = dataUriToBlob(src);
      else if (/^https?:\/\//.test(src)) blob = await this.urlToBlob(src);
      if (blob) return await this.uploadMaterial(blob);
    }
    return null;
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
    const thumb_media_id = await wx.resolveCover(body.cover, finalContent);
    if (!thumb_media_id) return json({ code: 1, msg: '缺少封面图（cover 或正文第一张图都不存在）' }, 400);
    const media_id = await wx.addDraft({
      title: source.title,
      author: body.author || '',
      digest: source.digest,
      content: finalContent,
      thumb_media_id,
      content_source_url: body.content_source_url || '',
      need_open_comment: body.need_open_comment ? 1 : 0,
      only_fans_can_comment: body.only_fans_can_comment ? 1 : 0,
    });
    return json({ code: 0, media_id });
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

    return json({ code: 1, msg: 'not found' }, 404);
  },
};
