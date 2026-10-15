#!/usr/bin/env node
/**
 * EdgeOne Pages 构建脚本：静态站点 + 边缘函数一体产物。
 *
 * 产物布局（EdgeOne 约定：函数目录在仓库根，静态输出由 edgeone.json outputDirectory 指定）：
 *   - MD2WX/edge-functions/[[default]].js —— esbuild 单文件打包的边缘函数 catch-all
 *     （EdgeOne 平台不做构建期 bundler 处理，worker.js 的 PNG import 需转 data URI；
 *     URL 映射自动剥掉 edge-functions/ 前缀，[[default]].js 即全站兜底路由）；
 *   - MD2WX/edgeone-dist/ —— web/dist 拷贝的静态资产（剔除 _headers，缓存头由
 *     仓库根 edgeone.json 提供，避免两处同时生效导致 Cache-Control 拼接）。
 *
 * 依赖零新增：esbuild 复用 cloudflare/md2wx-worker 的 devDependency。
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webDir = path.join(repoRoot, 'web');
const workerDir = path.join(repoRoot, 'cloudflare', 'md2wx-worker');
const outDir = path.join(repoRoot, 'edgeone-dist');
const functionsDir = path.join(repoRoot, 'edge-functions');

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });
  if (r.status !== 0) {
    console.error(`edgeone-build 失败: ${cmd} ${args.join(' ')}`);
    process.exit(r.status || 1);
  }
}

// 1) Web Studio 静态构建（vite → web/dist，含 public/_headers）
if (!existsSync(path.join(webDir, 'node_modules'))) run('npm', ['ci'], { cwd: webDir });
run('npm', ['run', 'build'], { cwd: webDir });

// 2) esbuild 复用 md2wx-worker 的 devDependency（缺则补装）
if (!existsSync(path.join(workerDir, 'node_modules', 'esbuild'))) {
  run('npm', ['ci'], { cwd: workerDir });
}
const esbuild = createRequire(path.join(workerDir, 'package.json'))('esbuild');

// 3) 打包边缘函数为单文件 catch-all（[[default]].js 为 EdgeOne 多级动态路由约定）
rmSync(functionsDir, { recursive: true, force: true });
await esbuild.build({
  entryPoints: [path.join(workerDir, 'edgeone', 'entry.js')],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outfile: path.join(functionsDir, '[[default]].js'),
  loader: { '.png': 'dataurl' },
  logLevel: 'info',
});

// 4) 静态资产并入输出目录（剔除 _headers：EdgeOne 缓存头走 edgeone.json）
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
cpSync(path.join(webDir, 'dist'), outDir, {
  recursive: true,
  filter: (src) => !src.endsWith('_headers'),
});

console.log('EdgeOne 产物就绪: edge-functions/[[default]].js + edgeone-dist/（静态资产）');
