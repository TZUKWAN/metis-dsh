import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const REPO = path.resolve(__dirname, '..', '..');

export default defineConfig({
  base: './',
  root: REPO,
  build: {
    outDir: path.join(REPO, 'test-results', 'kimi-visual-site'),
    emptyOutDir: true,
    sourcemap: 'inline',
    rollupOptions: {
      input: path.resolve(__dirname, 'index.html'),
    },
  },
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  plugins: [react()],
});
