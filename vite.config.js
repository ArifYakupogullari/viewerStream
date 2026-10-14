import { defineConfig } from 'vite';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Two build channels (see .github/workflows/deploy.yml):
//   vite build                     production widget only        -> dist/
//   vite build --mode devchannel   widget + fake StreamBIM host   -> dist/dev/
export default defineConfig(({ mode }) => ({
  // Relative asset paths: GitHub Pages serves this repo under /viewerStream/
  // (and the dev channel under /viewerStream/dev/), not at the domain root.
  base: './',
  build: {
    // public/ only holds gitignored local test scenes (see public/test-scenes/)
    // - never copy them into the deployable widget bundle.
    copyPublicDir: false,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        ...(mode === 'devchannel' ? { host: resolve(__dirname, 'host/index.html') } : {}),
      },
    },
  },
}));
