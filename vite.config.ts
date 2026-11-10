import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

/** All files under `dir`, as forward-slash paths relative to it. */
function listFiles(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? listFiles(`${dir}/${entry.name}`, `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]
  );
}

/**
 * Writes dist/sw.js from src/sw.js with the list of built files to precache and a
 * content hash as cache version. No manual version bump is needed between deploys.
 */
function serviceWorker(): Plugin {
  return {
    name: 'horse-service-worker',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const hash = createHash('sha256');
      const files: string[] = [];
      for (const [fileName, item] of Object.entries(bundle).sort(([a], [b]) => a.localeCompare(b))) {
        files.push(fileName);
        hash.update(fileName).update(item.type === 'chunk' ? item.code : item.source);
      }
      for (const fileName of listFiles('public').sort()) {
        files.push(fileName);
        hash.update(fileName).update(readFileSync(`public/${fileName}`));
      }
      const precache = ['./', ...files.map((f) => `./${f}`)];
      const source = readFileSync('src/sw.js', 'utf8')
        .replace('__SW_VERSION__', hash.digest('hex').slice(0, 12))
        .replace('__SW_PRECACHE__', JSON.stringify(precache));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  // Relative base: works at a domain root and under a GitHub Pages sub-path (/<repo>/).
  base: './',
  define: {
    // Shown in the overlay so the owner can tell which deploy the iPad is running.
    __BUILD__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ') + 'Z'),
  },
  // Three.js alone is ~550 kB minified (~150 kB gzip); raise the warning limit accordingly.
  build: { target: 'es2022', sourcemap: false, chunkSizeWarningLimit: 900 },
  server: { host: true },
  plugins: [serviceWorker()],
});
