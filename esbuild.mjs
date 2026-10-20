// Bundles the main process and the preload. The renderer is built by the Angular CLI.
import { build, context } from 'esbuild';

const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  logLevel: 'info',
  external: ['electron', 'ssh2'],
};
const configs = [
  { ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main/main.js' },
  // Sandboxed preloads may only require('electron'), so everything else is bundled in.
  { ...common, entryPoints: ['src/preload/preload.ts'], outfile: 'dist/preload/preload.js', external: ['electron'] },
];

if (process.argv.includes('--watch')) {
  for (const c of configs) await (await context(c)).watch();
} else {
  await Promise.all(configs.map((c) => build(c)));
}
