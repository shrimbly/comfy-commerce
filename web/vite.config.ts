import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import svgr from 'vite-plugin-svgr'

/**
 * Preload the hashed Geist latin woff2 in the built index.html. Without it the
 * font request can't start until the bundle executes and the first Geist text
 * renders, so the fallback→Geist swap (a full-document reflow) lands mid
 * entrance animation. The @font-face itself (font-display: swap) is untouched
 * — the font simply arrives before first paint. Build-only: the dev server
 * has no hashed bundle to resolve against.
 */
function preloadGeistFont(): Plugin {
  return {
    name: 'preload-geist-font',
    transformIndexHtml: {
      order: 'post',
      handler(_html, ctx) {
        const file = Object.keys(ctx.bundle ?? {}).find(
          (name) => name.includes('geist-latin-wght-normal') && name.endsWith('.woff2'),
        )
        if (!file) return
        return [
          {
            tag: 'link',
            // Font preloads require crossorigin even same-origin.
            attrs: { rel: 'preload', as: 'font', type: 'font/woff2', crossorigin: true, href: `/${file}` },
            injectTo: 'head',
          },
        ]
      },
    },
  }
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    preloadGeistFont(),
    // `import Icon from './foo.svg?react'` → a React component. dimensions:false
    // lets the icon wrapper control width/height; viewBox is kept for scaling.
    svgr({
      svgrOptions: {
        dimensions: false,
        svgoConfig: {
          plugins: [{ name: 'preset-default', params: { overrides: { removeViewBox: false } } }],
        },
      },
    }),
  ],
  server: {
    // The root `pnpm dev` sets WEB_PORT so the broker can print the exact dev
    // URL; strictPort then guarantees Vite actually uses it (no silent shift to
    // 5174/5176…). Standalone `vite` keeps the default with auto-increment.
    port: Number(process.env.WEB_PORT) || 5173,
    strictPort: Boolean(process.env.WEB_PORT),
    proxy: {
      // Broker API + broker-hosted images (mock CDN, edited assets) — keeps
      // media URLs root-relative so <img src> works without CORS ceremony.
      '/api': 'http://localhost:4000',
      '/mock-cdn': 'http://localhost:4000',
    },
  },
})
