/**
 * patchling.app is deployed from landing/ alone, so the filter the page
 * imports has to live there. These copies must stay identical to src/.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const FILES = ['filter.js', 'text.js', 'llm.js', 'env.js'];

for (const name of FILES) {
  test(`landing/lib/${name} matches src/${name}`, () => {
    const src = readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');
    const copy = readFileSync(new URL(`../landing/lib/${name}`, import.meta.url), 'utf8');
    assert.equal(copy, src);
  });
}
