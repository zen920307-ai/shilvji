import { defineConfig } from 'vite';

// GitHub Pages 仓库名：构建时 BASE_PATH=/食旅集/ 或 /shilvji/
const base = process.env.BASE_PATH || '/';

export default defineConfig({
  base,
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/ai-proxy': {
        target: 'https://api.x.ai',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ai-proxy/, ''),
      },
      '/ai-proxy-deepseek': {
        target: 'https://api.deepseek.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ai-proxy-deepseek/, ''),
      },
    },
  },
  preview: {
    host: true,
    port: 5173,
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
  },
});
