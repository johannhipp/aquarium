import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * The lab (lab.html, src/lab, public/lab) and the streaming prototype (stream.html, src/cubeworld/stream,
 * public/stream) are dev tools: `npm run dev` serves them at /lab.html and /stream.html, and
 * `LAB=1 vite build` / `STREAM=1 vite build` bundle them, but a normal build ships neither the pages nor the
 * multi-megabyte voxel data that lives in public/lab and public/stream.
 */
const withLab = process.env.LAB === '1';
const withStream = process.env.STREAM === '1';

function dropDevData(): Plugin {
  let outDir = 'dist';
  return {
    name: 'drop-dev-data',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      if (!withLab) rmSync(resolve(outDir, 'lab'), { recursive: true, force: true });
      if (!withStream) rmSync(resolve(outDir, 'stream'), { recursive: true, force: true });
    },
  };
}

export default defineConfig({
  plugins: [dropDevData()],
  // module workers (new Worker(new URL(...), { type: 'module' })) bundle as ES modules, sharing chunks with the page
  worker: { format: 'es' },
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
