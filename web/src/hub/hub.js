/** 作品 Hub 前端入口：浏览/搜索/登录 + 预览工作台 + 上传管理 */
import { hubApi, getToken, setToken, clearToken } from './hub-api.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const state = { raw: [], cats: [], cat: '', q: '', authed: !!getToken() };

export function fmtSize(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

export async function refreshProjects() {
  const data = await hubApi.listProjects();
  state.raw = data.categories.filter((c) => c.projects.length);
  state.cats = state.raw.map((c) => c.name);
  if (state.cat && !state.cats.includes(state.cat)) state.cat = '';
  renderCats(); renderGrid();
}

export function renderCats() {
  const nav = $('hub-cats');
  const chips = ['全部分类', ...state.cats];
  nav.innerHTML = chips.map((c) =>
    `<button class="hub-cat-chip ${state.cat === (c === '全部分类' ? '' : c) ? 'active' : ''}" data-cat="${esc(c === '全部分类' ? '' : c)}">${esc(c)}</button>`
  ).join('');
  nav.querySelectorAll('.hub-cat-chip').forEach((b) =>
    b.addEventListener('click', () => { state.cat = b.dataset.cat; renderCats(); renderGrid(); }));
}

export function renderGrid() {
  const grid = $('hub-grid');
  const q = state.q.trim().toLowerCase();
  const items = state.raw
    .filter((c) => !state.cat || c.name === state.cat)
    .flatMap((c) => c.projects.map((p) => ({ cat: c.name, ...p })))
    .filter((p) => !q || p.name.toLowerCase().includes(q) || p.cat.toLowerCase().includes(q));
  if (!items.length) {
    grid.innerHTML = `<div class="hub-empty">${state.authed ? '还没有作品，点右上角「上传作品」开始' : '暂无作品'}</div>`;
    return;
  }
  grid.innerHTML = items.map((p) => `
    <article class="hub-card">
      <div class="hub-card-name">${esc(p.name)}</div>
      <div class="hub-card-cat">${esc(p.cat)}</div>
      <div class="hub-card-meta">${p.fileCount} 个文件 · ${fmtSize(p.totalSize)} · ${new Date(p.updatedAt).toLocaleDateString()}</div>
      <div class="hub-card-actions">
        <button class="hub-btn primary" data-act="preview" data-cat="${esc(p.cat)}" data-proj="${esc(p.name)}">预览</button>
        ${state.authed ? `
          <button class="hub-btn" data-act="edit" data-cat="${esc(p.cat)}" data-proj="${esc(p.name)}">编辑</button>
          <button class="hub-btn danger" data-act="del" data-cat="${esc(p.cat)}" data-proj="${esc(p.name)}">删除</button>` : ''}
      </div>
    </article>`).join('');
  grid.querySelectorAll('button[data-act]').forEach((b) =>
    b.addEventListener('click', () => window.hub.onCardAction(b.dataset.act, b.dataset.cat, b.dataset.proj)));
}

/* ---------- 登录 ---------- */
function bindLogin() {
  const dlg = $('dlg-login');
  $('btn-hub-auth').addEventListener('click', () => {
    if (state.authed) {
      clearToken(); state.authed = false;
      $('btn-hub-auth').textContent = '登录管理';
      $('btn-hub-upload').classList.add('hidden');
      renderGrid();
      return;
    }
    $('login-error').classList.add('hidden');
    $('login-password').value = '';
    dlg.showModal();
  });
  $('btn-login-cancel').addEventListener('click', () => dlg.close());
  $('form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const token = await hubApi.login($('login-password').value);
      setToken(token); state.authed = true; dlg.close();
      $('btn-hub-auth').textContent = '退出登录';
      $('btn-hub-upload').classList.remove('hidden');
      refreshProjects();
    } catch (err) {
      const el = $('login-error');
      el.textContent = err.msg || '登录失败';
      el.classList.remove('hidden');
    }
  });
}

function boot() {
  window.hub = window.hub || {};
  $('hub-search').addEventListener('input', (e) => { state.q = e.target.value; renderGrid(); });
  bindLogin();
  // 登录态按钮初始文案
  if (state.authed) {
    $('btn-hub-auth').textContent = '退出登录';
    $('btn-hub-upload').classList.remove('hidden');
  }
  // Task 6/7 在此追加：bindUpload() / bindWorkbench 快捷键
  refreshProjects().catch(() => {
    $('hub-grid').innerHTML = '<div class="hub-empty">加载失败，请稍后刷新</div>';
  });
}

boot();
