import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * The lab (lab.html, src/lab, public/lab) and the streaming test page (stream.html) are dev tools:
 * `npm run dev` serves them at /lab.html and /stream.html, and `LAB=1` / `STREAM=1 vite build` bundle
 * them, but a normal build ships neither the pages nor the multi-megabyte voxel files in public/lab.
 * public/stream (the Tokyo chunk archive) is the map of the app itself, so it always ships; it is
 * only fetched, with range requests, when a visitor enters cubeworld. It is generated, not committed:
 * `npm run map` builds it, and a production build refuses to run without it.
 */
const withLab = process.env.LAB === '1';
const withStream = process.env.STREAM === '1';

function dropLabData(): Plugin {
  let outDir = 'dist';
  return {
    name: 'drop-lab-data',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      if (!withLab) rmSync(resolve(outDir, 'lab'), { recursive: true, force: true });
    },
  };
}

function requireMap(): Plugin {
  return {
    name: 'require-map',
    apply: 'build',
    buildStart() {
      if (!existsSync(resolve('public/stream/manifest.json'))) {
        this.error('public/stream/ is missing: run `npm run map` first (builds the Tokyo map from PLATEAU, see README).');
      }
    },
  };
}

export default defineConfig({
  plugins: [requireMap(), dropLabData()],
  // module workers (new Worker(new URL(...), { type: 'module' })) bundle as ES modules, sharing chunks with the page
  worker: { format: 'es' },
  // The pipeline cache holds a Python venv and ~50 GB of CityGML; watching it reloads pages for nothing.
  server: { watch: { ignored: ['**/pipeline/cache/**', '**/art/**', '**/research/**'] } },
  build: {
    rollupOptions: {
      input: {
        main: resolve('index.html'),
        ...(withLab ? { lab: resolve('lab.html') } : {}),
        ...(withStream ? { stream: resolve('stream.html') } : {}),
      },
    },
  },
});
