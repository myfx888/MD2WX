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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method === 'GET' && url.pathname === '/api/health') {
      return json({ ok: true, service: 'md2wx-worker' });
    }

    return json({ code: 1, msg: 'not found' }, 404);
  },
};
