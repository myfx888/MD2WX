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

/* ---------- 预览工作台 ---------- */
const vp = { mode: 'fit', w: 0, h: 0, zoom: 100 };

function encSeg(s) { return encodeURIComponent(s); }

function applyViewport() {
  const stage = $('wb-stage');
  if (vp.mode === 'fit') {
    stage.style.width = '100%'; stage.style.height = '100%';
    stage.style.transform = 'none';
    return;
  }
  const wrap = $('wb-stage-wrap');
  const availW = wrap.clientWidth - 32, availH = wrap.clientHeight - 32;
  const fit = Math.min(availW / vp.w, availH / vp.h, 1);
  const scale = vp.zoom === 100 ? fit : vp.zoom / 100;
  stage.style.width = vp.w + 'px';
  stage.style.height = vp.h + 'px';
  stage.style.transform = `scale(${scale})`;
}

function setViewMode(mode) {
  vp.mode = mode;
  const [w, h] = mode === 'fit' ? [0, 0] : mode.split('x').map(Number);
  vp.w = w; vp.h = h;
  document.querySelectorAll('#wb-views button').forEach((b) =>
    b.classList.toggle('active', b.dataset.vp === mode));
  applyViewport();
}

export function buildFileTree(files) {
  const root = {};
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) node = node[parts[i]] = node[parts[i]] || {};
    node['__f__'] = node['__f__'] || [];
    node['__f__'].push(parts[parts.length - 1]);
  }
  return root;
}

export function renderFileTree(cat, proj, files, current) {
  const tree = buildFileTree(files);
  const htmlOf = (node, base) => {
    const dirs = Object.keys(node).filter((k) => k !== '__f__').sort();
    const filesSorted = (node['__f__'] || []).slice().sort();
    let html = '<ul style="list-style:none;margin:0;padding-left:12px">';
    for (const d of dirs) {
      html += `<details open><summary title="${esc(base + d)}">📁 ${esc(d)}</summary>${htmlOf(node[d], base + d + '/')}</details>`;
    }
    for (const f of filesSorted) {
      const p = base + f;
      const isHtml = f.endsWith('.html');
      html += `<div class="wb-file ${p === current ? 'current' : ''}" data-path="${esc(p)}" ${isHtml ? 'data-open="1"' : ''} title="${esc(p)}">
        <span>📄</span><span style="overflow:hidden;text-overflow:ellipsis">${esc(f)}</span>
        ${state.authed ? `<button class="wb-del" data-del="${esc(p)}" title="删除该文件">删除</button>` : ''}
      </div>`;
    }
    return html + '</ul>';
  };
  const el = $('wb-tree');
  el.innerHTML = htmlOf(tree, '');
  el.querySelectorAll('.wb-file[data-open]').forEach((n) =>
    n.addEventListener('click', (e) => {
      if (e.target.dataset.del) return;
      setFrame(cat, proj, n.dataset.path);
      markCurrent(n.dataset.path);
    }));
  el.querySelectorAll('.wb-del').forEach((b) =>
    b.addEventListener('click', () => window.hub.onDeleteFile(cat, proj, b.dataset.del)));
}

function markCurrent(path) {
  document.querySelectorAll('#wb-tree .wb-file').forEach((n) =>
    n.classList.toggle('current', n.dataset.path === path));
}

function setFrame(cat, proj, path) {
  $('wb-frame').src = `/hub/${encSeg(cat)}/${encSeg(proj)}/${path.split('/').map(encSeg).join('/')}`;
}

export async function openWorkbench(cat, proj) {
  const projData = state.raw.find((c) => c.name === cat)?.projects.find((p) => p.name === proj);
  let files;
  try { files = (await hubApi.listFiles(cat, proj)).files; }
  catch (err) { alert(err.msg || '文件清单加载失败'); return; }
  $('wb-name').textContent = proj;
  $('wb-cat').textContent = cat;
  const entry = projData?.entry || files.map((f) => f.path).find((p) => p.endsWith('.html'));
  $('dlg-workbench').showModal();
  renderFileTree(cat, proj, files, entry);
  setViewMode('fit');
  vp.zoom = 100; $('wb-zoom-range').value = 100; $('wb-zoom-val').textContent = '100%';
  setFrame(cat, proj, entry || files[0]?.path || '');
}

function bindWorkbench() {
  $('wb-close').addEventListener('click', () => $('dlg-workbench').close());
  $('wb-refresh').addEventListener('click', () => { const f = $('wb-frame'); f.src = f.src; });
  $('wb-newtab').addEventListener('click', () => window.open($('wb-frame').src, '_blank'));
  $('wb-views').addEventListener('click', (e) => {
    if (e.target.dataset.vp) setViewMode(e.target.dataset.vp);
  });
  $('wb-zoom-range').addEventListener('input', (e) => {
    vp.zoom = Number(e.target.value);
    $('wb-zoom-val').textContent = vp.zoom + '%';
    applyViewport();
  });
  window.addEventListener('resize', applyViewport);
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
  bindWorkbench();
  window.hub.openWorkbench = openWorkbench;
  window.hub.onCardAction = (act, cat, proj) => {
    if (act === 'preview') openWorkbench(cat, proj);
    if (act === 'edit' || act === 'del') alert('管理功能在下一任务开放');
  };
  refreshProjects().catch(() => {
    $('hub-grid').innerHTML = '<div class="hub-empty">加载失败，请稍后刷新</div>';
  });
}

boot();
