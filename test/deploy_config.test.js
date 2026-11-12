/**
 * Cloudflare Pages runs scripts/build-site.sh and serves dist/: landing/ at /,
 * patchling-py docs at /py/, this repo's docs at /js/ (see docs/deploy.md).
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

test('docs/deploy.md pins production branch main and output dir dist', () => {
  const doc = readFileSync(join(root, 'docs', 'deploy.md'), 'utf8');
  assert.match(doc, /Production branch \| `main`/);
  assert.match(doc, /Build output directory \| `dist`/);
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

test('landing links the in-site docs, and /py/ and /js/ are left to the build', () => {
  const html = readFileSync(join(landing, 'index.html'), 'utf8');
  assert.match(html, /href="\/py\/"/);
  assert.match(html, /href="\/js\/"/);
  assert.doesNotMatch(html, /255bits\.github\.io\/patchling-py/);
  for (const dir of ['py', 'js', 'docs']) {
    assert.ok(!existsSync(join(landing, dir)), `landing/${dir} would collide with the build output`);
  }
});

test('/docs/ redirects to /py/ and the build script wires everything up', () => {
  const redirects = readFileSync(join(root, 'scripts', 'site', '_redirects'), 'utf8');
  assert.match(redirects, /^\/docs\/\* \/py\/:splat 301$/m);
  assert.match(redirects, /^\/docs \/py\/ 301$/m);
  const sh = readFileSync(join(root, 'scripts', 'build-site.sh'), 'utf8');
  assert.match(sh, /https:\/\/github\.com\/255BITS\/patchling-py\.git/);
  assert.match(sh, /-d "\$out\/py"/);
  assert.match(sh, /-d "\$out\/js"/);
});

test('every site build records both repos\' commit SHAs', () => {
  const sh = readFileSync(join(root, 'scripts', 'build-site.sh'), 'utf8');
  assert.match(sh, /PATCHLING_PY_REF:-main/);
  assert.match(sh, /\$out\/build-info\.json/);
  assert.match(sh, /"patchling":.*"commit": "\$self_sha"/);
  assert.match(sh, /"patchling_py":.*"commit": "\$py_sha"/);
  assert.match(sh, /echo "patchling-py commit: \$py_sha/);
});

test('site build tooling stays out of the npm package', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.files, ['src']);
  assert.equal(pkg.dependencies, undefined);
});
