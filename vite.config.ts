import path from 'node:path';
import babel from '@rolldown/plugin-babel';
import tailwindcss from '@tailwindcss/vite';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] }), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },

  build: {
    // WebView2-only runtime: evergreen Chromium, no legacy-browser transpile.
    target: 'esnext',
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'vendor-react',
              test: /[\\/]node_modules[\\/](?:react(?:-dom|-router)?|scheduler)[\\/]/,
              tags: ['$initial' as const],
            },
            {
              name: 'vendor-initial',
              test: /[\\/]node_modules[\\/]/,
              tags: ['$initial' as const],
            },
          ],
        },
      },
    },
  },

  // Vite options tailored for Tauri development
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1430,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: 'ws',
          host,
          port: 1431,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ['**/src-tauri/**'],
    },
  },
}));
