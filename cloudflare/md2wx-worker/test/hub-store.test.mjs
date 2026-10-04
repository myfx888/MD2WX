/** hub-store 单元测试：MockR2 顶替 env.HUB，直调源码模块 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  validSegment, validFilePath, r2Key, findEntryHtml,
  listProjects, listFiles, putFile, deleteFile, deleteProject,
} from '../hub-store.js';

/** 最小 R2 内存实现：put/get/delete/list(prefix+delimiter) */
class MockR2 {
  constructor() { this.map = new Map(); }
  async put(key, value) {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value)
      : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
      : new TextEncoder().encode(String(value));
    this.map.set(key, { bytes, size: bytes.byteLength, uploaded: new Date() });
  }
  async get(key) {
    const o = this.map.get(key);
    if (!o) return null;
    return {
      key, size: o.size, uploaded: o.uploaded,
      arrayBuffer: async () => o.bytes.slice().buffer,
      text: async () => new TextDecoder().decode(o.bytes),
    };
  }
  async delete(keys) { for (const k of Array.isArray(keys) ? keys : [keys]) this.map.delete(k); }
  async list({ prefix = '', delimiter } = {}) {
    const objects = []; const delimitedPrefixes = new Set();
    for (const k of [...this.map.keys()].filter((x) => x.startsWith(prefix)).sort()) {
      const rest = k.slice(prefix.length);
      if (delimiter) {
        const i = rest.indexOf(delimiter);
        if (i >= 0) { delimitedPrefixes.add(prefix + rest.slice(0, i + delimiter.length)); continue; }
      }
      const o = this.map.get(k);
      objects.push({ key: k, size: o.size, uploaded: o.uploaded });
    }
    return { objects, delimitedPrefixes: [...delimitedPrefixes], truncated: false };
  }
}

const enc = new TextEncoder();

describe('路径与命名校验', () => {
  it('validSegment：中文/字母/数字/连字符/下划线，限长', () => {
    assert.equal(validSegment('可视化项目', 24), true);
    assert.equal(validSegment('data-screen_2', 24), true);
    assert.equal(validSegment('a/b', 24), false);
    assert.equal(validSegment('..', 24), false);
    assert.equal(validSegment('x'.repeat(25), 24), false);
    assert.equal(validSegment('', 24), false);
    assert.equal(validSegment('有斜杠\\', 24), false);
  });

  it('validFilePath：拒绝 ..、前导/、反斜杠；允许多段与点', () => {
    assert.equal(validFilePath('index.html'), true);
    assert.equal(validFilePath('css/main.css'), true);
    assert.equal(validFilePath('js/a.b.c.js'), true);
    assert.equal(validFilePath('/abs.html'), false);
    assert.equal(validFilePath('a/../b.html'), false);
    assert.equal(validFilePath('a\\b.html'), false);
    assert.equal(validFilePath('x'.repeat(513)), false);
  });

  it('r2Key 拼接', () => {
    assert.equal(r2Key('分类', '项目', 'css/a.css'), '分类/项目/css/a.css');
  });
});

describe('findEntryHtml', () => {
  const P = 'cat/proj/';
  const objs = (keys) => keys.map((key) => ({ key }));
  it('index.html 优先，其次根级字典序第一个 .html，子目录 html 兜底', () => {
    assert.equal(findEntryHtml(objs([P + 'b.html', P + 'index.html', P + 'css/a.css']), P), 'index.html');
    assert.equal(findEntryHtml(objs([P + 'b.html', P + 'a.html']), P), 'a.html');
    assert.equal(findEntryHtml(objs([P + 'sub/index.html']), P), 'sub/index.html');
    assert.equal(findEntryHtml(objs([P + 'readme.md']), P), null);
  });
});

describe('CRUD 与列表推导', () => {
  let env;
  beforeEach(() => { env = { HUB: new MockR2() }; });

  it('putFile 写入后 listProjects 推导出分类→项目树（数量/大小/入口）', async () => {
    await putFile(env, '报告', 'demo', 'index.html', enc.encode('<h1>hi</h1>'));
    await putFile(env, '报告', 'demo', 'css/a.css', enc.encode('body{}'));
    await putFile(env, '大屏', 'board', 'main.html', enc.encode('<p></p>'));
    const cats = await listProjects(env);
    assert.deepEqual(cats.map((c) => c.name), ['大屏', '报告']);
    const demo = cats.find((c) => c.name === '报告').projects[0];
    assert.equal(demo.name, 'demo');
    assert.equal(demo.entry, 'index.html');
    assert.equal(demo.fileCount, 2);
    assert.equal(demo.totalSize, 17);
    assert.ok(demo.updatedAt instanceof Date || typeof demo.updatedAt === 'string');
  });

  it('listFiles 返回相对路径清单', async () => {
    await putFile(env, 'c', 'p', 'index.html', enc.encode('12345'));
    await putFile(env, 'c', 'p', 'js/x.js', enc.encode('6'));
    const files = await listFiles(env, 'c', 'p');
    assert.deepEqual(files.map((f) => f.path).sort(), ['index.html', 'js/x.js']);
    assert.equal(files.find((f) => f.path === 'index.html').size, 5);
  });

  it('deleteFile 删单文件并返回 true，重复删返回 false', async () => {
    await putFile(env, 'c', 'p', 'a.html', enc.encode('x'));
    assert.equal(await deleteFile(env, 'c', 'p', 'a.html'), true);
    assert.equal(await deleteFile(env, 'c', 'p', 'a.html'), false);
  });

  it('deleteProject 清空整个前缀并返回数量', async () => {
    await putFile(env, 'c', 'p', 'index.html', enc.encode('x'));
    await putFile(env, 'c', 'p', 'css/a.css', enc.encode('y'));
    await putFile(env, 'c', 'other', 'index.html', enc.encode('z'));
    assert.equal(await deleteProject(env, 'c', 'p'), 2);
    const cats = await listProjects(env);
    const c = cats.find((x) => x.name === 'c');
    assert.deepEqual(c.projects.map((p) => p.name), ['other']);
  });
});
