/**
 * EdgeOne Pages 边缘函数入口（仅 EdgeOne 部署使用；Cloudflare 走 wrangler + worker.js 原入口）。
 *
 * 平台差异处理：
 *   - 调用形态双兼容：EdgeOne Pages Functions 以 onRequest(context) 调用（context 含
 *     request/env/params/waitUntil），Web Workers 以 fetch(request, env, ctx) 调用，
 *     按首参特征自动识别；
 *   - env.HUB 若为 EdgeOne KV 命名空间（控制台绑定变量名 HUB），由 edgeone-kv.js 适配成
 *     hub-store 依赖的 R2 接口；绑定缺失或形态不同则原样透传；
 *   - CONVERT_RATE_LIMITER / HUB_LOGIN_LIMITER 在 EdgeOne 无对应绑定，worker 内已有
 *     缺绑定直通兜底（限流在 EdgeOne 上不生效，见 edgeone/README.md）。
 *
 * 本文件不直接运行：由 MD2WX/scripts/edgeone-build.mjs 用 esbuild 打包为单文件
 * edge-functions/[[default]].js（worker.js 里的 PNG import 会转成 data URI —— EdgeOne
 * 平台不支持构建期资源 import）。
 */
import worker from '../worker.js';
import { wrapHubBinding } from '../edgeone-kv.js';

function normalizeArgs(a, b, c) {
  // Pages Functions: onRequest({ request, env, params, waitUntil })
  if (a && typeof a === 'object' && a.request instanceof Request) {
    return { request: a.request, env: a.env || {}, ctx: a };
  }
  // Web Workers: fetch(request, env, ctx)
  return { request: a, env: b || {}, ctx: c || {} };
}

async function entry(a, b, c) {
  const { request, env, ctx } = normalizeArgs(a, b, c);
  // KV 绑定优先走 env.HUB（控制台绑定变量名 HUB）；EdgeOne 官方示例也存在以
  // 全局变量形式注入的写法，globalThis.HUB 作兜底（Cloudflare 上该全局不存在，无副作用）
  const shimmedEnv = { ...env, HUB: wrapHubBinding(env.HUB || globalThis.HUB) };
  return worker.fetch(request, shimmedEnv, ctx);
}

export default entry;
export const onRequest = entry;
