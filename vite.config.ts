import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * Generates dist/sw.js: precaches the app shell (HTML, JS, CSS, icons) and
 * caches everything else (e.g. the ONNX Runtime WebAssembly) on first use,
 * so the app works offline. The depth model weights are cached separately
 * by transformers.js in the browser Cache API.
 */
function serviceWorker(): Plugin {
  let outDir = 'dist';
  return {
    name: 'stereo-service-worker',
    apply: 'build',
    configResolved(c) { outDir = c.build.outDir; },
    closeBundle() {
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const f of readdirSync(dir)) {
          const p = join(dir, f);
          if (statSync(p).isDirectory()) walk(p);
          else files.push(relative(outDir, p).split('\\').join('/'));
        }
      };
      walk(outDir);
      const shell = files.filter((f) => !/\.(map|wasm)$/.test(f) && f !== 'sw.js');
      const hash = createHash('sha256');
      for (const f of shell.sort()) hash.update(f).update(readFileSync(join(outDir, f)));
      const version = hash.digest('hex').slice(0, 12);
      const sw = readFileSync('src/sw-template.js', 'utf8')
        .replace('__VERSION__', version)
        .replace('__SHELL__', JSON.stringify(['./', ...shell.filter((f) => f !== 'index.html')]));
      writeFileSync(join(outDir, 'sw.js'), sw);
    },
  };
}

export default defineConfig({
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022', sourcemap: true },
  plugins: [serviceWorker()],
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
} as never);
