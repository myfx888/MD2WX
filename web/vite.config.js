import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    port: 3000,
    open: false,
    host: true,
    // 本地开发：/api 与 /hub(预览回源) 转发到 wrangler dev (cloudflare/md2wx-worker, 默认 8787 端口)
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/hub': 'http://127.0.0.1:8787'
    },
    // 允许开发期导入 web/ 目录之外的 md2wx/themes/*.json (主题单一数据源)
    fs: {
      allow: [fileURLToPath(new URL('..', import.meta.url))]
    }
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        hub: fileURLToPath(new URL('./hub.html', import.meta.url))
      }
    }
  }
});
