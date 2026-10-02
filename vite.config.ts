import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * The lab (lab.html, src/lab, public/lab) is a dev tool: `npm run dev` serves it at /lab.html and
 * `LAB=1 vite build` bundles it, but a normal build ships neither the page nor the multi-megabyte
 * voxel files that live in public/lab.
 */
const withLab = process.env.LAB === '1';

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

export default defineConfig({
  plugins: [dropLabData()],
  build: {
    rollupOptions: {
      input: withLab
        ? { main: resolve('index.html'), lab: resolve('lab.html') }
        : { main: resolve('index.html') },
    },
  },
});
