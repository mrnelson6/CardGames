import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import fs from 'node:fs';
import path from 'node:path';

// GitHub Pages serves `404.html` for any URL that doesn't map to a real
// file. We're a single-page app with client-side routing, so we copy the
// built index.html to 404.html — every "unknown path" loads the SPA, which
// then reads window.location.pathname and renders the right route.
function ghPagesSpa404(): Plugin {
  return {
    name: 'gh-pages-spa-404',
    apply: 'build',
    closeBundle() {
      const src = path.resolve(__dirname, 'dist/index.html');
      const dst = path.resolve(__dirname, 'dist/404.html');
      if (fs.existsSync(src)) fs.copyFileSync(src, dst);
    },
  };
}

export default defineConfig({
  base: '/',
  plugins: [
    react(),
    ghPagesSpa404(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
      },
      manifest: {
        name: 'Card Games',
        short_name: 'CardGames',
        description: 'Play card games online',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        start_url: '/',
        icons: [
          {
            src: '/favicon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
  },
});
