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

    return json({ code: 1, msg: 'not found' }, 404);
  },
};
