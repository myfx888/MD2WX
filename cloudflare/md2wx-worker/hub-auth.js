/**
 * 作品 Hub 会话鉴权：单管理员密码 → HMAC 签名 token（无用户名、无服务端会话）。
 * token = base64url(payload{exp}) + '.' + base64url(HMAC-SHA256(payload, key))
 * key = SHA-256(密码 + ':hub-session')；校验用 crypto.subtle.verify（常数时间比较）。
 */
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const enc = new TextEncoder();

async function hmacKey(password) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(password + ':hub-session'));
  return crypto.subtle.importKey('raw', digest, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

const b64url = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const b64urlDecode = (s) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

export async function signToken(password, now = Date.now()) {
  const payload = b64url(enc.encode(JSON.stringify({ exp: now + SESSION_TTL_MS })));
  const sig = b64url(await crypto.subtle.sign('HMAC', await hmacKey(password), enc.encode(payload)));
  return payload + '.' + sig;
}

export async function verifyToken(token, password, now = Date.now()) {
  if (typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot < 0) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let sigBuf;
  try { sigBuf = b64urlDecode(sig); } catch { return false; }
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', await hmacKey(password), sigBuf, enc.encode(payload));
  } catch { return false; }
  if (!ok) return false;
  try {
    const { exp } = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)));
    return Number.isFinite(exp) && now < exp;
  } catch { return false; }
}
