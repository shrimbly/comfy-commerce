import { defineConfig, mergeConfig } from 'vitest/config'

import viteConfig from './vite.config'

// Component tests reuse the app's vite config (react + svgr plugins) so test
// files transform exactly like production code; jsdom stands in for the DOM.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
    },
  }),
)
