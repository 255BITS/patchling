import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_MODEL } from '../src/index.js';
import { DEFAULT_MODEL as LANDING_DEFAULT_MODEL } from '../landing/lib/env.js';

const RETIRED = 'xiaomi/mimo-v2.5-pro-ultraspeed'; // NanoGPT returns HTTP 410
const catalog = JSON.parse(readFileSync(new URL('./fixtures/demo-models.json', import.meta.url), 'utf8'));

test('DEFAULT_MODEL is deepseek/deepseek-v4.1-flash-1017', () => {
  assert.equal(DEFAULT_MODEL, 'deepseek/deepseek-v4.1-flash-1017');
  assert.equal(LANDING_DEFAULT_MODEL, DEFAULT_MODEL);
});

test('retired xiaomi/mimo-v2.5-pro-ultraspeed is not the default', () => {
  assert.notEqual(DEFAULT_MODEL, RETIRED);
  assert.notEqual(LANDING_DEFAULT_MODEL, RETIRED);
});

test('DEFAULT_MODEL is in the verified NanoGPT catalog fixture and cheap', () => {
  const m = catalog.text[DEFAULT_MODEL];
  assert.ok(m, `${DEFAULT_MODEL} missing from test/fixtures/demo-models.json`);
  assert.ok(m.pricing.prompt <= 0.5 && m.pricing.completion <= 1, 'default should stay cheap');
});

test('src/env.d.ts declares the new default literal', () => {
  const dts = readFileSync(new URL('../src/env.d.ts', import.meta.url), 'utf8');
  assert.match(dts, /DEFAULT_MODEL: "deepseek\/deepseek-v4\.1-flash-1017";/);
  assert.ok(!dts.includes(RETIRED));
});
