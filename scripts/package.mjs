#!/usr/bin/env node
/**
 * Builds a pilot package: the three files Obsidian loads, plus checksums and
 * the commit they came from, in dist/threadglyph-<version>/. Installing it
 * is a separate, manual owner step (see docs/pilot.md); this script never
 * touches any vault.
 *
 *   npm run package
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(repo, 'manifest.json'), 'utf8'));
const out = join(repo, 'dist', `threadglyph-${manifest.version}`);

execFileSync('node', ['esbuild.config.mjs', 'production'], { cwd: repo, stdio: 'inherit' });
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const files = ['main.js', 'manifest.json', 'styles.css'];
const sums = [];
for (const file of files) {
  copyFileSync(join(repo, file), join(out, file));
  sums.push(`${createHash('sha256').update(readFileSync(join(repo, file))).digest('hex')}  ${file}`);
}
writeFileSync(join(out, 'SHA256SUMS'), `${sums.join('\n')}\n`);

const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
const dirty = git('status', '--porcelain', '--', 'src', 'styles.css', 'manifest.json').length > 0;
writeFileSync(
  join(out, 'BUILD.txt'),
  `Threadglyph ${manifest.version}\ncommit ${git('rev-parse', 'HEAD')}${dirty ? ' (with uncommitted changes)' : ''}\nbuilt ${new Date().toISOString()}\n`,
);

console.log(`Pilot package ready: ${out}`);
console.log('Install by copying that folder to <vault>/.obsidian/plugins/threadglyph (see docs/pilot.md).');
