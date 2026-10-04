/** Hub API 客户端：token 存 localStorage，401 自动清除并抛 {status:401} */
const TOKEN_KEY = 'hub_token';

export const getToken = () => localStorage.getItem(TOKEN_KEY) || '';
export const setToken = (t) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401) { clearToken(); throw { status: 401, msg: '未授权' }; }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.code !== 0) throw { status: res.status, msg: data.msg || '请求失败' };
  return data;
}

const seg = encodeURIComponent;
const fileSeg = (p) => p.split('/').map(seg).join('/');

export const hubApi = {
  login: async (password) => {
    const res = await fetch('/api/hub/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.code !== 0) throw { status: res.status, msg: data.msg || '登录失败' };
    return data.token;
  },
  listProjects: () => api('/api/hub/projects'),
  listFiles: (cat, proj) => api(`/api/hub/projects/${seg(cat)}/${seg(proj)}/files`),
  putFile: (cat, proj, path, body) =>
    api(`/api/hub/projects/${seg(cat)}/${seg(proj)}/files/${fileSeg(path)}`, { method: 'PUT', body }),
  deleteFile: (cat, proj, path) =>
    api(`/api/hub/projects/${seg(cat)}/${seg(proj)}/files/${fileSeg(path)}`, { method: 'DELETE' }),
  deleteProject: (cat, proj) =>
    api(`/api/hub/projects/${seg(cat)}/${seg(proj)}`, { method: 'DELETE' }),
};
