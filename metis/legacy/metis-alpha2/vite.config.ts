import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

const nodeEmptyShim = path.resolve(__dirname, './src/shims/node-empty.ts').replace(/\\/g, '/')

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './', // Electron loads from file://, use relative paths
  resolve: {
    alias: [
      { find: '@', replacement: path.resolve(__dirname, './src') },
      { find: '@engine', replacement: path.resolve(__dirname, './engine') },
      // Renderer bundles never run Node code — tool handlers execute in the
      // main process. Redirect Node builtins to empty shims so statically
      // imported engine modules evaluate safely in the browser context.
      { find: /^node:.*$/, replacement: nodeEmptyShim },
      { find: /^bindings$/, replacement: nodeEmptyShim },
      { find: /^better-sqlite3$/, replacement: nodeEmptyShim },
    ],
  },
  define: {
    // Node globals referenced at module top level by bundled engine code.
    'process.cwd': '(() => "/")',
    'process.platform': '"browser"',
    'process.arch': '"x64"',
    'process.versions': '({})',
  },
  build: {
    target: 'es2023',
    outDir: 'dist',
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/') || id.includes('node_modules/react-router-dom/')) {
            return 'vendor-react';
          }
          if (id.includes('node_modules/react-markdown/') || id.includes('node_modules/remark-gfm/')) {
            return 'vendor-markdown';
          }
          if (id.includes('node_modules/recharts/')) {
            return 'vendor-charts';
          }
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
})
