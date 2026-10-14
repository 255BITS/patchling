/**
 * Cloudflare Pages serves landing/ as-is (no build step, see docs/deploy.md).
 * These are the deploy assumptions CI can verify from the repo alone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const landing = join(root, 'landing');

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

test('no wrangler config overrides the Pages dashboard settings', () => {
  for (const name of ['wrangler.toml', 'wrangler.json', 'wrangler.jsonc']) {
    assert.ok(!existsSync(join(root, name)), `${name} would change how Pages builds`);
  }
});

test('landing/index.html is the Pages entry point', () => {
  assert.ok(existsSync(join(landing, 'index.html')));
});

test('docs/deploy.md pins production branch main and output dir landing', () => {
  const doc = readFileSync(join(root, 'docs', 'deploy.md'), 'utf8');
  assert.match(doc, /Production branch \| `main`/);
  assert.match(doc, /Build output directory \| `landing`/);
});

test('every relative import under landing/ resolves inside landing/', () => {
  const importRe = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)['"](\.{1,2}\/[^'"]+)['"]/g;
  const problems = [];
  for (const file of walk(landing).filter((f) => /\.(js|mjs|html)$/.test(f))) {
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(importRe)) {
      const target = resolve(dirname(file), m[1]);
      const rel = relative(landing, target);
      if (rel.startsWith('..') || rel.split(sep)[0] === '..') problems.push(`${relative(root, file)} -> ${m[1]} escapes landing/`);
      else if (!existsSync(target)) problems.push(`${relative(root, file)} -> ${m[1]} is missing`);
    }
  }
  assert.deepEqual(problems, []);
});
