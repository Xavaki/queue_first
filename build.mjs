// Bundles each extension entry point into dist/ and copies static files.
import * as esbuild from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

const watch = process.argv.includes('--watch');

const entries = {
  background: 'src/background/index.ts',
  content: 'src/content/index.ts',
  bridge: 'src/adapters/youtube/bridge.ts',
  popup: 'src/popup/popup.ts',
  options: 'src/options/options.ts',
};

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await cp('src/static', 'dist', { recursive: true });

const ctx = await esbuild.context({
  entryPoints: entries,
  outdir: 'dist',
  bundle: true,
  format: 'iife',
  target: 'firefox128',
  sourcemap: 'inline',
  logLevel: 'info',
});

if (watch) {
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
