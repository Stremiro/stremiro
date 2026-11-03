import path from 'node:path';
import babel from '@rolldown/plugin-babel';
import tailwindcss from '@tailwindcss/vite';
import react, { reactCompilerPreset } from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
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

  // Keep Rust compile errors visible instead of clearing the screen.
  clearScreen: false,
  server: {
    // Tauri expects this fixed dev port; fail rather than fall back.
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
      // Rust sources rebuild through Cargo, not Vite.
      ignored: ['**/src-tauri/**'],
    },
  },
});
