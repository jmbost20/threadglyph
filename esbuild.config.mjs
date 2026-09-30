import { builtinModules } from 'node:module';
import esbuild from 'esbuild';

const production = process.argv[2] === 'production';

const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  // Provided by Obsidian at runtime; bundling a second copy of CodeMirror breaks editor extensions.
  external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*', ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
  format: 'cjs',
  target: 'es2022',
  logLevel: 'info',
  sourcemap: production ? false : 'inline',
  treeShaking: true,
  outfile: 'main.js',
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
