import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inside, realPath } from '../scripts/sandbox-lib.mjs';

let root: string;
afterEach(() => rmSync(root, { recursive: true, force: true }));

function setup() {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'tg-sandbox-test-')));
  const vault = join(root, 'sandbox');
  const outside = join(root, 'real vault');
  mkdirSync(join(vault, 'Notes'), { recursive: true });
  mkdirSync(outside);
  return { vault, outside };
}

describe.skipIf(process.platform === 'win32')('sandbox write guard', () => {
  it('allows ordinary paths inside the sandbox, existing or not', () => {
    const { vault } = setup();
    expect(inside(vault, 'Notes/new.md')).toBe(join(vault, 'Notes', 'new.md'));
    expect(inside(vault, 'New folder/deeper/x.md')).toBe(join(vault, 'New folder', 'deeper', 'x.md'));
    expect(() => inside(vault, '../real vault/x.md')).toThrow(/outside the sandbox/);
  });

  it('refuses a linked folder that leads out', () => {
    const { vault, outside } = setup();
    symlinkSync(outside, join(vault, 'Linked'));
    expect(() => inside(vault, 'Linked/x.md')).toThrow(/outside the sandbox/);
  });

  it('refuses a dangling link whose target is outside, before anything is written (Gitar on #24)', () => {
    const { vault, outside } = setup();
    const target = join(outside, 'not yet.md');
    symlinkSync(target, join(vault, 'Notes', 'x.md'));
    expect(realPath(join(vault, 'Notes', 'x.md'))).toBe(target);
    expect(() => inside(vault, 'Notes/x.md')).toThrow(/outside the sandbox/);
    // A dangling link that stays inside is fine.
    symlinkSync(join(vault, 'Notes', 'later.md'), join(vault, 'Notes', 'y.md'));
    expect(inside(vault, 'Notes/y.md')).toBe(join(vault, 'Notes', 'y.md'));
    writeFileSync(join(vault, 'Notes', 'later.md'), 'ok');
  });
});
