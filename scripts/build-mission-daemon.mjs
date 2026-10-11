import { build } from 'esbuild';

// Standalone Node entry. Electron's main bundle is intentionally not the scheduler owner:
// a separate process can continue maintaining due job records after the UI closes.
await build({
  entryPoints: ['src/daemon/cli.ts'],
  outfile: 'out/mission-daemon.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info'
});
