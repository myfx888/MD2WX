/**
 * MD2WX 发布工坊纯逻辑层：提取、payload 组装、推送历史。
 * 零 DOM 依赖（store 可注入），Node 可测。
 */
import { parseFrontmatter } from './parser.js';

export const PUSH_HISTORY_KEY = 'md2wx_push_history';
export const PUSH_HISTORY_MAX = 5;

/**
 * 提取发布元信息，与 renderPreview 的标题回退链一致：
 * frontmatter title/digest -> 正文 H1 -> 首行非空文字
 */
export function extractPublishMeta(markdownText) {
  const text = String(markdownText || '');
  const { meta, body } = parseFrontmatter(text);

  let title = meta.title || '';
  if (!title) {
    const h1 = body.match(/^#\s+(.+)$/m);
    if (h1) {
      title = h1[1].trim();
    } else {
      const firstLine = body.split('\n').map((s) => s.trim()).filter(Boolean)[0];
      title = firstLine ? firstLine.replace(/^[#*_\->\s]+/, '') : '';
    }
  }

  const imgMd = body.match(/!\[[^\]]*\]\(([^)]+)\)/);
  const imgHtml = body.match(/<img\s+[^>]*?src="([^"]+)"/i);
  const coverImageSrc = (imgMd && imgMd[1]) || (imgHtml && imgHtml[1]) || '';

  return { title, digest: meta.digest || '', coverImageSrc };
}

/**
 * 组装 /api/draft 请求体：title/digest 非空即携带（服务端提取是其子集），
 * appId/appSecret 映射为 appid/secret，coverDataUrl 映射为 cover。
 */
export function buildPublishPayload({ markdown, theme, title = '', digest = '', coverDataUrl = '', appId = '', appSecret = '' }) {
  const payload = { markdown, theme };
  if (title && title.trim()) payload.title = title.trim();
  if (digest && digest.trim()) payload.digest = digest.trim();
  if (coverDataUrl) payload.cover = coverDataUrl;
  if (appId && appId.trim()) payload.appid = appId.trim();
  if (appSecret && appSecret.trim()) payload.secret = appSecret.trim();
  return payload;
}

/**
 * 连接状态判定：无 Key 不可推送；端点缺省同源。
 */
export function resolvePushConfig(apiKey, endpoint = '') {
  if (!apiKey || !apiKey.trim()) {
    return { ok: false, endpoint: '/api/draft', reason: '未配置 API Key' };
  }
  return { ok: true, endpoint: (endpoint || '').trim() || '/api/draft', reason: '' };
}

function defaultStore() {
  return typeof localStorage !== 'undefined' ? localStorage : null;
}

function parseHistory(raw) {
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    return [];
  }
}

export function readPushHistory(store = defaultStore()) {
  if (!store) return [];
  return parseHistory(store.getItem(PUSH_HISTORY_KEY));
}

export function recordPush(entry, store = defaultStore()) {
  const next = [entry, ...readPushHistory(store)].slice(0, PUSH_HISTORY_MAX);
  if (store) {
    try {
      store.setItem(PUSH_HISTORY_KEY, JSON.stringify(next));
    } catch (e) {
      // 存储不可用时静默，仅返回内存结果
    }
  }
  return next;
}

export function countWords(text) {
  const s = String(text || '');
  const chineseChars = (s.match(/[\u4e00-\u9fa5]/g) || []).length;
  const englishWords = (s.replace(/[\u4e00-\u9fa5]/g, ' ').match(/\b\w+\b/g) || []).length;
  return chineseChars + englishWords;
}
