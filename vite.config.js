import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { host: true, port: Number(process.env.PORT) || 5173, strictPort: true },
  cacheDir: '.vite-cache',
  build: { chunkSizeWarningLimit: 2000 },
});
